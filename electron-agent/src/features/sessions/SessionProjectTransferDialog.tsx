import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Input, Modal, Spin, Typography } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderSearch, Waypoints } from 'lucide-react';
import { ActionIcon } from '@lobehub/ui';
import {
  pi,
  type SessionProjectTransferPreviewAck,
  type SessionProjectTransferFamilySummary,
} from '../../lib/pi';
import { pickDirectory } from '../../lib/dialog';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useSessionProjectTransferStore } from './sessionProjectTransferStore';
import {
  collectTransferTargets,
  transferBusyText,
  transferFamilyText,
  transferStaleText,
  type TransferTargetOption,
} from './sessionProjectTransferScope';

/**
 * 「移动到项目…」：选目标（侧栏已有项目 / 本地目录选择器）→ 预览（宿主题发 ticket / identity / 族摘要）
 * → 确认 → 逐步提交 → 成功打开 / 已移动但打开失败可重开。
 *
 * 迁移本身不请求模型、不搬代码文件；执行模式与审批只按目标显式本地策略取交集，没有目标授权时回退 Ask/只读。
 * 见 openspec/changes/move-sessions-between-projects/specs/session-project-transfer/spec.md。
 */

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  sectionLabel: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 500;
  `,
  path: css`
    overflow-wrap: anywhere;

    font-family: var(--font-mono);
    font-variant-ligatures: none;
    font-size: 12px;
  `,
  grid: css`
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
  `,
  targetList: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 208px;
    overflow-y: auto;
    padding: 2px;
  `,
  target: css`
    display: flex;
    align-items: center;
    gap: 8px;

    padding: 7px 9px;
    border: 1px solid transparent;
    border-radius: 8px;

    text-align: left;

    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  targetActive: css`
    border-color: ${cssVar.colorPrimaryBorder};
    background: ${cssVar.colorPrimaryBg};

    &:hover {
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  targetMain: css`
    display: flex;
    overflow: hidden;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  `,
  targetName: css`
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  targetPath: css`
    overflow: hidden;

    color: ${cssVar.colorTextTertiary};
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  targetMeta: css`
    flex: none;
    color: ${cssVar.colorTextQuaternary};
    font-size: 11px;
  `,
  note: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    line-height: 1.6;
  `,
  picker: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  progress: css`
    display: flex;
    gap: 8px;
    align-items: center;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  family: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  result: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
}));

export interface SessionProjectTransferDialogProps {
  /** 确认成功后打开目标会话并由 App 完成列表投影（保留标题 / 置顶 / 草稿）。 */
  onOpened: (result: { sourceWorkspace: string; targetWorkspace: string; sessionPath: string }) => Promise<void> | void;
  /** 已移动但打开失败后，重开成功同样要完成列表投影。 */
  onRetryOpened: (result: { sourceWorkspace: string; targetWorkspace: string; sessionPath: string }) => Promise<void> | void;
  /** 提交前失败 / 已移动但打开失败：让侧栏按事实刷新（不重复迁移）。 */
  onNeedsRefresh?: () => void;
}

interface NeedeOpenFact {
  operationId: string;
  targetWorkspace: string;
  reason: string;
}

interface RecoveryFact {
  recoveryReason: string;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'preview'; ack: SessionProjectTransferPreviewAck }
  | { kind: 'committing'; ack: SessionProjectTransferPreviewAck }
  | { kind: 'moved-needs-open'; fact: NeedeOpenFact }
  | { kind: 'recovery-required'; fact: RecoveryFact };

const PHASE_TEXT: Record<string, string> = {
  prepared: '正在准备快照…',
  applying: '正在写入目标归属…',
  committed: '已提交，正在打开目标项目…',
  opened: '正在完成打开…',
  'previewed': '正在确认…',
  'recovery-required': '需要人工恢复',
};

