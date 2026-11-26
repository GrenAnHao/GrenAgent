import { App } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { MainChatColumn } from '../../src/features/layout/MainChatColumn';
import { Sidebar } from '../../src/features/sessions/Sidebar';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import { agentStoreRegistry, useAgentRegistryStore } from '../../src/stores/agentStoreRegistry';
import { applyEvent, initialAgentState } from '../../src/stores/agentReducer';
import { restoreRunningTurns } from '../../src/stores/restoreRunningTurns';
import { startRunningSessionTracking } from '../../src/stores/runningSessions';
import { useSessionStore } from '../../src/store/session';
import type { AgentEvent, PiEventEnvelope, SessionInfo } from '../../src/lib/pi';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

// localStorage is the harness's still-alive host I/O stub, NOT product persistence of compacting=true.
// An actual webContents.reload destroys every renderer store; only the fake host snapshot survives.
const HOST_KEY = 'ui-harness:session-compaction:host';
const RELOAD_MARKER = 'ui-harness:session-compaction:reload';
const WORKSPACE = 'D:/workbench';
const A: SessionInfo = { id: 'layout-a', path: 'D:/sessions/layout-a.jsonl', cwd: WORKSPACE, timestamp: '2026-10-29T08:00:00.000Z', name: '整理发布计划' };
const B: SessionInfo = { id: 'layout-b', path: 'D:/sessions/layout-b.jsonl', cwd: WORKSPACE, timestamp: '2026-10-28T08:00:00.000Z', name: '检查登录流程' };
const model = { provider: 'fixture', id: 'workbench-model', name: 'Workbench Model', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 };
type Activity = { ownerEpoch: string; operationId: string; phase: 'preparing' | 'running'; startedAt: number; sequence: number };
type Host = { activity: Activity | null; usage: Record<string, number>; revision: Record<string, number> };
// renderer 重载会销毁全部 store；这里的宿主快照必须跨 reload 存活，才能验证“向仍存活的宿主读取”。
let holdStatsPath: string | null = null;
let heldStats: { path: string; resolve: () => void } | null = null;
if (sessionStorage.getItem(RELOAD_MARKER) !== 'yes') localStorage.removeItem(HOST_KEY);
const host: Host = JSON.parse(localStorage.getItem(HOST_KEY) || 'null') ?? {
  activity: null, usage: { [A.path]: 850, [B.path]: 460 }, revision: { [A.path]: 0, [B.path]: 0 },
};
const persist = () => localStorage.setItem(HOST_KEY, JSON.stringify(host));
const listeners = new Map<string, Set<(envelope: { payload: unknown }) => void>>();
function emit(event: AgentEvent, path = A.path): void {
  const payload: PiEventEnvelope = { workspace: WORKSPACE, sessionPath: path, source: 'interactive', event };
  for (const listener of listeners.get('pi://event') ?? []) listener({ payload });
}
const stats = (path: string) => {
  const tokens = host.usage[path] ?? 0;
  track(`stats:${path}:${host.revision[path] ?? 0}:${tokens}`);
  return { sessionId: path === A.path ? A.id : B.id, sessionPath: path, ownerEpoch: 'host-layout',
    contextRevision: host.revision[path] ?? 0, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
    tokens: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, total: 550 }, cost: 0,
    contextUsage: { tokens, contextWindow: 1000, percent: tokens / 10 } };
};
installBridge({
  subscribe: async (channel: string, listener: (env: { payload: unknown }) => void) => {
    const group = listeners.get(channel) ?? new Set(); group.add(listener); listeners.set(channel, group);
    return () => group.delete(listener);
  },
  webview: { onDragDropEvent: async () => () => {} },
  window: { isMaximized: async () => false, onResized: async () => () => {}, minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    const path = typeof args.targetSessionPath === 'string' ? args.targetSessionPath : A.path;
    switch (command) {
      case 'warm_workspace': case 'enhance_prompt_abort': return undefined;
      case 'agent_abort': track(`agent-abort:${path}`); return { stopped: true, aborted: true };
      case 'agent_take_steering': return { steering: [] };
      case 'get_settings': return { defaultSessionModel: 'fixture/workbench-model' };
      case 'get_provider_config': return { modelsJson: JSON.stringify({ providers: { fixture: { name: 'Fixture', api: 'openai-responses', apiKey: 'fixture', models: [model] } } }), authJson: '{}', agentDir: 'C:/agent' };
      case 'agent_get_available_models': case 'list_models_global': return { models: [model] };
      case 'get_model_fast_preferences': return {};
      case 'agent_get_session_defaults': return { revision: 0, model: { provider: model.provider, id: model.id }, thinkingLevel: 'high', mode: 'agent', approval: 'ask' };
      case 'agent_get_state': return { sessionFile: path, sessionId: path === A.path ? A.id : B.id, isStreaming: false,
        isCompacting: path === A.path && Boolean(host.activity), compaction: path === A.path ? host.activity : null,
        contextRevision: host.revision[path] ?? 0, model, thinkingLevel: 'high' };
      case 'agent_get_session_stats': {
        const response = stats(path);
        if (holdStatsPath === path) {
          holdStatsPath = null;
          track(`stats-held:${path}:${response.contextRevision}:${response.contextUsage.tokens}`);
          return new Promise((resolve) => { heldStats = { path, resolve: () => resolve(response) }; });
        }
        return response;
      }
      case 'agent_list_running_turns': {
        track('snapshot:host-after-reload');
        return host.activity ? [{ workspace: WORKSPACE, sessionId: A.id, sessionPath: A.path, isStreaming: false,
          isCompacting: true, compaction: host.activity, contextRevision: host.revision[A.path] }] : [];
      }
      case 'agent_get_messages': return { messages: [] };
      case 'get_git_branches': return { current: 'main', branches: [{ name: 'main', current: true }] };
      case 'get_git_status': case 'subagent_list': return [];
      case 'get_file_tree': return { name: 'workbench', path: WORKSPACE, kind: 'directory', children: [] };
      case 'agent_get_commands': return { commands: [] };
      case 'list_prompt_commands': return [];
      default: throw new Error(`unstubbed invoke: ${command}`);
    }
  },
});
startRunningSessionTracking();
useSessionStore.setState({ activeWorkspace: WORKSPACE, activeSessionPath: A.path, allSessions: [A, B], registeredProjects: [WORKSPACE], isLoading: false, allSessionsLoading: false });
const store = agentStoreRegistry.getOrCreate(WORKSPACE);
store.bindSessionPath(A.path);
agentStoreRegistry.setActive(WORKSPACE);
const assistant = { role: 'assistant', timestamp: 1793260800000, content: [{ type: 'text', text: '工作台检查完成。' }] };
function conversation(): void {
  let state = initialAgentState();
  for (const event of [{ type: 'message_start', message: assistant }, { type: 'message_end', message: assistant }, { type: 'agent_end', messages: [assistant] }]) {
    state = applyEvent(state, event as unknown as AgentEvent);
  }
  store.useStore.setState(state, true);
}
function fixtureEvent(event: AgentEvent, path = A.path): void {
  track(`fixture-event:${event.type}`);
  if (path === A.path) {
    if (event.type === 'compaction_activity' || event.type === 'compaction_start') host.activity = (event as { compaction: Activity }).compaction;
    if (event.type === 'compaction_end') {
      host.activity = null;
      const ended = event as { contextRevision?: number; aborted?: boolean };
      if (!ended.aborted && ended.contextRevision !== undefined) host.revision[A.path] = ended.contextRevision;
    }
    persist();
  }
  emit(event, path);
}
exposeData({ sessionA: A.path, sessionB: B.path });
exposeActions({
  conversation,
  compactionFixture: fixtureEvent,
  compactionUnconfirmedFixture: () => store.useStore.setState({ compactionUnconfirmed: true }),
  compactUsageFixture: (tokens: number) => { host.usage[A.path] = tokens; persist(); },
  compactionStartedAt: () => store.useStore.getState().compaction?.startedAt ?? null,
  holdNextStats: (path: string) => { holdStatsPath = path; track(`hold-stats:${path}`); },
  releaseHeldStats: () => { const current = heldStats; heldStats = null; current?.resolve(); track('release-held-stats'); return current?.path ?? null; },
  statsHoldState: () => ({ held: heldStats != null, path: heldStats?.path ?? holdStatsPath }),
  switchFixtureSession: (path: string) => {
    const sessions = useSessionStore.getState();
    const previous = sessions.activeSessionPath;
    sessions.setActiveSession(path);
    store.showCachedSession(path, previous);
    // B 需要一份完整历史，用量入口才会出现；走真实 loadMessages 让 viewHasHistory 正常。
    if (path === B.path && store.useStore.getState().messages.length === 0) {
      store.loadMessages([{ role: 'assistant', timestamp: 1793260800000, content: [{ type: 'text', text: '登录流程检查完成。' }] }] as never,
        { sessionPath: B.path, force: true });
    }
  },
  backgroundCompleteFixture: (revision: number, tokens: number) => {
    host.usage[A.path] = tokens;
    fixtureEvent({ type: 'compaction_end', aborted: false, contextRevision: revision,
      ownerEpoch: 'host-layout', compaction: { ...host.activity!, phase: 'running', sequence: host.activity!.sequence + 1 } } as never, A.path);
  },
  preserveHostForReload: () => { sessionStorage.setItem(RELOAD_MARKER, 'yes'); persist(); },
  compactionAutoHandoffFixture: () => {
    const compaction: Activity = { ownerEpoch: 'host-layout', operationId: 'policy-auto-1', phase: 'preparing', startedAt: 2000, sequence: 4 };
    fixtureEvent({ type: 'compaction_activity', compaction } as never);
    setTimeout(() => fixtureEvent({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' },
      internalAbort: { origin: 'policy-auto', operationId: compaction.operationId } } as never), 25);
    setTimeout(() => fixtureEvent({ type: 'compaction_start', compaction: { ...compaction, phase: 'running', sequence: 5 } } as never), 160);
  },
});

