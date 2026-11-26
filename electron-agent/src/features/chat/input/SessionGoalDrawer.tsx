import { useRef, useState } from 'react';
import { Button, Drawer, Input } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Icon } from '@lobehub/ui';
import { RotateCw, Save, Trash2 } from 'lucide-react';
import { refreshGoalStatus } from '../../extensionUi/goalStatus';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useGoalStore, type GoalHistoryItem, type GoalSnapshot } from '../../../stores/goalStore';
import { useSessionStore } from '../../../store/session';
import { goalNeedsRestart, goalPauseLabel } from './goalStatusLabels';
import { controlGoal, useGoalEditor } from './useGoalEditor';
import { useAskConfirm } from '../../../components/askConfirm';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-width: 0;
    color: ${cssVar.colorText};
  `,
  header: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  condition: css`
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.45;
  `,
  status: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;

    h4 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }
  `,
  details: css`
    display: grid;
    grid-template-columns: minmax(92px, 0.35fr) minmax(0, 1fr);
    gap: 7px 12px;
    margin: 0;
    font-size: 12px;

    dt { color: ${cssVar.colorTextSecondary}; }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  `,
  timeline: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      min-width: 0;
      padding: 8px 10px;
      border-left: 2px solid ${cssVar.colorBorderSecondary};
      background: ${cssVar.colorFillQuaternary};
    }

    small { color: ${cssVar.colorTextQuaternary}; }
  `,
  muted: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  actions: css`
    display: flex;
    justify-content: flex-end;
    padding-top: 2px;
  `,
  warning: css`font-size: 12px; color: ${cssVar.colorError}; overflow-wrap: anywhere;`,
  editor: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    label {
      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
    }
  `,
}));

export interface SessionGoalDrawerProps {
  open: boolean;
  sessionId: string;
  snapshot?: GoalSnapshot;
  sessionPath?: string | null;
  onClose: () => void;
  onSnapshot?: (snapshot: GoalSnapshot) => void;
}

const statusLabels: Record<GoalSnapshot['status'], string> = {
  active: '执行中的目标',
  paused: '已暂停的目标',
  blocked: '受阻的目标',
  complete: '已完成的目标',
};

const editableStatuses: GoalSnapshot['status'][] = ['active', 'paused', 'blocked'];

function historyKey(item: GoalHistoryItem, index: number): string {
  if (item.source === 'event') return `event-${item.kind}-${item.revision}-${item.at}-${index}`;
  return `round-${item.round}-${item.revision}-${index}`;
}

