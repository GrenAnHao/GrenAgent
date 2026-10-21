import { useMemo } from 'react';
import { create } from 'zustand';
import { onPiEvent, onWindowFocus, pi, type AgentMessage, type PiEventEnvelope } from '../lib/pi';
import { visibleSessions } from '../lib/mergeSessions';
import { useSessionStore } from '../store/session';
import { assistantStopFromMessages } from './agentReducer';
import { derivePending, type PendingEntry } from './attentionPending';
import {
  attentionTooltip,
  resolveRowStatus,
  summarizeGroup,
  type AttentionKind,
  type RowStatusKind,
  type SessionAttentionState,
  type UnreadEntry,
} from './attentionView';
import { listStashedUiRequests, useStashedUiRequestsVersion } from './backgroundUiRequests';
import { useGoalStore, type GoalStoreState } from './goalStore';
import { useInlineQuestionStore } from './inlineQuestionStore';
import { sessionControlKey } from './modeStore';
import { useUiPromptStore, type UiPromptItem } from './uiPromptStore';
import { useVisualStore } from './visualStore';

/**
 * 侧栏角标、应用内提示、系统通知共用的「会话注意状态」。键一律是 sessionControlKey。
 *
 * - 未读（完成 / 失败 / Goal 受阻）由 pi 事件和 Goal 快照写入，打开会话（在画面上且窗口在前台）时清掉。
 * - 等待中的请求（审批 / 选择）不单独记账，从 uiPromptStore、inlineQuestionStore、visualStore 和后台暂存派生。
 *
 * 规格见 .agents/notes/（会话注意状态：侧栏角标、应用内提示、系统通知与任务栏）。
 */

/** 回合结束后等这么久没有新一轮才算完成：Goal 续跑和排队消息会在 agent_settled 之后马上开下一轮。 */
export const DONE_GRACE_MS = 1500;

export interface AttentionStoreState {
  unread: Record<string, UnreadEntry>;
  pending: Record<string, PendingEntry>;
  /** 主窗口是否在前台。以主进程为准，启动时先当作在前台。 */
  focused: boolean;
  /** 窗口在前台时当前会话的键；窗口在后台时为 undefined。 */
  visibleKey?: string;
}

const initialState = (): AttentionStoreState => ({ unread: {}, pending: {}, focused: true });

export const useAttentionStore = create<AttentionStoreState>(initialState);

interface RoundState {
  path: string;
  workspace: string;
  awaitingDone: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const rounds = new Map<string, RoundState>();
/** 上一次快照里处于 blocked 的 Goal sessionId：只在「变成 blocked」那一刻记未读。 */
const blockedGoals = new Set<string>();

function keyOf(path: string): string {
  return sessionControlKey(path);
}

function activeKey(): string | undefined {
  const active = useSessionStore.getState().activeSessionPath;
  return active ? keyOf(active) : undefined;
}

export function isSessionVisible(path: string): boolean {
  if (!useAttentionStore.getState().focused) return false;
  return activeKey() === keyOf(path);
}

function updateUnread(key: string, base: { path: string; workspace: string }, change: (entry: UnreadEntry) => UnreadEntry): void {
  useAttentionStore.setState((s) => {
    const prev = s.unread[key] ?? { path: base.path, workspace: base.workspace };
    const next = change(prev);
    const unread = { ...s.unread };
    if (next.outcome || next.blocked) unread[key] = next;
    else if (s.unread[key]) delete unread[key];
    else return s;
    return { unread };
  });
}

function dropFields(key: string, fields: Array<'outcome' | 'blocked'>, onlyDone = false): void {
  const prev = useAttentionStore.getState().unread[key];
  if (!prev) return;
  updateUnread(key, prev, (entry) => {
    const next = { ...entry };
    for (const field of fields) {
      if (field === 'outcome' && onlyDone && entry.outcome?.kind !== 'done') continue;
      delete next[field];
    }
    return next;
  });
}

function lastAssistantError(messages: readonly AgentMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const raw = message.errorMessage;
    return typeof raw === 'string' && raw.trim() ? raw : undefined;
  }
  return undefined;
}

function writeOutcome(key: string, round: RoundState, kind: 'done' | 'failed', message?: string): void {
  if (isSessionVisible(round.path)) return;
  updateUnread(key, round, (entry) => ({
    ...entry,
    path: round.path,
    workspace: round.workspace,
    outcome: { kind, ...(message ? { message } : {}), seq: (entry.outcome?.seq ?? 0) + 1 },
  }));
}

function armDone(key: string, round: RoundState): void {
  if (round.timer) clearTimeout(round.timer);
  round.timer = setTimeout(() => {
    round.timer = undefined;
    if (!round.awaitingDone) return;
    round.awaitingDone = false;
    writeOutcome(key, round, 'done');
  }, DONE_GRACE_MS);
}

