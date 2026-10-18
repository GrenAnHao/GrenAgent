// 独立工作区（A 轨）的三个弹窗：新建、管理（状态 / 回传 / 删除）、已删除工作区里的会话只读查看。
// Note: 见 .agents/notes/implemented/architecture/2026-10-17-grenagent-hosted-worktree-dual-track.md
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, Empty, Modal, Radio, Space, Tag, Typography, message as staticMessage } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  pi,
  type IsolatedWorkspaceEntry,
  type IsolatedWorkspaceState,
} from '../../lib/pi';
import { isolatedErrorCode, isolatedErrorText } from '../../lib/isolatedWorkspace';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import { syncBackIsolated } from './actions';
import { useChildSessionBinding } from '../panels/useChildSessionBinding';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeAnsweredQuestions, computeSubAgentUnits } from '../chat/messagePrecompute';

const styles = createStaticStyles(({ css }) => ({
  hint: css`
    margin-bottom: 12px;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.6;
  `,
  option: css`
    margin-bottom: 2px;
  `,
  optionDesc: css`
    display: block;
    margin: 0 0 8px 24px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  more: css`
    margin: 4px 0 8px;
    padding: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  checks: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  `,
  entry: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    & + & {
      margin-top: 8px;
    }
  `,
  focused: css`
    border-color: ${cssVar.colorPrimaryBorder};
    background: ${cssVar.colorPrimaryBg};
  `,
  entryMain: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
  `,
  entryTitle: css`
    font-weight: 500;
  `,
  entryMeta: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tags: css`
    margin-top: 4px;
  `,
  foot: css`
    margin-top: 12px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  viewer: css`
    display: flex;
    flex-direction: column;
    height: 70vh;
    min-height: 320px;
  `,
}));

export interface IsolatedWorkspaceDialogsProps {
  /** 把一个目录当项目打开（与「使用现有文件夹」同一条路）。 */
  openProject: (dir: string) => Promise<void>;
  /** 删掉了某个独立工作区：当前正停在它上面时调用方切回父项目。 */
  onDeleted: (path: string, parentRoot: string) => void;
}

export function IsolatedWorkspaceDialogs({ openProject, onDeleted }: IsolatedWorkspaceDialogsProps) {
  const dialog = useIsolatedWorkspaceStore((s) => s.dialog);
  const close = useIsolatedWorkspaceStore((s) => s.close);
  return (
    <>
      <CreateDialog project={dialog?.kind === 'create' ? dialog.project : null} onClose={close} openProject={openProject} />
      <ManageDialog
        project={dialog?.kind === 'manage' ? dialog.project : null}
        focusId={dialog?.kind === 'manage' ? dialog.focusId : undefined}
        onClose={close}
        openProject={openProject}
        onDeleted={onDeleted}
      />
      <ViewerDialog
        sessionPath={dialog?.kind === 'viewer' ? dialog.sessionPath : null}
        title={dialog?.kind === 'viewer' ? dialog.title : ''}
        onClose={close}
      />
    </>
  );
}

