import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Icon } from '@lobehub/ui';
import { CircleHelp, Pause, PencilLine, Play, Target, Trash2 } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { agentDataApi } from '../../../lib/agentData';
import { pathsEquivalent } from '../../../lib/pathUtils';
import { pi } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../store/session';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';
import { SessionGoalDrawer } from './SessionGoalDrawer';

const styles = createStaticStyles(({ css }) => ({
  pill: css`
    display: flex;
    gap: 8px;
    align-items: center;

    margin-bottom: 8px;
    padding: 5px 6px 5px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
  `,
  paused: css`
    opacity: 0.72;
  `,
  icon: css`
    flex: none;
    color: ${cssVar.colorSuccess};
  `,
  iconWarning: css`
    color: ${cssVar.colorWarning};
  `,
  iconError: css`
    color: ${cssVar.colorError};
  `,
  iconJudging: css`
    color: ${cssVar.colorPrimary};
  `,
  label: css`
    flex: none;
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  text: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rounds: css`
    flex: none;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
  `,
  actions: css`
    display: flex;
    flex: none;
    gap: 2px;
  `,
}));

const statusLabels: Record<GoalSnapshot['status'], string> = {
  active: '执行中',
  paused: '已暂停',
  disarmed: '待恢复',
  judging: '正在验收',
  blocked: '业务阻塞',
  complete: '已完成',
  error: '已停止',
  cleared: '已清除',
};

function iconClass(status: GoalSnapshot['status']): string {
  if (status === 'paused' || status === 'disarmed') return styles.iconWarning;
  if (status === 'blocked' || status === 'error') return styles.iconError;
  if (status === 'judging') return styles.iconJudging;
  return styles.icon;
}

function readSessionId(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSessionFile(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { sessionFile?: unknown }).sessionFile;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 会话输入区里的 Goal 快照。sessionId 由 Pi get_state 提供，path 只用于判断是否存在
 * 真实会话；所有写入都通过 AgentData CAS API，不再拼接 /goal 命令。
 */
export interface GoalPillProps {
  /** MessageEditor owns the in-session drawer; standalone callers keep the local fallback. */
  onOpenDetails?: (snapshot: GoalSnapshot) => void;
}

export const GoalPill = memo(function GoalPill({ onOpenDetails }: GoalPillProps) {
  const { workspace } = useAgentStoreContext();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const [sessionId, setSessionId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const setSnapshot = useGoalStore((s) => s.setSnapshot);
  const snapshot = useGoalStore((s) => (sessionId ? s.bySession[sessionId] : undefined));

  // activeSessionPath 不是 Goal 所有权键。每次切换后重新询问 Pi 的真实 sessionId，
  // 并用 epoch 丢弃旧会话的迟到 get_state/get 响应。
  useEffect(() => {
    const request = ++epoch.current;
    setSessionId(undefined);
    if (!activeSessionPath || !workspace) return;
    void pi
      .getState(workspace)
      .then((state) => {
        if (request !== epoch.current) return;
        const stateSessionFile = readSessionFile(state);
        if (stateSessionFile && !pathsEquivalent(stateSessionFile, activeSessionPath)) return;
        const nextSessionId = readSessionId(state);
        if (!nextSessionId) return;
        setSessionId(nextSessionId);
        return agentDataApi.goals.get(nextSessionId, workspace).then((result) => {
          if (request === epoch.current) setSnapshot(nextSessionId, result);
        });
      })
      .catch(() => {
        // 会话状态暂不可读时保持无 Goal；下次状态事件或切换会话会再次拉取。
      });
    return () => {
      epoch.current++;
    };
  }, [activeSessionPath, workspace, setSnapshot]);

  const update = useCallback(
    async (action: 'pause' | 'resume' | 'clear', payload?: Record<string, unknown>) => {
      if (!snapshot || !sessionId || busy) return;
      setBusy(true);
      try {
        const next = await agentDataApi.goals.update({
          sessionId,
          goalId: snapshot.goalId,
          revision: snapshot.revision,
          action,
          ...(payload ? { payload } : {}),
        });
        setSnapshot(sessionId, next);
      } catch {
        // Mutation errors are surfaced by the AgentData event/toast layer; keep the pill usable.
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, setSnapshot, snapshot],
  );

  const canEdit = !!snapshot && ['active', 'paused', 'blocked', 'disarmed', 'error'].includes(snapshot.status);
  const canClear = !!snapshot && ['active', 'paused', 'blocked', 'disarmed', 'error'].includes(snapshot.status);
  const canToggle = !!snapshot && ['active', 'paused', 'blocked', 'disarmed', 'error'].includes(snapshot.status);

  if (!snapshot || !sessionId) return null;

  const statusText = snapshot.status === 'blocked' && snapshot.blockage
    ? `${statusLabels[snapshot.status]} · ${snapshot.blockage.count} 次`
    : statusLabels[snapshot.status];
  const openDetails = () => {
    if (onOpenDetails) onOpenDetails(snapshot);
    else setDrawerOpen(true);
  };

  return (
    <>
      <div className={cx(styles.pill, snapshot.status === 'paused' && styles.paused)} data-testid="goal-pill">
        <Icon className={iconClass(snapshot.status)} icon={Target} size={14} />
        <span className={styles.label}>{statusText}</span>
        <span className={styles.text} title={snapshot.condition}>{snapshot.condition}</span>
        <span className={styles.rounds}>{snapshot.roundsUsed}/{snapshot.maxRounds}</span>
        <div className={styles.actions}>
          {canEdit ? <ActionIcon {...({ 'aria-label': '修改目标' } as { 'aria-label': string })} disabled={busy} icon={PencilLine} onClick={openDetails} size="small" title="修改目标" /> : null}
          {canToggle ? (
            <ActionIcon
              {...({ 'aria-label': snapshot.status === 'active' ? '暂停目标' : snapshot.status === 'blocked' ? '解除阻塞并恢复' : '恢复目标' } as { 'aria-label': string })}
              disabled={busy}
              icon={snapshot.status === 'active' ? Pause : Play}
              onClick={() => void update(snapshot.status === 'active' ? 'pause' : 'resume')}
              size="small"
              title={snapshot.status === 'active' ? '暂停目标' : snapshot.status === 'blocked' ? '解除阻塞并恢复' : '恢复目标'}
            />
          ) : null}
          <ActionIcon
            {...({ 'aria-label': '查看目标详情' } as { 'aria-label': string })}
            disabled={busy}
            icon={CircleHelp}
            onClick={openDetails}
            size="small"
            title="查看目标详情"
          />
          {canClear ? <ActionIcon {...({ 'aria-label': '清除目标' } as { 'aria-label': string })} disabled={busy} icon={Trash2} onClick={() => { if (window.confirm('清除当前目标？')) void update('clear'); }} size="small" title="清除目标" /> : null}
        </div>
      </div>
      {onOpenDetails ? null : (
        <SessionGoalDrawer
          onClose={() => setDrawerOpen(false)}
          onSnapshot={(next) => setSnapshot(sessionId, next)}
          open={drawerOpen}
          sessionId={sessionId}
          snapshot={snapshot}
        />
      )}
    </>
  );
});