export default function SessionCompactionScenario(): ReactElement {
  const [ready, setReady] = useState(false);
  const running = useAgentRegistryStore(s => s.runningSessionPaths);
  useEffect(() => {
    if (sessionStorage.getItem(RELOAD_MARKER) === 'yes') {
      // A fresh renderer restores only the host's authoritative activity snapshot.
      conversation();
      void restoreRunningTurns().then(() => setReady(true));
    } else setReady(true);
    return () => agentStoreRegistry.release(WORKSPACE);
  }, []);
  if (!ready) return <div />;
  return <App style={{ height: '100vh' }}>
    <AgentStoreContext.Provider value={{ workspace: WORKSPACE, store, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true }}>
      <div data-testid="workbench-layout" style={{ display: 'flex', height: '100%', background: 'var(--gren-content-bg)' }}>
        <aside style={{ width: 260, flexShrink: 0 }}><Sidebar runningSessionPaths={new Set(running)} onNewConversation={() => {}} onOpenProject={() => {}} onNewSession={() => {}}
          onOpenSession={(_cwd, path) => { useSessionStore.getState().setActiveSession(path); store.showCachedSession(path); }} onDeleteSession={() => {}} onDeleteConversation={() => {}}
          onClearProjectSessions={() => {}} onRemoveProject={() => {}} onSubmitRename={() => {}} /></aside>
        <main data-testid="workbench-main" style={{ flex: 1, minWidth: 0, minHeight: 0 }}><MainChatColumn /></main>
      </div>
    </AgentStoreContext.Provider>
  </App>;
}