export function SessionGoalDrawer({ open, sessionId, sessionPath, snapshot, onClose }: SessionGoalDrawerProps) {
  const ask = useAskConfirm();
  const { workspace } = useAgentStoreContext();
  const activePath = useSessionStore((state) => state.activeSessionPath);
  const path = sessionPath ?? activePath;
  const liveSnapshot = useGoalStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  const currentSnapshot = liveSnapshot ?? snapshot;
  const editor = useGoalEditor(workspace, path, currentSnapshot);
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState('');
  const inflight = useRef(false);
  const valid = !!currentSnapshot && currentSnapshot.sessionId === sessionId;
  const history = currentSnapshot?.history ?? [];

  const clearable = !!currentSnapshot;
  const canEditCondition = !!currentSnapshot && editableStatuses.includes(currentSnapshot.status);

  const runAction = async (action: 'clear' | 'resume', target: GoalSnapshot, originalPath: string) => {
    if (!workspace || inflight.current) return;
    inflight.current = true;
    setMutating(true);
    setActionError('');
    try {
      await controlGoal(workspace, originalPath, target, action);
      void refreshGoalStatus(workspace, originalPath);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '目标操作未提交，请重新读取。');
    } finally {
      inflight.current = false;
      setMutating(false);
    }
  };

  const clearGoal = async () => {
    if (!currentSnapshot || !path || !clearable || mutating || editor.busy || inflight.current) return;
    const target = currentSnapshot;
    const originalPath = path;
    if (await ask({ title: '清除当前目标？' })) await runAction('clear', target, originalPath);
  };

  if (!open || !valid || !currentSnapshot) return null;

  return (
    <Drawer
      classNames={{ body: styles.root }}
      closable
      keyboard
      maskClosable
      onClose={onClose}
      open
      size="min(560px, 100vw)"
      title="目标详情"
      styles={{ wrapper: { maxWidth: '100vw' }, header: { padding: '16px clamp(16px, 3vw, 24px)' }, body: { minWidth: 0, padding: '20px clamp(16px, 3vw, 24px) 32px' } }}
    >
      <div className={styles.header}>
        <p className={styles.condition}>{currentSnapshot.condition}</p>
        <p className={styles.status}>{currentSnapshot.runtimeUnavailable ? '已停止，暂停未保存' : statusLabels[currentSnapshot.status]}</p>
        {goalPauseLabel(currentSnapshot) ? <p className={currentSnapshot.runtimeUnavailable ? styles.warning : styles.status} data-testid="goal-drawer-reason">{goalPauseLabel(currentSnapshot)}</p> : null}
        {currentSnapshot.runtimeUnavailable && path ? <Button icon={<Icon icon={RotateCw} size={14} />} onClick={() => void refreshGoalStatus(workspace, path)} size="small">重新读取目标状态</Button> : null}
      </div>

      {canEditCondition ? (
        <section className={styles.editor} aria-labelledby="session-goal-condition-heading">
          <label id="session-goal-condition-heading" htmlFor="session-goal-condition">目标条件</label>
          <Input.TextArea
            aria-label="目标条件"
            autoSize={{ minRows: 2, maxRows: 6 }}
            id="session-goal-condition"
            maxLength={4000}
            onChange={(event) => editor.setDraft(event.target.value)}
            readOnly={editor.busy}
            value={editor.draft}
          />
          <div className={styles.actions}>
            <Button
              disabled={mutating || editor.busy || editor.conflict || !editor.dirty || !editor.draft.trim()}
              icon={<Icon icon={Save} size={14} />}
              loading={editor.busy}
              onClick={() => void editor.save().then((done) => {
                if (!done && open) document.getElementById('session-goal-condition')?.focus();
              })}
              size="small"
              type="primary"
            >
              保存目标
            </Button>
          </div>
          {editor.error ? <p role="alert" className={styles.warning}>{editor.error}</p> : null}
          {editor.conflict ? <div className={styles.actions}><Button onClick={editor.loadLatest} size="small">载入最新版</Button><Button onClick={editor.rebase} size="small">基于最新版提交</Button></div> : null}
        </section>
      ) : null}
      {goalNeedsRestart(currentSnapshot) && !currentSnapshot.runtimeUnavailable ? (
        <Button disabled={mutating || editor.busy} onClick={() => { if (path) void runAction('resume', currentSnapshot, path); }}>开启新批次（保留累计历史）</Button>
      ) : null}
      {actionError ? <p role="alert" className={styles.warning}>{actionError}</p> : null}
      {clearable ? (
        <div className={styles.actions}>
          <Button
            aria-label="清除目标"
            danger
            disabled={mutating || editor.busy}
            icon={<Icon icon={Trash2} size={14} />}
            onClick={() => void clearGoal()}
            size="small"
            type="text"
          >
            清除目标
          </Button>
        </div>
      ) : null}

      <section className={styles.section} aria-labelledby="session-goal-info-heading">
        <h4 id="session-goal-info-heading">目标信息</h4>
        <dl className={styles.details}>
          <dt>sessionId</dt><dd>{currentSnapshot.sessionId}</dd>
          <dt>goalId</dt><dd>{currentSnapshot.goalId}</dd>
          <dt>revision</dt><dd>{currentSnapshot.revision}</dd>
          <dt>本批次</dt><dd>第 {currentSnapshot.runNumber ?? 1} 批 · 已用 {currentSnapshot.runRoundsStarted ?? currentSnapshot.roundsStarted} / {currentSnapshot.maxRounds} 轮</dd>
          <dt>累计轮次</dt><dd>{currentSnapshot.roundsStarted} 轮</dd>
          <dt>创建时间</dt><dd>{currentSnapshot.createdAt}</dd>
          <dt>更新时间</dt><dd>{currentSnapshot.updatedAt}</dd>
        </dl>
      </section>

      {currentSnapshot.blockedReason ? (
        <section className={styles.section} aria-labelledby="session-goal-blockage-heading">
          <h4 id="session-goal-blockage-heading">阻塞证据</h4>
          <p className={styles.muted}>{currentSnapshot.blockedReason.message}</p>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="session-goal-events-heading">
        <h4 id="session-goal-events-heading">操作记录</h4>
        {history.length === 0 ? <p className={styles.muted}>暂无操作记录</p> : (
          <ol className={styles.timeline}>
            {history.map((item, index) => (
              <li key={historyKey(item, index)}>
                {item.source === 'event' ? (
                  <>
                    <div>{item.kind}</div>
                    <small>{item.at}</small>
                  </>
                ) : (
                  <>
                    <div>{item.runNumber && item.runRound ? `第 ${item.runNumber} 批 · 第 ${item.runRound} 轮` : `第 ${item.round} 轮`}</div>
                    {item.content ? <p className={styles.muted}>{item.content}</p> : null}
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Drawer>
  );
}