function CreateDialog({
  project,
  onClose,
  openProject,
}: {
  project: string | null;
  onClose: () => void;
  openProject: (dir: string) => Promise<void>;
}) {
  const [base, setBase] = useState<'fresh' | 'head'>('fresh');
  const [showMore, setShowMore] = useState(false);
  const [fetchFirst, setFetchFirst] = useState(false);
  const [carry, setCarry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都回到默认：fresh、fetch 跟设置页、不带未提交改动。
  useEffect(() => {
    if (!project) return;
    setBase('fresh');
    setShowMore(false);
    setCarry(false);
    setError(null);
    setBusy(false);
    let cancelled = false;
    void pi.getSettings().then(
      (settings) => {
        if (!cancelled) setFetchFirst(settings.isolatedWorkspaceFetch === '1');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [project]);

  const submit = useCallback(async () => {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const marker = await pi.createIsolatedWorkspace(project, {
        base,
        ...(base === 'fresh' && fetchFirst ? { fetch: true } : {}),
        ...(carry ? { carryChanges: true } : {}),
      });
      useIsolatedWorkspaceStore.getState().bump();
      onClose();
      await openProject(marker.path);
    } catch (e) {
      setError(isolatedErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [project, busy, base, fetchFirst, carry, onClose, openProject]);

  return (
    <Modal
      open={project != null}
      title="在独立工作区中新建会话"
      okText={busy ? '正在创建…' : '创建并打开'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ 'data-testid': 'isolated-create-ok' } as never}
      onOk={submit}
      onCancel={busy ? undefined : onClose}
      maskClosable={!busy}
      destroyOnHidden
      centered
    >
      <div data-testid="isolated-create-dialog">
        <div className={styles.hint}>
          在 <Typography.Text code>{project ? `${project.replace(/[\\/]+$/, '')}/.gren/worktrees/` : ''}</Typography.Text>{' '}
          下克隆一份仓库。会话只能改这份副本，写主仓会被直接拒绝；改完用「回传分支到主仓」把分支带回去。
        </div>
        <Radio.Group
          value={base}
          style={{ display: 'flex', flexDirection: 'column' }}
          onChange={(e) => {
            setBase(e.target.value as 'fresh' | 'head');
            setError(null);
          }}
        >
          <div>
            <Radio className={styles.option} value="fresh" data-testid="isolated-base-fresh">
              基于远端默认分支（推荐）
            </Radio>
            <span className={styles.optionDesc}>从 origin 的默认分支最新提交开始，之后合并、开 PR 冲突最少。</span>
          </div>
          {showMore || base === 'head' ? (
            <div>
              <Radio className={styles.option} value="head" data-testid="isolated-base-head">
                基于当前 HEAD
              </Radio>
              <span className={styles.optionDesc}>接着本地当前分支的提交。</span>
            </div>
          ) : null}
        </Radio.Group>
        {!showMore && base !== 'head' ? (
          <Button type="link" size="small" className={styles.more} data-testid="isolated-more" onClick={() => setShowMore(true)}>
            其他基准…
          </Button>
        ) : null}
        {base === 'head' ? (
          <Alert
            type="warning"
            showIcon
            data-testid="isolated-head-warning"
            message="和主线重叠时更容易冲突"
            description="只在要接着本地还没合入的半成品时选。平时用远端默认分支，冲突更少。"
            style={{ marginBottom: 8 }}
          />
        ) : null}
        <div className={styles.checks}>
          <Checkbox
            checked={base === 'fresh' && fetchFirst}
            disabled={base !== 'fresh'}
            onChange={(e) => setFetchFirst(e.target.checked)}
            data-testid="isolated-fetch"
          >
            创建前先 fetch 远端
          </Checkbox>
          <Checkbox checked={carry} onChange={(e) => setCarry(e.target.checked)} data-testid="isolated-carry">
            把主仓未提交的改动复制进去（主仓里的改动保持不动）
          </Checkbox>
        </div>
        {error ? (
          <Alert type="error" showIcon data-testid="isolated-create-error" message="没有创建" description={error} style={{ marginTop: 12 }} />
        ) : null}
      </div>
    </Modal>
  );
}

function stateTags(entry: IsolatedWorkspaceEntry, state: IsolatedWorkspaceState | undefined) {
  if (!entry.exists) return [<Tag key="gone">目录已删除</Tag>];
  if (!state) return [<Tag key="loading">读取状态…</Tag>];
  const tags = [];
  if (state.dirty) tags.push(<Tag key="dirty" color="orange">有未提交改动</Tag>);
  if (state.ahead > 0) tags.push(<Tag key="ahead">领先基准 {state.ahead} 个提交</Tag>);
  tags.push(state.synced ? <Tag key="synced" color="green">{state.ahead > 0 ? '已回传' : '没有新提交'}</Tag> : <Tag key="unsynced" color="red">未回传</Tag>);
  return tags;
}

function ManageDialog({
  project,
  focusId,
  onClose,
  openProject,
  onDeleted,
}: {
  project: string | null;
  focusId: string | undefined;
  onClose: () => void;
  openProject: (dir: string) => Promise<void>;
  onDeleted: (path: string, parentRoot: string) => void;
}) {
  // 没有 antd <App> 包裹时 useApp 返回空对象，退回静态方法。
  const appApi = App.useApp();
  const message = appApi.message ?? staticMessage;
  const modal = appApi.modal ?? Modal;
  const revision = useIsolatedWorkspaceStore((s) => s.revision);
  const [entries, setEntries] = useState<IsolatedWorkspaceEntry[] | null>(null);
  const [states, setStates] = useState<Record<string, IsolatedWorkspaceState>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      setEntries(null);
      setStates({});
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const list = await pi.listIsolatedWorkspaces(project);
        if (cancelled) return;
        setEntries(list);
        const pairs = await Promise.all(
          list.filter((e) => e.exists).map(async (e) => [e.id, await pi.isolatedWorkspaceState(project, e.id).catch(() => undefined)] as const),
        );
        if (cancelled) return;
        setStates(Object.fromEntries(pairs.filter((p): p is readonly [string, IsolatedWorkspaceState] => Boolean(p[1]))));
      } catch (e) {
        if (!cancelled) setError(isolatedErrorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, revision]);

  // 删除走两道确认：没回传 / 有未提交改动时明确说会丢工作，再带 force；主进程那边也会再判一次。
  async function remove(entry: IsolatedWorkspaceEntry, force: boolean): Promise<void> {
    if (!project) return;
    setBusyId(entry.id);
    try {
      await pi.removeIsolatedWorkspace(project, entry.id, force);
      message.success(`已删除独立工作区 ${entry.branch}`);
      onDeleted(entry.path, project);
      useIsolatedWorkspaceStore.getState().bump();
    } catch (e) {
      // 列表里的状态旧了（期间又改过）：主进程判出没回传，改走「会丢工作」的确认。
      if (isolatedErrorCode(e) === 'ISOLATED_UNSAVED' && !force) confirmUnsaved(entry);
      else message.error(`删除失败：${isolatedErrorText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  function confirmUnsaved(entry: IsolatedWorkspaceEntry): void {
    modal.confirm({
      title: `${entry.branch} 还有没回传的工作`,
      content: '这个独立工作区有未提交的改动，或者分支还没回传到主仓。删除后这些工作就没了。',
      okText: '仍然删除',
      okButtonProps: { danger: true, 'data-testid': 'isolated-delete-force' } as never,
      cancelText: '先不删',
      centered: true,
      onOk: () => remove(entry, true),
    });
  }

  function requestDelete(entry: IsolatedWorkspaceEntry): void {
    const state = states[entry.id];
    if (entry.exists && state && (state.dirty || !state.synced)) {
      confirmUnsaved(entry);
      return;
    }
    modal.confirm({
      title: `删除独立工作区 ${entry.branch}？`,
      content: entry.exists
        ? '删除这份副本的目录。主仓里回传过的分支保留，会话记录保留、之后只能查看。'
        : '目录已经不在了，只清掉记录。',
      okText: '删除',
      okButtonProps: { danger: true, 'data-testid': 'isolated-delete-confirm' } as never,
      cancelText: '取消',
      centered: true,
      onOk: () => remove(entry, false),
    });
  }

  const sorted = useMemo(() => [...(entries ?? [])].reverse(), [entries]);

  return (
    <Modal
      open={project != null}
      title="独立工作区"
      footer={null}
      width={640}
      onCancel={onClose}
      destroyOnHidden
      centered
    >
      <div data-testid="isolated-manage-dialog">
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        {entries && entries.length === 0 ? (
          <Empty description="这个项目还没有独立工作区" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : null}
        {sorted.map((entry) => {
          const state = states[entry.id];
          return (
            <div
              key={entry.id}
              data-testid="isolated-entry"
              data-id={entry.id}
              className={cx(styles.entry, focusId === entry.id && styles.focused)}
            >
              <div className={styles.entryMain}>
                <div className={styles.entryTitle}>{entry.branch}</div>
                <div className={styles.entryMeta} title={entry.path}>
                  基于 {entry.base.kind === 'fresh' ? entry.base.ref : `当前 HEAD（${entry.base.ref}）`} @ {entry.base.commit.slice(0, 7)} · 创建于{' '}
                  {entry.createdAt.slice(0, 10)}
                  {entry.carried ? ' · 带入了主仓未提交改动' : ''}
                </div>
                <div className={styles.tags} data-testid="isolated-entry-tags">
                  {stateTags(entry, state)}
                </div>
              </div>
              <Space size={4}>
                {entry.exists ? (
                  <>
                    <Button size="small" onClick={() => { onClose(); void openProject(entry.path); }}>
                      打开
                    </Button>
                    <Button
                      size="small"
                      data-testid="isolated-sync-back"
                      disabled={!state || state.ahead === 0}
                      onClick={() => void syncBackIsolated(project ?? '', entry.id, message)}
                    >
                      回传
                    </Button>
                  </>
                ) : null}
                <Button size="small" danger loading={busyId === entry.id} data-testid="isolated-delete" onClick={() => requestDelete(entry)}>
                  删除
                </Button>
              </Space>
            </div>
          );
        })}
        <div className={styles.foot}>
          这里只列宿主建的独立工作区。create_worktree 在 .agents/worktrees 下建的、手动建的目录不在这里，也不能在这里删。
        </div>
      </div>
    </Modal>
  );
}

function ViewerDialog({ sessionPath, title, onClose }: { sessionPath: string | null; title: string; onClose: () => void }) {
  return (
    <Modal open={sessionPath != null} title={title} footer={null} width={860} onCancel={onClose} destroyOnHidden centered>
      <Alert
        type="info"
        showIcon
        message="这个会话所在的独立工作区已经删除，只能查看，不能继续对话。"
        style={{ marginBottom: 12 }}
      />
      {sessionPath ? <ReadonlySession sessionPath={sessionPath} /> : null}
    </Modal>
  );
}

function ReadonlySession({ sessionPath }: { sessionPath: string }) {
  const messages = useChildSessionBinding(sessionPath, false);
  const display = useMemo(() => groupMessages(messages), [messages]);
  const units = useMemo(() => computeSubAgentUnits(display), [display]);
  const answered = useMemo(() => computeAnsweredQuestions(display), [display]);
  return (
    <div className={styles.viewer} data-testid="isolated-readonly-session">
      <ChatMessageItems
        messages={display}
        unitsByMessage={units.unitsByMessage}
        hiddenSpawnIds={units.hidden}
        spawnOverlay={units.overlay}
        answeredQuestions={answered}
        paddingInline={8}
        resetKey={sessionPath}
      />
    </div>
  );
}
