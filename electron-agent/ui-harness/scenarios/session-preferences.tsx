import { useState } from 'react';
import { App } from 'antd';
import ModelThinkingAction from '../../src/features/chat/input/actions/ModelThinkingAction';
import ModeAction from '../../src/features/chat/input/actions/ModeAction';
import ApprovalAction from '../../src/features/chat/input/actions/ApprovalAction';
import { ContextToolGroup } from '../../src/features/tools/ContextToolGroup';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import type { AgentStoreApi } from '../../src/stores/agent';
import { initialAgentState } from '../../src/stores/agentReducer';
import { useSessionStore } from '../../src/store/session';
import { enterPendingNewSession } from '../../src/lib/pendingSession';
import { useSessionPreferencesStore } from '../../src/stores/sessionPreferencesStore';
import { useSessionViewStateStore } from '../../src/stores/sessionViewStateStore';
import type { SessionPreferences } from '../../src/lib/sessionPreferences';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

const WS = '/session-preferences';
const A = `${WS}/a.jsonl`;
const B = `${WS}/b.jsonl`;
const models = [
  { provider: 'relay', id: 'reason', name: 'Reasoning', api: 'openai-responses', reasoning: true, input: ['text'], fast: true, thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high' } },
  { provider: 'relay', id: 'plain', name: 'Plain', api: 'openai-responses', reasoning: false, input: ['text'], fast: false },
];
const DISK_KEY = 'session-preferences-fixture-host';
const initial = {
  sessions: {
    // Fast 是第五项会话偏好：同项目同模型的 A 开 / B 关，互不影响。
    [A]: { revision: 1, model: { provider: 'relay', id: 'reason' }, thinkingLevel: 'high', mode: 'agent', approval: 'ask', fastMode: true },
    [B]: { revision: 1, model: { provider: 'relay', id: 'reason' }, thinkingLevel: 'low', mode: 'ultra', approval: 'workspace', fastMode: false },
  } as Record<string, SessionPreferences>,
  // 项目默认没显式写 Fast：新草稿按关闭初始化，不继承任何会话的最近选择。
  defaults: { revision: 0, model: { provider: 'relay', id: 'reason' }, thinkingLevel: 'medium', mode: 'agent', approval: 'auto' } as SessionPreferences,
};
const freshWindow = sessionStorage.getItem(DISK_KEY) !== 'active';
let disk: typeof initial;
try { disk = freshWindow ? structuredClone(initial) : JSON.parse(localStorage.getItem(DISK_KEY) || 'null') || structuredClone(initial); }
catch { disk = structuredClone(initial); }
sessionStorage.setItem(DISK_KEY, 'active');
const persistHost = () => localStorage.setItem(DISK_KEY, JSON.stringify(disk));
persistHost();
if (freshWindow) {
  useSessionViewStateStore.getState().setExpanded(A, 'context:same-call', false);
  useSessionViewStateStore.getState().setExpanded(B, 'context:same-call', false);
}
let planUnconfirmed = false;
const stateOf = (path: string) => {
  const preferences = disk.sessions[path];
  if (!preferences) throw new Error('Unknown fixture session');
  const model = models.find((m) => m.provider === preferences.model?.provider && m.id === preferences.model.id);
  return { sessionFile: path, sessionPath: path, sessionId: path === A ? 'a' : 'b', preferences: structuredClone(preferences), model, thinkingLevel: model?.reasoning ? preferences.thinkingLevel : 'off', unavailable: [] };
};

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_settings': return { defaultSessionModel: 'relay/reason' };
      case 'get_provider_config': return { modelsJson: JSON.stringify({ providers: { relay: { name: 'Relay', api: 'openai-responses', apiKey: 'fixture', models: models.map(({ provider: _provider, ...m }) => m) } } }), authJson: '{}', agentDir: '/agent' };
      case 'agent_get_available_models': case 'list_models_global': return { models };
      case 'get_model_fast_preferences': return {};
      case 'agent_get_session_defaults': return structuredClone(disk.defaults);
      case 'agent_set_session_defaults':
        disk.defaults = { ...(args.preferences as SessionPreferences), revision: 0 };
        persistHost(); track('save-defaults');
        return structuredClone(disk.defaults);
      case 'agent_get_state': return stateOf(String(args.targetSessionPath || A));
      case 'agent_set_fast_mode': {
        const path = String(args.targetSessionPath || '');
        if (!disk.sessions[path]) throw new Error('Fast writes require their original session path');
        // 显式保留 false：host 回执也要把关闭值带回来。
        disk.sessions[path] = { ...disk.sessions[path], fastMode: args.enabled === true, revision: disk.sessions[path].revision + 1 };
        persistHost(); track(`write:${path === A ? 'a' : 'b'}:fastMode`);
        return { ok: true, ...stateOf(path), applied: ['fastMode'], unavailable: [] };
      }
      case 'agent_set_model': case 'agent_set_thinking_level': case 'agent_set_mode': case 'agent_set_approval': {
        const path = String(args.targetSessionPath || '');
        if (!disk.sessions[path]) throw new Error('Preference writes require their original session path');
        const previous = disk.sessions[path];
        if (command === 'agent_set_mode' && path === A && planUnconfirmed && ['agent', 'debug', 'ultra'].includes(String(args.mode))) {
          return { ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'plan', message: '当前有未确认的计划，请在计划面板确认执行。' };
        }
        const field = command === 'agent_set_model' ? 'model' : command === 'agent_set_thinking_level' ? 'thinkingLevel' : command === 'agent_set_mode' ? 'mode' : 'approval';
        const value = field === 'model' ? { provider: String(args.provider), id: String(args.modelId) } : field === 'mode' ? args.mode : args.level;
        disk.sessions[path] = { ...previous, [field]: value, revision: previous.revision + 1 };
        persistHost(); track(`write:${path === A ? 'a' : 'b'}:${field}`);
        return { ok: true, ...stateOf(path), applied: [field], unavailable: [] };
      }
      default: throw new Error(`unstubbed invoke: ${command}`);
    }
  },
});
useSessionStore.setState({ activeWorkspace: WS, activeSessionPath: A, draftConversationCwd: null, draftConversationId: null });

