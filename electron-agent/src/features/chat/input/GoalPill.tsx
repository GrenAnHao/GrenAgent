import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Icon } from '@lobehub/ui';
import { Check, Maximize2, Pause, PencilLine, Play, Trash2, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { pathsEquivalent } from '../../../lib/pathUtils';
import { pi } from '../../../lib/pi';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../store/session';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';
import { SessionGoalDrawer } from './SessionGoalDrawer';
import { dockCard } from './dockCard';
import { formatGoalElapsed } from './goalElapsed';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
  lamp: css`
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  sentence: css`
    flex: none;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  condition: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  elapsed: css`
    flex: none;
    font-size: 13px;
    color: ${cssVar.colorTextQuaternary};
  `,
  actions: css`
    display: flex;
    flex: none;
    gap: 2px;
    margin-left: auto;
  `,
  editor: css`
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;
    min-width: 0;

    input {
      min-width: 0;
      flex: 1;
      padding: 2px 8px;
      border: 1px solid ${cssVar.colorBorder};
      border-radius: ${cssVar.borderRadius};
      color: ${cssVar.colorText};
      background: ${cssVar.colorBgContainer};
      outline: none;
    }
  `,
}));

export interface GoalPillProps {
  /** MessageEditor owns the in-session drawer; standalone callers keep the local fallback. */
  onOpenDetails?: (snapshot: GoalSnapshot) => void;
}

