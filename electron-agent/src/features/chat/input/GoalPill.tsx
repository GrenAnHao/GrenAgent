import { memo, useEffect, useRef, useState } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { Button } from 'antd';
import { Check, Maximize2, Pause, PencilLine, Play, RotateCw, Trash2, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { refreshGoalStatus } from '../../extensionUi/goalStatus';
import { sessionControlKey } from '../../../stores/modeStore';
import { useAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../store/session';
import { useGoalStore, type GoalSnapshot } from '../../../stores/goalStore';
import { SessionGoalDrawer } from './SessionGoalDrawer';
import { dockCard } from './dockCard';
import { formatGoalElapsed } from './goalElapsed';
import { goalNeedsRestart, goalPauseLabel } from './goalStatusLabels';
import { controlGoal, useGoalEditor } from './useGoalEditor';
import { useAskConfirm } from '../../../components/askConfirm';

const styles = createStaticStyles(({ css }) => ({
  row: css`display: flex; gap: 8px; align-items: center; min-width: 0;`,
  lamp: css`flex: none; width: 8px; height: 8px; border-radius: 50%;`,
  sentence: css`flex: none; font-size: 13px; font-weight: 500; color: ${cssVar.colorText};`,
  condition: css`overflow: hidden; flex: 1; min-width: 0; font-size: 13px; color: ${cssVar.colorTextSecondary}; text-overflow: ellipsis; white-space: nowrap;`,
  elapsed: css`flex: none; font-size: 13px; color: ${cssVar.colorTextQuaternary};`,
  reason: css`flex: none; max-width: 32%; overflow: hidden; font-size: 12px; color: ${cssVar.colorTextSecondary}; text-overflow: ellipsis; white-space: nowrap;`,
  actions: css`display: flex; flex: none; gap: 2px; margin-left: auto;`,
  editorWrap: css`flex: 1; min-width: 0;`,
  editor: css`
    display: flex; gap: 6px; align-items: center; min-width: 0;
    input {
      min-width: 0; flex: 1; height: 28px; padding: 3px 8px;
      border: 1px solid ${cssVar.colorBorder}; border-radius: ${cssVar.borderRadius};
      color: ${cssVar.colorText}; background: ${cssVar.colorBgContainer}; outline: none;
      &:focus-visible { border-color: ${cssVar.colorPrimary}; box-shadow: 0 0 0 2px ${cssVar.colorPrimaryBg}; }
      &[aria-disabled="true"] { opacity: 0.55; }
    }
  `,
  hint: css`margin: 4px 0 0; font-size: 12px; color: ${cssVar.colorTextSecondary};`,
  warning: css`margin: 4px 0 0; font-size: 12px; color: ${cssVar.colorError};`,
  resolution: css`display: flex; gap: 6px; margin-top: 4px;`,
  compact: css`
    @media (max-width: 500px) {
      .goal-optional { display: none; }
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

function statusSentence(snapshot: GoalSnapshot): string {
  if (snapshot.runtimeUnavailable) return '目标已停止 · 暂停未保存';
  if (snapshot.status === 'active') return snapshot.activation === 'armed' ? '执行中的目标' : '未运行的目标';
  if (snapshot.status === 'paused') return '已暂停的目标';
  if (snapshot.status === 'blocked') return '受阻的目标';
  return '已完成的目标';
}

function lampAppearance(snapshot: GoalSnapshot): { background: string; boxShadow: string } {
  if (snapshot.status === 'active' && snapshot.activation === 'armed' && !snapshot.runtimeUnavailable) {
    return { background: '#3dd68c', boxShadow: '0 0 0 3px #3dd68c2e' };
  }
  if (snapshot.status === 'complete') return { background: '#3dd68c', boxShadow: 'none' };
  if (snapshot.status === 'paused' || snapshot.runtimeUnavailable) return { background: '#f5a524', boxShadow: 'none' };
  if (snapshot.status === 'blocked') return { background: '#f53f3f', boxShadow: 'none' };
  return { background: '#8b919c', boxShadow: 'none' };
}

function actionProps(label: string) {
  return { 'aria-label': label, title: label } as { 'aria-label': string; title: string };
}

export const GoalPill = memo(function GoalPill({ onOpenDetails }: GoalPillProps) {
  const ask = useAskConfirm();
  const { workspace } = useAgentStoreContext();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const sessionId = useGoalStore((s) => (activeSessionPath ? s.sessionIdByPath[sessionControlKey(activeSessionPath)] : undefined));
  const snapshot = useGoalStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const editor = useGoalEditor(workspace, activeSessionPath, snapshot);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);
  const editorInput = useRef<HTMLInputElement>(null);

  useEffect(() => { void refreshGoalStatus(workspace, activeSessionPath); }, [workspace, activeSessionPath]);
  useEffect(() => { setEditing(false); setActionError(''); }, [activeSessionPath, snapshot?.goalId]);
  useEffect(() => {
    if (!snapshot?.runStartedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.goalId, snapshot?.runStartedAt]);

  const runAction = async (action: 'pause' | 'resume' | 'clear', target: GoalSnapshot, path: string) => {
    if (!workspace || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setActionError('');
    try {
      await controlGoal(workspace, path, target, action);
      void refreshGoalStatus(workspace, path);
    } catch (error) {
      if (useSessionStore.getState().activeSessionPath === path) {
        setActionError(error instanceof Error ? error.message : '目标操作未提交，请重新读取。');
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const saveEdit = () => {
    void editor.save().then((done) => {
      if (done) setEditing(false);
      else if (activeSessionPath === useSessionStore.getState().activeSessionPath) editorInput.current?.focus();
    });
  };

  if (!snapshot || !sessionId) return null;
  const reason = goalPauseLabel(snapshot) ?? (snapshot.status === 'blocked' ? snapshot.blockedReason?.message : undefined);
  const paused = snapshot.status === 'active' && snapshot.activation === 'armed' && !snapshot.runtimeUnavailable;
  const restart = goalNeedsRestart(snapshot);
  const lamp = lampAppearance(snapshot);

  return (
    <>
      <div className={dockCard.card} data-cap-layer="" data-dock-card="">
        <div className={`${styles.row} ${styles.compact}`} data-testid="goal-pill" title={reason}>
          <span className={styles.lamp} data-testid="goal-lamp" ref={(node) => { if (node) node.setAttribute('style', `background: ${lamp.background}; box-shadow: ${lamp.boxShadow};`); }} />
          {editing ? (
            <div className={styles.editorWrap}>
              <div className={styles.editor}>
                <input
                  ref={editorInput}
                  aria-label="目标条件"
                  aria-disabled={editor.busy}
                  readOnly={editor.busy}
                  maxLength={4000}
                  onChange={(event) => editor.setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (editor.busy) return;
                    if (event.key === 'Enter') { event.preventDefault(); saveEdit(); }
                    if (event.key === 'Escape') { event.preventDefault(); editor.loadLatest(); setEditing(false); }
                  }}
                  value={editor.draft}
                />
                <ActionIcon {...actionProps('保存目标')} disabled={editor.busy || editor.conflict || !editor.draft.trim() || !editor.dirty} icon={Check} onClick={saveEdit} size="small" />
                <ActionIcon {...actionProps('取消编辑')} disabled={editor.busy} icon={X} onClick={() => { editor.loadLatest(); setEditing(false); }} size="small" />
              </div>
              {editor.busy ? <p className={styles.hint}>正在保存…</p> : null}
              {editor.error ? <p role="alert" className={styles.warning}>{editor.error}</p> : null}
              {editor.conflict ? <div className={styles.resolution}><Button size="small" type="text" onClick={editor.loadLatest}>载入最新版</Button><Button size="small" type="text" onClick={editor.rebase}>基于最新版提交</Button></div> : null}
            </div>
          ) : (
            <>
              <span className={styles.sentence}>{statusSentence(snapshot)}</span>
              <span className={`${styles.condition} goal-optional`} title={reason ? undefined : snapshot.condition}>· {snapshot.condition}</span>
              <span className={`${styles.elapsed} goal-optional`}>· {formatGoalElapsed(snapshot.ranMs ?? 0, snapshot.runStartedAt, now)}</span>
              {reason ? <span className={`${styles.reason} goal-optional`} data-testid="goal-reason" title={reason}>· {reason}</span> : null}
              <div className={styles.actions}>
                {snapshot.runtimeUnavailable ? (
                  <ActionIcon {...actionProps('重新读取目标状态')} disabled={busy} icon={RotateCw} onClick={() => void refreshGoalStatus(workspace, activeSessionPath)} size="small" />
                ) : snapshot.status !== 'complete' ? (
                  <ActionIcon {...actionProps(paused ? '暂停目标' : restart ? '开启新批次' : '恢复目标')} disabled={busy} icon={paused ? Pause : Play} onClick={() => { if (activeSessionPath) void runAction(paused ? 'pause' : 'resume', snapshot, activeSessionPath); }} size="small" />
                ) : null}
                {snapshot.status !== 'complete' ? (
                  <ActionIcon {...actionProps('编辑目标')} disabled={busy} icon={PencilLine} onClick={() => { editor.loadLatest(); setEditing(true); }} size="small" />
                ) : null}
                <ActionIcon {...actionProps('清除目标')} disabled={busy} icon={Trash2} onClick={() => {
                  if (inflight.current || busy || !activeSessionPath) return;
                  const path = activeSessionPath;
                  void (async () => { if (await ask({ title: '清除当前目标？' })) void runAction('clear', snapshot, path); })();
                }} size="small" />
                <ActionIcon {...actionProps('展开目标详情')} disabled={busy} icon={Maximize2} onClick={() => { if (onOpenDetails) onOpenDetails(snapshot); else setDrawerOpen(true); }} size="small" />
              </div>
            </>
          )}
        </div>
        {actionError ? <p role="alert" className={styles.warning}>{actionError}</p> : null}
      </div>
      {onOpenDetails ? null : <SessionGoalDrawer onClose={() => setDrawerOpen(false)} open={drawerOpen} sessionId={sessionId} sessionPath={activeSessionPath} snapshot={snapshot} />}
    </>
  );
});
