import { useEffect, useRef, useState } from 'react';
import { Button, Drawer, Input } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Save, Trash2 } from 'lucide-react';
import { agentDataApi, type GoalEvent } from '../../../lib/agentData';
import type { GoalSnapshot } from '../../../stores/goalStore';

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
  disclosure: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    summary {
      cursor: pointer;
      padding: 7px 9px;
      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
    }

    pre {
      overflow: auto;
      margin: 0;
      padding: 8px 9px;
      font-size: 11px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: ${cssVar.colorFillQuaternary};
    }
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
  /** Allows the parent pill to keep its session projection in sync after a drawer action. */
  onSnapshot?: (snapshot: GoalSnapshot) => void;
}

const statusLabels: Record<GoalSnapshot['status'], string> = {
  active: '执行中', paused: '已暂停', disarmed: '待恢复', judging: '正在验收', blocked: '业务阻塞', complete: '已完成', error: '已停止', cleared: '已清除',
};

const sourceLabels: Record<NonNullable<GoalSnapshot['source']>, string> = {
  human: '用户创建',
  legacy: '旧日志迁移',
  fork: '会话分叉',
};

const editableStatuses: GoalSnapshot['status'][] = ['active', 'paused', 'blocked', 'disarmed', 'error'];

export function SessionGoalDrawer({ open, sessionId, snapshot, onClose, onSnapshot }: SessionGoalDrawerProps) {
  const [events, setEvents] = useState<GoalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [savingCondition, setSavingCondition] = useState(false);
  const [localSnapshot, setLocalSnapshot] = useState<GoalSnapshot | undefined>(snapshot);
  const [conditionDraft, setConditionDraft] = useState(snapshot?.condition ?? '');
  const epoch = useRef(0);
  const currentSnapshot = localSnapshot;
  const valid = !!currentSnapshot && currentSnapshot.sessionId === sessionId;

  useEffect(() => {
    setLocalSnapshot(snapshot);
    setConditionDraft(snapshot?.condition ?? '');
  }, [snapshot?.goalId, snapshot?.revision, snapshot?.condition]);

  useEffect(() => {
    const request = ++epoch.current;
    setEvents([]);
    if (!open || !valid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void agentDataApi.goals
      .history(sessionId)
      .then((result) => {
        if (request === epoch.current) setEvents(Array.isArray(result) ? result.slice(-12) : []);
      })
      .catch(() => {
        if (request === epoch.current) setEvents([]);
      })
      .finally(() => {
        if (request === epoch.current) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, [open, sessionId, valid, currentSnapshot?.revision]);

  const clearable = !!currentSnapshot && ['active', 'paused', 'blocked', 'disarmed', 'error'].includes(currentSnapshot.status);
  const canEditCondition = !!currentSnapshot && editableStatuses.includes(currentSnapshot.status);
  const clearGoal = async () => {
    if (!currentSnapshot || !clearable || mutating || savingCondition || !window.confirm('清除当前目标？')) return;
    setMutating(true);
    try {
      const next = await agentDataApi.goals.update({
        sessionId,
        goalId: currentSnapshot.goalId,
        revision: currentSnapshot.revision,
        action: 'clear',
      });
      setLocalSnapshot(next);
      onSnapshot?.(next);
    } catch {
      // Keep the last confirmed snapshot visible when the CAS update fails.
    } finally {
      setMutating(false);
    }
  };

  const saveCondition = async () => {
    const current = currentSnapshot;
    const condition = conditionDraft.trim();
    if (!current || !canEditCondition || !condition || condition === current.condition || mutating || savingCondition) return;
    setSavingCondition(true);
    try {
      if (current.status === 'blocked') {
        const next = await agentDataApi.goals.update({
          sessionId,
          goalId: current.goalId,
          revision: current.revision,
          action: 'block',
          payload: { condition },
        });
        setLocalSnapshot(next);
        onSnapshot?.(next);
        setConditionDraft(next.condition);
        return;
      }
      const firstAction = current.status === 'active' ? 'pause' : 'resume';
      let next = await agentDataApi.goals.update({
        sessionId,
        goalId: current.goalId,
        revision: current.revision,
        action: firstAction,
        payload: { condition },
      });
      setLocalSnapshot(next);
      onSnapshot?.(next);

      // AgentData currently exposes condition changes through the human CAS
      // actions. Restore the original status with a second revisioned update.
      const restoreAction = current.status === 'active'
        ? 'resume'
        : current.status === 'paused'
          ? 'pause'
          : current.status === 'disarmed'
              ? 'disarm'
              : undefined;
      if (restoreAction) {
        const restorePayload = restoreAction === 'block'
          ? { condition, reason: current.blockage?.summary ?? 'blocked', fingerprint: current.blockage?.fingerprint ?? '' }
          : { condition };
        next = await agentDataApi.goals.update({
          sessionId,
          goalId: next.goalId,
          revision: next.revision,
          action: restoreAction,
          payload: restorePayload,
        });
        setLocalSnapshot(next);
        onSnapshot?.(next);
      }
      setConditionDraft(next.condition);
    } catch {
      // Keep the last confirmed snapshot and draft when the CAS update fails.
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

      {currentSnapshot.status === 'cleared' ? (
        <p className={styles.muted}>该目标已清除，历史记录仍保留。</p>
      ) : null}
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
              icon={<Save size={14} />}
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
            icon={<Trash2 size={14} />}
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
          {currentSnapshot.source ? <><dt>来源</dt><dd>{sourceLabels[currentSnapshot.source]}</dd></> : null}
          <dt>revision</dt><dd>{currentSnapshot.revision}</dd>
          <dt>轮次</dt><dd>{currentSnapshot.roundsUsed} / {currentSnapshot.maxRounds}</dd>
          <dt>创建时间</dt><dd>{currentSnapshot.createdAt}</dd>
          <dt>更新时间</dt><dd>{currentSnapshot.updatedAt}</dd>
        </dl>
      </section>

      {currentSnapshot.stopReason ? (
        <section className={styles.section} aria-labelledby="session-goal-stop-heading">
          <h4 id="session-goal-stop-heading">停止原因</h4>
          <p className={styles.muted}>{currentSnapshot.stopReason.kind}</p>
          <p className={styles.muted}>{currentSnapshot.stopReason.summary}</p>
        </section>
      ) : null}

      {currentSnapshot.judge ? (
        <section className={styles.section} aria-labelledby="session-goal-judge-heading">
          <h4 id="session-goal-judge-heading">裁判依据</h4>
          <dl className={styles.details}>
            <dt>模型</dt><dd>{currentSnapshot.judge.model}</dd>
            <dt>结论</dt><dd>{currentSnapshot.judge.verdict}</dd>
            <dt>理由</dt><dd>{currentSnapshot.judge.reason}</dd>
            <dt>缺失项</dt><dd>{currentSnapshot.judge.missing.length ? currentSnapshot.judge.missing.join('、') : '无'}</dd>
          </dl>
        </section>
      ) : null}

      {currentSnapshot.blockage ? (
        <section className={styles.section} aria-labelledby="session-goal-blockage-heading">
          <h4 id="session-goal-blockage-heading">阻塞证据</h4>
          <dl className={styles.details}>
            <dt>连续次数</dt><dd>{currentSnapshot.blockage.count}</dd>
            <dt>摘要</dt><dd>{currentSnapshot.blockage.summary}</dd>
            <dt>指纹</dt><dd>{currentSnapshot.blockage.fingerprint || '—'}</dd>
          </dl>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="session-goal-events-heading">
        <h4 id="session-goal-events-heading">操作记录</h4>
        {loading ? <p className={styles.muted}>正在读取记录…</p> : null}
        {!loading && events.length === 0 ? <p className={styles.muted}>暂无操作记录</p> : null}
        {events.length ? (
          <ol className={styles.timeline}>
            {events.map((event) => (
              <li key={event.id}>
                <div>{event.kind} · r{event.revision}</div>
                <small>{event.createdAt}</small>
                {Object.keys(event.payload).length ? <details className={styles.disclosure}><summary>查看事件数据</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </Drawer>
  );
}