const agentState = initialAgentState();
const useStore = Object.assign((selector: (state: typeof agentState) => unknown) => selector(agentState), {
  getState: () => agentState,
  subscribe: () => () => {},
  setState: () => {},
});
const placeholder = { useStore, getLoadedSessionPath: () => useSessionStore.getState().activeSessionPath } as unknown as AgentStoreApi;

function Pane({ owner, side }: { owner: string; side: 'left' | 'right' }) {
  const draft = owner.startsWith('draft:');
  return <AgentStoreContext.Provider value={{ workspace: WS, store: placeholder, workspaceReady: true, setWorkspaceReady: () => {}, appBooted: true, ...(draft ? { sessionPath: null, draftId: owner } : { sessionPath: owner }) }}>
    <section data-testid={`pane-${side}`} style={{ flex: 1, minWidth: 0, padding: 20, border: '1px solid var(--ant-color-border)', borderRadius: 10 }}>
      <div style={{ marginBottom: 20 }}>{side === 'left' ? '当前视图' : '同时打开的会话 B'}</div>
      <div data-testid={`mode-${side}`} style={{ marginBottom: 16 }}><ModeAction /></div>
      <div data-testid={`approval-${side}`} style={{ marginBottom: 16 }}><ApprovalAction /></div>
      <div data-testid={`model-${side}`} style={{ marginBottom: 24 }}><ModelThinkingAction /></div>
      <div data-testid={`context-${side}`}>
        <ContextToolGroup tools={[{ id: 'same-tool', kind: 'tool', toolCallId: 'same-call', toolName: 'read', args: { path: '/repo/context.ts' }, result: { content: [{ type: 'text', text: 'owner-specific context' }] }, status: 'done' } as never]} />
      </div>
    </section>
  </AgentStoreContext.Provider>;
}

let remount = () => {};
exposeData({ workspace: WS, a: A, b: B });
exposeActions({
  disk: () => structuredClone(disk),
  remount: () => remount(),
  expanded: (owner: string) => useSessionViewStateStore.getState().isExpanded(owner, 'context:same-call') ?? false,
  toolExpanded: (owner: string) => {
    const value = useSessionViewStateStore.getState().isExpanded(owner, 'tool:same-call');
    return value === undefined ? false : typeof value === 'boolean' ? value : null;
  },
  beginPlan: () => {
    planUnconfirmed = true;
    disk.sessions[A] = { ...disk.sessions[A], mode: 'plan', revision: disk.sessions[A].revision + 1 };
    persistHost();
    useSessionPreferencesStore.getState().applyServer(A, structuredClone(disk.sessions[A]));
  },
  clearPlan: () => {
    planUnconfirmed = false;
    disk.sessions[A] = { ...disk.sessions[A], mode: 'agent', revision: disk.sessions[A].revision + 1 };
    persistHost();
    useSessionPreferencesStore.getState().applyServer(A, structuredClone(disk.sessions[A]));
  },
});

export default function SessionPreferencesScenario() {
  const [left, setLeft] = useState(A);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [epoch, setEpoch] = useState(0);
  remount = () => {
    useSessionPreferencesStore.setState({ byOwner: {}, defaultsByWorkspace: {} });
    setEpoch((n) => n + 1);
  };
  const choose = (owner: string) => {
    if (owner.startsWith('draft:')) {
      useSessionStore.getState().setDraftConversation(WS, owner);
      useSessionStore.getState().setActiveSession('');
    } else {
      useSessionStore.getState().clearDraftConversation();
      useSessionStore.getState().setActiveSession(owner);
    }
    setLeft(owner);
  };
  const createDraft = () => {
    enterPendingNewSession(WS);
    const id = useSessionStore.getState().draftConversationId!;
    setDrafts((old) => [...old, id]);
    setLeft(id);
  };
  return <App><main style={{ height: '100vh', padding: 24, boxSizing: 'border-box', background: 'var(--gren-content-bg)' }}>
    <nav style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <button data-testid="choose-a" onClick={() => choose(A)}>打开 A</button>
      <button data-testid="choose-b" onClick={() => choose(B)}>打开 B</button>
      <button data-testid="new-draft" onClick={createDraft}>新建草稿</button>
      {drafts.map((id, index) => <button key={id} data-testid={`draft-${index}`} onClick={() => choose(id)}>草稿 {index + 1}</button>)}
    </nav>
    <div key={epoch} style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
      <Pane owner={left} side="left" />
      <Pane owner={B} side="right" />
    </div>
  </main></App>;
}
