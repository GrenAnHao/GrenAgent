import { useEffect, useRef, useState } from 'react';
import { Button, Drawer, Input } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Icon } from '@lobehub/ui';
import { Save, Trash2 } from 'lucide-react';
import { pi } from '../../../lib/pi';
import { refreshGoalStatus } from '../../extensionUi/goalStatus';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useGoalStore, type GoalHistoryItem, type GoalSnapshot } from '../../../stores/goalStore';
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

export function SessionGoalDrawer({ open, sessionId, snapshot, onClose }: SessionGoalDrawerProps) {
  const ask = useAskConfirm();
  const { workspace, store } = useAgentStoreContext();
  const liveSnapshot = useGoalStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  const currentSnapshot = liveSnapshot ?? snapshot;
  const [mutating, setMutating] = useState(false);
  const [savingCondition, setSavingCondition] = useState(false);
  const [conditionDraft, setConditionDraft] = useState(currentSnapshot?.condition ?? '');
  const inflight = useRef(false);
  const valid = !!currentSnapshot && currentSnapshot.sessionId === sessionId;
  const history = currentSnapshot?.history ?? [];

  useEffect(() => {
    setConditionDraft(currentSnapshot?.condition ?? '');
  }, [currentSnapshot?.goalId, currentSnapshot?.revision, currentSnapshot?.condition]);

  const clearable = !!currentSnapshot;
  const canEditCondition = !!currentSnapshot && editableStatuses.includes(currentSnapshot.status);

  const runCommand = async (message: string) => {
    if (!workspace || inflight.current) return;
    inflight.current = true;
    try {
      const path = store.getLoadedSessionPath();
      await pi.prompt(workspace, message, undefined, undefined, path);
      void refreshGoalStatus(workspace, path);
    } finally {
      inflight.current = false;
    }
  };

  const clearGoal = async () => {
    if (!currentSnapshot || !clearable || mutating || savingCondition || inflight.current) return;
    if (!(await ask({ title: '清除当前目标？' }))) return;
    setMutating(true);
    try {
      await runCommand('/goal clear');
    } catch {
      // 失败不藏条；扩展回执说明原因。
    } finally {
      setMutating(false);
    }
  };

  const saveCondition = async () => {
    const condition = conditionDraft.trim();
    if (!currentSnapshot || !canEditCondition || !condition || condition === currentSnapshot.condition || mutating || savingCondition) return;
    setSavingCondition(true);
    try {
      await runCommand(`/goal edit ${condition}`);
    } catch {
      // 失败留草稿。
    } finally {
      setSavingCondition(false);
    }
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
        <p className={styles.status}>{statusLabels[currentSnapshot.status]}</p>
      </div>

      {canEditCondition ? (
        <section className={styles.editor} aria-labelledby="session-goal-condition-heading">
          <label id="session-goal-condition-heading" htmlFor="session-goal-condition">目标条件</label>
          <Input.TextArea
            aria-label="目标条件"
            autoSize={{ minRows: 2, maxRows: 6 }}
            id="session-goal-condition"
            maxLength={4000}
            onChange={(event) => setConditionDraft(event.target.value)}
            value={conditionDraft}
          />
          <div className={styles.actions}>
            <Button
              disabled={mutating || savingCondition || !conditionDraft.trim() || conditionDraft.trim() === currentSnapshot.condition}
              icon={<Icon icon={Save} size={14} />}
              loading={savingCondition}
              onClick={() => void saveCondition()}
              size="small"
              type="primary"
            >
              保存目标
            </Button>
          </div>
        </section>
      ) : null}
      {clearable ? (
        <div className={styles.actions}>
          <Button
            aria-label="清除目标"
            danger
            disabled={mutating}
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
          <dt>轮次</dt><dd>{currentSnapshot.roundsStarted} / {currentSnapshot.maxRounds}</dd>
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
                    <div>第 {item.round} 轮</div>
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