export function readSessionId(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSessionFile(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const value = (state as { sessionFile?: unknown }).sessionFile;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function statusSentence(snapshot: GoalSnapshot): string {
  if (snapshot.status === 'active') {
    return snapshot.activation === 'armed' ? '执行中的目标' : '未运行的目标';
  }
  if (snapshot.status === 'paused') return '已暂停的目标';
  if (snapshot.status === 'blocked') return '受阻的目标';
  return '已完成的目标';
}

function lampAppearance(snapshot: GoalSnapshot): { background: string; boxShadow: string } {
  if (snapshot.status === 'active' && snapshot.activation === 'armed') {
    return { background: '#3dd68c', boxShadow: '0 0 0 3px #3dd68c2e' };
  }
  if (snapshot.status === 'complete') {
    return { background: '#3dd68c', boxShadow: 'none' };
  }
  if (snapshot.status === 'paused') {
    return { background: '#f5a524', boxShadow: 'none' };
  }
  if (snapshot.status === 'blocked') {
    return { background: '#f53f3f', boxShadow: 'none' };
  }
  return { background: '#8b919c', boxShadow: 'none' };
}

function canToggle(snapshot: GoalSnapshot): boolean {
  return snapshot.status === 'active' || snapshot.status === 'paused' || snapshot.status === 'blocked';
}

function canEdit(snapshot: GoalSnapshot): boolean {
  return snapshot.status !== 'complete';
}

function showPause(snapshot: GoalSnapshot): boolean {
  return snapshot.status === 'active' && snapshot.activation === 'armed';
}

function actionProps(label: string) {
  return { 'aria-label': label, title: label } as { 'aria-label': string; title: string };
}

export const GoalPill = memo(function GoalPill({ onOpenDetails }: GoalPillProps) {
  const { workspace } = useAgentStoreContext();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const [sessionId, setSessionId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0);
  const inflight = useRef(false);
  const snapshot = useGoalStore((s) => (sessionId ? s.bySession[sessionId] : undefined));

  useEffect(() => {
    const request = ++epoch.current;
    setSessionId(undefined);
    if (!workspace) return;
    void pi
      .getState(workspace)
      .then((state) => {
        if (request !== epoch.current) return;
        const stateSessionFile = readSessionFile(state);
        if (stateSessionFile && (!activeSessionPath || !pathsEquivalent(stateSessionFile, activeSessionPath))) return;
        const nextSessionId = readSessionId(state);
        if (nextSessionId) setSessionId(nextSessionId);
      })
      .catch(() => {
        // 会话状态暂不可读时保持无 Goal；下次切换会话会再次拉取。
      });
    return () => {
      epoch.current++;
    };
  }, [workspace, activeSessionPath]);

  useEffect(() => {
    setEditing(false);
    setDraft(snapshot?.condition ?? '');
  }, [snapshot?.goalId, snapshot?.condition]);

  useEffect(() => {
    if (!snapshot?.runStartedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.goalId, snapshot?.runStartedAt]);

  const runCommand = useCallback(async (message: string) => {
    if (!workspace || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      await pi.prompt(workspace, message);
    } catch {
      // 动作失败不藏条；扩展回执会说明原因。
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [workspace]);

  const saveEdit = useCallback(() => {
    const condition = draft.trim();
    if (!condition || inflight.current) return;
    setEditing(false);
    void runCommand(`/goal edit ${condition}`);
  }, [draft, runCommand]);

  if (!snapshot || !sessionId) return null;

  const openDetails = () => {
    if (onOpenDetails) onOpenDetails(snapshot);
    else setDrawerOpen(true);
  };

  const rowTitle = snapshot.status === 'blocked' ? snapshot.blockedReason?.message : undefined;
  const lamp = lampAppearance(snapshot);

  return (
    <>
      <div className={dockCard.card}>
      <div className={styles.row} data-testid="goal-pill" title={rowTitle}>
        <span
          className={styles.lamp}
          data-testid="goal-lamp"
          ref={(node) => {
            if (node) node.setAttribute('style', `background: ${lamp.background}; box-shadow: ${lamp.boxShadow};`);
          }}
        />
        {editing ? (
          <div className={styles.editor}>
            <input
              aria-label="目标条件"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveEdit();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                  setDraft(snapshot.condition);
                }
              }}
              value={draft}
            />
            <button
              {...actionProps('保存目标')}
              disabled={busy || !draft.trim()}
              onClick={saveEdit}
              type="button"
            >
              <Icon icon={Check} size={14} />
            </button>
            <button
              {...actionProps('取消编辑')}
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(snapshot.condition);
              }}
              type="button"
            >
              <Icon icon={X} size={14} />
            </button>
          </div>
        ) : (
          <>
            <span className={styles.sentence}>{statusSentence(snapshot)}</span>
            <span className={styles.condition} title={rowTitle ? undefined : snapshot.condition}>
              · {snapshot.condition}
            </span>
            <span className={styles.elapsed}>· {formatGoalElapsed(snapshot.ranMs ?? 0, snapshot.runStartedAt, now)}</span>
            <div className={styles.actions}>
              {canToggle(snapshot) ? (
                <ActionIcon
                  {...actionProps(showPause(snapshot) ? '暂停目标' : '恢复目标')}
                  disabled={busy}
                  icon={showPause(snapshot) ? Pause : Play}
                  onClick={() => void runCommand(showPause(snapshot) ? '/goal pause' : '/goal resume')}
                  size="small"
                />
              ) : null}
              {canEdit(snapshot) ? (
                <ActionIcon
                  {...actionProps('编辑目标')}
                  disabled={busy}
                  icon={PencilLine}
                  onClick={() => {
                    setDraft(snapshot.condition);
                    setEditing(true);
                  }}
                  size="small"
                />
              ) : null}
              <ActionIcon
                {...actionProps('清除目标')}
                disabled={busy}
                icon={Trash2}
                onClick={() => {
                  if (inflight.current || busy) return;
                  if (!window.confirm('清除当前目标？')) return;
                  void runCommand('/goal clear');
                }}
                size="small"
              />
              <ActionIcon
                {...actionProps('展开目标详情')}
                disabled={busy}
                icon={Maximize2}
                onClick={openDetails}
                size="small"
              />
            </div>
          </>
        )}
      </div>
      </div>
      {onOpenDetails ? null : (
        <SessionGoalDrawer
          onClose={() => setDrawerOpen(false)}
          open={drawerOpen}
          sessionId={sessionId}
          snapshot={snapshot}
        />
      )}
    </>
  );
});