export function handleAttentionEvent(env: PiEventEnvelope): void {
  if (env.source === 'goal' || env.source === 'subagent') return;
  const path = typeof env.sessionPath === 'string' && env.sessionPath ? env.sessionPath : undefined;
  if (!path) return;
  const event = env.event as { type?: string; willRetry?: boolean; messages?: AgentMessage[] };
  // 流式事件一秒几百条，只看三种生命周期事件。
  if (event.type !== 'agent_start' && event.type !== 'agent_end' && event.type !== 'agent_settled') return;
  const key = keyOf(path);
  const round = rounds.get(key) ?? { path, workspace: env.workspace, awaitingDone: false };
  round.path = path;
  round.workspace = env.workspace;
  rounds.set(key, round);

  switch (event.type) {
    case 'agent_start':
      if (round.timer) clearTimeout(round.timer);
      round.timer = undefined;
      round.awaitingDone = false;
      dropFields(key, ['outcome'], true);
      return;
    case 'agent_end': {
      if (event.willRetry === true) return;
      const stop = assistantStopFromMessages(event.messages);
      if (stop === 'error') {
        round.awaitingDone = false;
        if (round.timer) clearTimeout(round.timer);
        round.timer = undefined;
        writeOutcome(key, round, 'failed', lastAssistantError(event.messages));
      } else if (stop === 'stop') {
        round.awaitingDone = true;
        armDone(key, round);
      }
      return;
    }
    case 'agent_settled':
      if (round.awaitingDone) armDone(key, round);
      return;
  }
}

function sessionByKey(key: string): { path: string; workspace: string } | undefined {
  const found = useSessionStore.getState().getMergedSessions().find((s) => keyOf(s.path) === key);
  return found?.cwd ? { path: found.path, workspace: found.cwd } : undefined;
}

/**
 * 从提示 / 系统通知打开会话时用列表里的写法：侧栏按路径严格相等判断当前行，事件里的写法（大小写 / 分隔符）可能不同。
 * 列表里没有就原样返回。
 */
export function resolveSessionTarget(workspace: string, path: string): { workspace: string; path: string } {
  return sessionByKey(keyOf(path)) ?? { workspace, path };
}

export function applyGoalState(state: Pick<GoalStoreState, 'bySession' | 'sessionIdByPath'>): void {
  const keyBySessionId = new Map<string, string>();
  for (const [key, sessionId] of Object.entries(state.sessionIdByPath)) keyBySessionId.set(sessionId, key);

  const nowBlocked = new Set<string>();
  for (const [sessionId, snapshot] of Object.entries(state.bySession)) {
    if (snapshot.status !== 'blocked') continue;
    nowBlocked.add(sessionId);
    if (blockedGoals.has(sessionId)) continue;
    const key = keyBySessionId.get(sessionId);
    const target = key ? sessionByKey(key) : undefined;
    // 还对不上会话（没绑定路径、会话还没进列表）时不算「已经处理过这次受阻」，下次再试。
    if (!key || !target) {
      nowBlocked.delete(sessionId);
      continue;
    }
    if (isSessionVisible(target.path)) continue;
    const message = snapshot.blockedReason?.message;
    updateUnread(key, target, (entry) => ({ ...entry, blocked: message ? { message } : {} }));
  }
  for (const sessionId of blockedGoals) {
    if (nowBlocked.has(sessionId)) continue;
    const key = keyBySessionId.get(sessionId);
    if (key) dropFields(key, ['blocked']);
  }
  blockedGoals.clear();
  for (const sessionId of nowBlocked) blockedGoals.add(sessionId);
}

function flattenPrompts(): UiPromptItem[] {
  const { byWorkspace, waiting } = useUiPromptStore.getState();
  const workspaces = new Set([...Object.keys(byWorkspace), ...Object.keys(waiting)]);
  const out: UiPromptItem[] = [];
  for (const workspace of workspaces) {
    const head = byWorkspace[workspace];
    if (head) out.push(head);
    out.push(...(waiting[workspace] ?? []));
  }
  return out;
}

export function recomputePending(): void {
  const next = derivePending({
    prompts: flattenPrompts(),
    inline: Object.values(useInlineQuestionStore.getState().byWorkspace),
    visual: Object.values(useVisualStore.getState().entries),
    stashed: listStashedUiRequests(),
    ownerOf: (workspace) => useSessionStore.getState().workspaceSessionPaths[workspace] || undefined,
  });
  const prev = useAttentionStore.getState().pending;
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  useAttentionStore.setState({ pending: next });
}

export function syncVisibility(): void {
  const s = useAttentionStore.getState();
  const visibleKey = s.focused ? activeKey() : undefined;
  if (visibleKey !== s.visibleKey) useAttentionStore.setState({ visibleKey });
  if (visibleKey && useAttentionStore.getState().unread[visibleKey]) {
    useAttentionStore.setState((cur) => {
      const unread = { ...cur.unread };
      delete unread[visibleKey];
      return { unread };
    });
  }
}

