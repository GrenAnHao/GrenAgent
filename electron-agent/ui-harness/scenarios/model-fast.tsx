import { useState } from 'react';
import { App } from 'antd';
import ModelThinkingAction, { resetModelThinkingCacheForTests } from '../../src/features/chat/input/actions/ModelThinkingAction';
import { ProviderModelCard } from '../../src/features/settings/ProviderModelCard';
import { loadState, serializeState, type UiProvider } from '../../src/features/settings/providerConfigAdapter';
import { invalidateAvailableModels } from '../../src/features/settings/availableModelsCache';
import { useSessionStore } from '../../src/store/session';
import type { SessionPreferences } from '../../src/lib/sessionPreferences';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

/**
 * Fast 是第五项会话偏好。
 *
 * 一半场景是原有覆盖，必须保留：两供应商 × 8 个模型的 capability 图标顺序/组合、悬停提示、
 * 键盘操作、中英文词条、窄屏布局、能力撤销。
 * 另一半是本轮新语义：同项目、同供应商、同模型的 A 开 / B 关互不影响，A/B 往返与重载保持，
 * 保存失败回滚，能力撤销隐藏控件但保留会话里的保存值。
 *
 * 身份走 App 主界面同样的来源：只改 useSessionStore.activeSessionPath（全局当前会话），
 * 不传显式 scope，验证输入栏跟随真实切换路径。
 */
const WS = '/fast';
const A = `${WS}/a.jsonl`;
const B = `${WS}/b.jsonl`;
const DISK_KEY = 'model-fast-fixture-host';

const providers: UiProvider[] = ['claude', 'openai'].map((id) => ({
  id, name: id === 'claude' ? 'Claude' : 'OpenAI', builtIn: false,
  api: id === 'claude' ? 'anthropic-messages' : 'openai-responses',
  models: Array.from({ length: 8 }, (_, i) => ({
    id: i.toString(2).padStart(3, '0'), name: `${id === 'claude' ? 'Claude' : 'OpenAI'} ${i.toString(2).padStart(3, '0')}${i === 7 ? ' · Long model name that must truncate safely at narrow widths' : ''}`,
    input: i & 4 ? ['text', 'image'] : ['text'], reasoning: Boolean(i & 2), fast: i === 7 ? false : Boolean(i & 1),
    thinkingLevelMap: i & 2 ? { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } : undefined,
  })),
}));

const makeSession = (fastMode: boolean): SessionPreferences => ({
  revision: 1, model: { provider: 'claude', id: '111' }, thinkingLevel: 'medium',
  mode: 'agent', approval: 'auto', fastMode,
});

const initial = {
  modelsJson: serializeState(providers).modelsJson,
  sessions: { [A]: makeSession(true), [B]: makeSession(false) } as Record<string, SessionPreferences>,
};
const freshWindow = sessionStorage.getItem(DISK_KEY) !== 'active';
let disk: typeof initial;
try { disk = freshWindow ? structuredClone(initial) : JSON.parse(localStorage.getItem(DISK_KEY) || 'null') || structuredClone(initial); }
catch { disk = structuredClone(initial); }
sessionStorage.setItem(DISK_KEY, 'active');
const persistHost = () => localStorage.setItem(DISK_KEY, JSON.stringify(disk));
persistHost();

let failNext = false;
let failReadNext = false;

const catalog = () => loadState(disk.modelsJson, '{}', [])
  .flatMap((p) => p.models.map((m) => ({ ...m, api: p.api, provider: p.id })));

const stateOf = (path: string) => {
  const preferences = disk.sessions[path];
  if (!preferences) throw new Error('Unknown fixture session');
  const saved = preferences.model;
  const model = saved ? catalog().find((m) => m.provider === saved.provider && m.id === saved.id) : undefined;
  return {
    sessionFile: path, sessionPath: path, sessionId: path === A ? 'a' : 'b',
    preferences: structuredClone(preferences), model,
    thinkingLevel: model?.reasoning ? preferences.thinkingLevel : 'off', unavailable: [],
  };
};

const writeSession = (path: string, patch: Record<string, unknown>, event: string) => {
  if (!disk.sessions[path]) throw new Error('Preference writes require their original session path');
  disk.sessions[path] = { ...disk.sessions[path], ...patch, revision: Number(disk.sessions[path].revision) + 1 };
  persistHost();
  track(event);
  return { ok: true, ...stateOf(path), applied: Object.keys(patch), unavailable: [] };
};

installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson: disk.modelsJson, authJson: '{}', agentDir: '/agent' };
      case 'get_settings': return {};
      case 'agent_get_available_models': case 'list_models_global':
        return { models: [...catalog(), { provider: 'unknown', id: 'missing', name: 'Missing metadata' }] };
      case 'agent_get_session_defaults': return { revision: 0 };
      case 'agent_get_state': {
        if (failReadNext) { failReadNext = false; throw new Error('fixture-read-failed'); }
        return stateOf(String(args.targetSessionPath || A));
      }
      case 'agent_set_model': {
        const next = { provider: String(args.provider), id: String(args.modelId) };
        const path = String(args.targetSessionPath || '');
        track(`model:${next.provider}/${next.id}`);
        return writeSession(path, { model: next }, `write:${path === B ? 'b' : 'a'}:model`);
      }
      case 'agent_set_thinking_level':
        return writeSession(String(args.targetSessionPath || ''), { thinkingLevel: args.level }, `write:${String(args.targetSessionPath) === B ? 'b' : 'a'}:thinkingLevel`);
      case 'agent_set_mode':
        return writeSession(String(args.targetSessionPath || ''), { mode: args.mode }, 'write:mode');
      case 'agent_set_approval':
        return writeSession(String(args.targetSessionPath || ''), { approval: args.level }, 'write:approval');
      case 'agent_set_fast_mode': {
        if (failNext) { failNext = false; throw new Error('fixture-write-failed'); }
        const path = String(args.targetSessionPath || '');
        // 显式保留 false：关闭也是有效值。
        return writeSession(path, { fastMode: args.enabled === true }, `fast:${path === B ? 'b' : 'a'}:${args.enabled === true}`);
      }
      default: throw new Error(`unstubbed invoke: ${command}`);
    }
  },
});

const openSession = (path: string) => {
  useSessionStore.getState().clearDraftConversation();
  useSessionStore.getState().setActiveSession(path);
  useSessionStore.getState().setWorkspaceSessionPath(WS, path);
};
useSessionStore.setState({
  activeWorkspace: WS, activeSessionPath: A, draftConversationCwd: null, draftConversationId: null,
});
openSession(A);

exposeData({ workspace: WS, a: A, b: B });
exposeActions({
  failNext: () => { failNext = true; },
  failRead: () => { failReadNext = true; },
  openA: () => openSession(A),
  openB: () => openSession(B),
});

export default function ModelFastScenario() {
  const [draft, setDraft] = useState(() => loadState(disk.modelsJson, '{}', []));
  const [mount, setMount] = useState(0);
  const [active, setActive] = useState(A);
  const change = (p: number, patch: Record<string, unknown>) => setDraft((all) => all.map((item, i) => i === p ? { ...item, models: item.models.map((m) => m.id === '111' ? { ...m, ...patch } : m) } : item));
  const save = () => {
    disk.modelsJson = serializeState(draft).modelsJson;
    invalidateAvailableModels();
    exposeData({ disk });
    setMount((n) => n + 1);
  };
  const reload = () => {
    // 模拟重启：丢掉渲染侧缓存，再从宿主（fixture 磁盘）恢复。
    resetModelThinkingCacheForTests();
    invalidateAvailableModels();
    setDraft(loadState(disk.modelsJson, '{}', []));
    setMount((n) => n + 1);
  };
  const switchTo = (path: string) => { openSession(path); setActive(path); };
  return <App>
    <div style={{ height: '100vh', padding: 16, boxSizing: 'border-box', background: 'var(--gren-content-bg)', overflow: 'auto' }}>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <button data-testid="choose-a" onClick={() => switchTo(A)}>会话 A</button>
        <button data-testid="choose-b" onClick={() => switchTo(B)}>会话 B</button>
        <button data-testid="fast-reload" onClick={reload}>重载</button>
        <span data-testid="active-session">{active === A ? 'a' : 'b'}</span>
      </nav>
      {draft.map((p, i) => <ProviderModelCard key={p.id} index={i} model={p.models[7]} api={p.api} expanded={false}
        onChange={(patch) => change(i, patch)} onToggle={() => {}} onRemove={() => {}} />)}
      <button data-testid="fast-save" onClick={save}>保存能力</button>
      <div style={{ marginTop: 370 }}>
        <AgentStoreContext.Provider value={{ workspace: WS, workspaceReady: true, store: {} as never, setWorkspaceReady: () => {}, appBooted: true }}>
          <ModelThinkingAction key={mount} />
        </AgentStoreContext.Provider>
      </div>
    </div>
  </App>;
}