export function SessionProjectTransferDialog({ onOpened, onRetryOpened, onNeedsRefresh }: SessionProjectTransferDialogProps) {
  const target = useSessionProjectTransferStore((s) => s.target);
  const close = useSessionProjectTransferStore((s) => s.close);
  const allSessions = useSessionStore((s) => s.allSessions);
  const registeredProjects = useSessionStore((s) => s.registeredProjects);
  const worksDir = useSessionStore((s) => s.worksDir);
  const aliases = useSidebarPrefsStore((s) => s.aliases);

  const [chosen, setChosen] = useState<string>('');
  const [pickedDir, setPickedDir] = useState<string>('');
  const [dirError, setDirError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRef = useRef(target);
  openRef.current = target;

  const candidates = useMemo(
    () =>
      target
        ? collectTransferTargets({
            allSessions,
            registeredProjects,
            worksDir,
            aliases,
            sourceWorkspace: target.sourceWorkspace,
          })
        : [],
    [target, allSessions, registeredProjects, worksDir, aliases],
  );

  const reset = useCallback(() => {
    setChosen('');
    setPickedDir('');
    setDirError(null);
    setStage({ kind: 'idle' });
    setError(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    reset();
  }, [target?.sessionPath, target?.sourceWorkspace, reset]);

  const targetWorkspace = pickedDir || chosen;

  const pick = useCallback(async () => {
    setDirError(null);
    try {
      const dir = await pickDirectory();
      if (!dir) return;
      if (pathsEquivalent(dir, target?.sourceWorkspace ?? '')) {
        setDirError('这就是会话当前所在的项目，换一个目标目录');
        return;
      }
      setPickedDir(dir);
      setChosen('');
      setStage({ kind: 'idle' });
      setError(null);
    } catch (e) {
      setDirError(e instanceof Error ? e.message : String(e));
    }
  }, [target?.sourceWorkspace]);

  const preview = useCallback(async () => {
    if (!target || !targetWorkspace || stage.kind === 'previewing' || stage.kind === 'committing') return;
    setStage({ kind: 'previewing' });
    setError(null);
    setNotice(null);
    try {
      const ack = await pi.sessionProjectTransfer.preview(target.sourceWorkspace, {
        sessionPath: target.sessionPath,
        targetWorkspace,
      });
      if (openRef.current !== target) return;
      if (ack.status === 'preview') {
        setStage({ kind: 'preview', ack });
        return;
      }
      setStage({ kind: 'idle' });
      if (ack.status === 'no-op') {
        setNotice('会话已经在这个项目里，没有需要移动的内容');
        return;
      }
      if (ack.status === 'busy') {
        setNotice(transferBusyText(ack.busyReason, ack.detail));
        return;
      }
      if (ack.status === 'stale') {
        setNotice(transferStaleText(ack.staleReason));
        return;
      }
      if (ack.status === 'recovery-required') {
        setStage({ kind: 'recovery-required', fact: { recoveryReason: ack.recoveryReason } });
        return;
      }
      setNotice(ack.notice ?? '预览没有返回可确认的移动');
    } catch (e) {
      setStage({ kind: 'idle' });
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [target, targetWorkspace, stage.kind]);

  const commit = useCallback(async () => {
    if (!target || stage.kind !== 'preview') return;
    const previewAck = stage.ack;
    setStage({ kind: 'committing', ack: previewAck });
    setError(null);
    try {
      const ack = await pi.sessionProjectTransfer.commit(target.sourceWorkspace, {
        sessionPath: target.sessionPath,
        operationId: previewAck.operationId,
        ticket: previewAck.ticket,
        expectedSessionId: previewAck.sessionId,
        expectedLeafId: previewAck.leafId,
        expectedRevision: previewAck.revision,
      });
      if (ack.status === 'opened') {
        await onOpened({
          sourceWorkspace: target.sourceWorkspace,
          targetWorkspace: ack.targetWorkspace,
          sessionPath: ack.sessionPath || target.sessionPath,
        });
        close();
        return;
      }
      if (ack.status === 'committed-needs-open') {
        setStage({
          kind: 'moved-needs-open',
          fact: { operationId: ack.operationId, targetWorkspace: ack.targetWorkspace, reason: ack.reason },
        });
        onNeedsRefresh?.();
        return;
      }
      if (ack.status === 'recovery-required') {
        setStage({ kind: 'recovery-required', fact: { recoveryReason: ack.recoveryReason } });
        onNeedsRefresh?.();
        return;
      }
      if (ack.status === 'stale') {
        setStage({ kind: 'idle' });
        setNotice(transferStaleText(ack.staleReason));
        return;
      }
      if (ack.status === 'busy') {
        setStage({ kind: 'idle' });
        setNotice(transferBusyText(ack.busyReason, ack.detail));
        return;
      }
      if (ack.status === 'no-op') {
        setStage({ kind: 'idle' });
        setNotice('会话已经在这个项目里，没有需要移动的内容');
        return;
      }
      // 没有打开、但也没有明确终态：按事实给出「已移动待打开」，不重跑迁移。
      setStage({
        kind: 'moved-needs-open',
        fact: {
          operationId: previewAck.operationId,
          targetWorkspace: targetWorkspace,
          reason: ack.notice ?? '提交后没有收到打开结果',
        },
      });
      onNeedsRefresh?.();
    } catch (e) {
      // commit 回执丢了：查一次事实，不重复提交。
      setStage({ kind: 'idle' });
      setError(`${e instanceof Error ? e.message : String(e)}；如果已经移动，请用「重新打开」检查`);
      onNeedsRefresh?.();
    }
  }, [target, stage, onOpened, close, onNeedsRefresh]);

  const retryOpen = useCallback(async () => {
    if (!target || stage.kind !== 'moved-needs-open') return;
    const operationId = stage.fact.operationId;
    setError(null);
    try {
      const ack = await pi.sessionProjectTransfer.retryOpen(target.sourceWorkspace, {
        sessionPath: target.sessionPath,
        operationId,
      });
      if (ack.status === 'opened') {
        await onRetryOpened({
          sourceWorkspace: target.sourceWorkspace,
          targetWorkspace: ack.targetWorkspace,
          sessionPath: ack.sessionPath || target.sessionPath,
        });
        close();
        return;
      }
      if (ack.status === 'committed-needs-open') {
        setStage({
          kind: 'moved-needs-open',
          fact: { operationId: ack.operationId, targetWorkspace: ack.targetWorkspace, reason: ack.reason },
        });
        setError(ack.reason);
        return;
      }
      if (ack.status === 'recovery-required') {
        setStage({ kind: 'recovery-required', fact: { recoveryReason: ack.recoveryReason } });
        return;
      }
      setError(ack.notice ?? '重新打开没有成功');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [target, stage, onRetryOpened, close]);

  const cancel = useCallback(() => {
    if (stage.kind === 'committing') {
      // 提交已开始：关闭只收起界面，不解释成回滚；结果由主进程的 operationId 决定。
      close();
      return;
    }
    close();
  }, [stage.kind, close]);

  const targetLabel = pickedDir
    ? pickedDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pickedDir
    : aliases[chosen] || chosen.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || chosen;

  const previewAck = stage.kind === 'preview' || stage.kind === 'committing' ? stage.ack : null;

  return (
    <Modal
      open={target != null}
      title="移动到项目…"
      width={560}
      centered
      destroyOnHidden
      data-testid="session-project-transfer-dialog"
      okText={
        stage.kind === 'preview'
          ? '确认移动'
          : stage.kind === 'moved-needs-open'
            ? '重新打开'
            : stage.kind === 'committing'
              ? '正在移动…'
              : '预览移动'
      }
      cancelText={stage.kind === 'committing' ? '收起' : '取消'}
      confirmLoading={stage.kind === 'previewing' || stage.kind === 'committing'}
      okButtonProps={{
        'data-testid': 'session-transfer-confirm',
        disabled: !targetWorkspace || stage.kind === 'previewing' || stage.kind === 'recovery-required',
      } as never}
      cancelButtonProps={{ 'data-testid': 'session-transfer-cancel' } as never}
      onCancel={cancel}
      onOk={() => {
        if (stage.kind === 'moved-needs-open') return retryOpen();
        if (stage.kind === 'preview') return commit();
        return preview();
      }}
    >
      <div className={styles.body} data-testid="session-transfer-body">
        <div className={styles.grid}>
          <div>
            <div className={styles.sectionLabel}>会话</div>
            <div className={styles.path} data-testid="session-transfer-title">
              {target?.title || '未命名会话'}
            </div>
          </div>
          <div>
            <div className={styles.sectionLabel}>从（源项目）</div>
            <div className={styles.path} data-testid="session-transfer-source">
              {target?.sourceWorkspace}
            </div>
          </div>
          <div>
            <div className={styles.sectionLabel}>到（目标项目）</div>
            <div className={styles.path} data-testid="session-transfer-target">
              {targetWorkspace || '还没有选择目标'}
            </div>
          </div>
        </div>

        <div className={styles.note} data-testid="session-transfer-no-files">
          只移动会话归属与运行环境。不搬动、删除任何代码或生成文件；历史文件引用仍指向原来的目录。
        </div>

        {stage.kind === 'recovery-required' ? (
          <Alert
            type="error"
            showIcon
            data-testid="session-transfer-recovery"
            message="需要先恢复这次移动"
            description={`${stage.fact.recoveryReason}。为保护证据，相关会话暂时不能发送或删除。`}
          />
        ) : null}

        {stage.kind === 'moved-needs-open' ? (
          <div className={styles.result}>
            <Alert
              type="warning"
              showIcon
              data-testid="session-transfer-needs-open"
              message="已移动到目标项目，但打开失败"
              description={`${stage.fact.targetWorkspace} · ${stage.fact.reason}`}
            />
            <div className={styles.note}>
              会话已经归属目标项目，不会再移动一次。可以稍后点「重新打开」，侧栏项目登记和列表会自动补齐。
            </div>
            {error ? <Alert type="error" showIcon message={error} data-testid="session-transfer-retry-error" /> : null}
          </div>
        ) : (
          <>
            <div>
              <div className={styles.sectionLabel} style={{ marginBottom: 6 }}>
                选择侧栏已有项目
              </div>
              <div className={styles.targetList} data-testid="session-transfer-targets">
                {candidates.length === 0 ? (
                  <div className={styles.note}>还没有其它项目，用下面的目录选择器指定一个本地目录。</div>
                ) : (
                  candidates.map((item) => (
                    <button
                      key={item.cwd}
                      type="button"
                      data-testid="session-transfer-target-option"
                      data-cwd={item.cwd}
                      data-active={!pickedDir && pathsEquivalent(item.cwd, chosen) ? 'true' : 'false'}
                      className={`${styles.target} ${!pickedDir && pathsEquivalent(item.cwd, chosen) ? styles.targetActive : ''}`}
                      onClick={() => {
                        setChosen(item.cwd);
                        setPickedDir('');
                        setStage({ kind: 'idle' });
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      <Waypoints size={14} />
                      <span className={styles.targetMain}>
                        <span className={styles.targetName}>{item.name}</span>
                        <span className={styles.targetPath}>{item.cwd}</span>
                      </span>
                      <span className={styles.targetMeta}>
                        {item.sessionCount > 0 ? `${item.sessionCount} 份会话` : '空项目'}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className={styles.picker}>
              <ActionIcon
                icon={FolderSearch}
                size="small"
                title="选择本地目录"
                data-testid="session-transfer-pick-dir"
                onClick={() => void pick()}
              />
              <Input
                readOnly
                value={pickedDir}
                placeholder="或通过本地目录选择器指定尚未加入侧栏的项目"
                data-testid="session-transfer-picked-dir"
              />
            </div>
            {dirError ? <Alert type="error" showIcon message={dirError} data-testid="session-transfer-dir-error" /> : null}

            {previewAck ? (
              <div className={styles.grid} data-testid="session-transfer-preview">
                <div>
                  <span className={styles.sectionLabel}>目标名称：</span>
                  {previewAck.targetName || targetLabel}
                </div>
                <div className={styles.family} data-testid="session-transfer-family">
                  {transferFamilyText(previewAck.family as SessionProjectTransferFamilySummary)}
                </div>
                <div className={styles.note} data-testid="session-transfer-policy">
                  迁移不发送草稿、不请求模型（0 次）。执行模式与审批只采用目标项目的显式本地授权；没有对应授权时回退
                  Ask / 只读，不会沿用源项目的完全权限。模型、思考档位与 Fast 偏好保持不变，目标不可用的模型只标记不替换。
                </div>
                {previewAck.warnings?.length ? (
                  <div className={styles.note} data-testid="session-transfer-warnings">
                    {previewAck.warnings.join('；')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {stage.kind === 'previewing' || stage.kind === 'committing' ? (
          <div className={styles.progress} data-testid="session-transfer-progress">
            <Spin size="small" />
            <span>{stage.kind === 'previewing' ? '正在预览…' : PHASE_TEXT[stage.ack.phase ?? 'prepared'] ?? '正在移动…'}</span>
          </div>
        ) : null}

        {notice ? <Alert type="info" showIcon message={notice} data-testid="session-transfer-notice" /> : null}
        {error && stage.kind !== 'moved-needs-open' ? (
          <Alert type="error" showIcon message={error} data-testid="session-transfer-error" />
        ) : null}

        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          移动的是会话本身；源项目里仍保留原 JSONL 文件作为恢复材料，完成后侧栏只在目标项目列出它。
        </Typography.Text>
      </div>
    </Modal>
  );
}