export function setWindowFocused(focused: boolean): void {
  if (useAttentionStore.getState().focused !== focused) useAttentionStore.setState({ focused });
  syncVisibility();
}

/** 会话被删：它的未读和还没到点的完成计时都丢掉，任务栏数字不会一直挂着。 */
export function forgetSessionAttention(path: string): void {
  const key = keyOf(path);
  const round = rounds.get(key);
  if (round?.timer) clearTimeout(round.timer);
  rounds.delete(key);
  if (!useAttentionStore.getState().unread[key]) return;
  useAttentionStore.setState((s) => {
    const unread = { ...s.unread };
    delete unread[key];
    return { unread };
  });
}

export function sessionStateOf(s: AttentionStoreState, path: string): SessionAttentionState | undefined {
  const key = keyOf(path);
  const pending = s.pending[key];
  const unread = s.unread[key];
  if (!pending && !unread) return undefined;
  return { ...(pending ? { pending } : {}), ...(unread ? { unread } : {}) };
}

export function sessionStates(s: AttentionStoreState): Array<[string, SessionAttentionState]> {
  const keys = new Set([...Object.keys(s.pending), ...Object.keys(s.unread)]);
  return [...keys].map((key) => [key, { ...(s.pending[key] ? { pending: s.pending[key] } : {}), ...(s.unread[key] ? { unread: s.unread[key] } : {}) }]);
}

/** 侧栏里看得见的会话的键：归档的、乐观删除中的不算，任务栏数字只数它们。 */
export function listedSessionKeys(): Set<string> {
  const st = useSessionStore.getState();
  return new Set(visibleSessions(st.allSessions, st.optimisticSessions, st.deletedSessionPaths).map((s) => keyOf(s.path)));
}

let started = false;

/** App 挂载时调一次。重复调用无副作用。 */
export function startSessionAttention(): void {
  if (started) return;
  started = true;
  void onPiEvent(handleAttentionEvent);
  void onWindowFocus((e) => setWindowFocused(Boolean(e.focused)));
  void pi
    .attentionWindowFocused()
    .then((focused) => setWindowFocused(Boolean(focused)))
    .catch(() => {});
  useSessionStore.subscribe((s, prev) => {
    if (s.activeSessionPath !== prev.activeSessionPath) syncVisibility();
    if (s.workspaceSessionPaths !== prev.workspaceSessionPaths) recomputePending();
    // Goal 受阻可能先于会话进列表到达，列表变了再对一次。
    if (s.allSessions !== prev.allSessions || s.optimisticSessions !== prev.optimisticSessions) {
      applyGoalState(useGoalStore.getState());
    }
  });
  useGoalStore.subscribe((s) => applyGoalState(s));
  useUiPromptStore.subscribe(() => recomputePending());
  useInlineQuestionStore.subscribe(() => recomputePending());
  useVisualStore.subscribe(() => recomputePending());
  useStashedUiRequestsVersion.subscribe(() => recomputePending());
  syncVisibility();
  recomputePending();
  applyGoalState(useGoalStore.getState());
}

export function resetSessionAttentionForTest(): void {
  for (const round of rounds.values()) if (round.timer) clearTimeout(round.timer);
  rounds.clear();
  blockedGoals.clear();
  useAttentionStore.setState(initialState(), true);
}

/** 会话行：返回要画的角标；运行中的转圈压过它时返回 undefined，由行自己画转圈。 */
export function useSessionAttention(path: string, running: boolean): { kind: AttentionKind; tooltip: string } | undefined {
  const kind = useAttentionStore((s) => {
    const resolved = resolveRowStatus(sessionStateOf(s, path), running);
    return resolved && resolved !== 'running' ? resolved : undefined;
  });
  const tooltip = useAttentionStore((s) => (kind ? attentionTooltip(kind, sessionStateOf(s, path) ?? {}) : undefined));
  return useMemo(() => (kind && tooltip ? { kind, tooltip } : undefined), [kind, tooltip]);
}

/** 折叠的项目分组头：组里最高优先级的状态和需要处理的会话数。enabled 为 false（展开）时不算。 */
export function useGroupAttention(
  paths: readonly string[],
  running: ReadonlySet<string>,
  enabled: boolean,
): { kind: RowStatusKind; count: number } | undefined {
  const signature = useAttentionStore((s) => {
    if (!enabled) return '';
    const summary = summarizeGroup(paths.map((path) => ({ state: sessionStateOf(s, path), running: running.has(path) })));
    return summary ? `${summary.kind}|${summary.count}` : '';
  });
  return useMemo(() => {
    if (!signature) return undefined;
    const [kind, count] = signature.split('|');
    return { kind: kind as RowStatusKind, count: Number(count) };
  }, [signature]);
}
