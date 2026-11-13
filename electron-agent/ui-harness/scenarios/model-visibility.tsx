import { useState } from 'react';
import { App } from 'antd';
import { BuiltinModelEditor } from '../../src/features/settings/BuiltinModelEditor';
import { ModelSelectField } from '../../src/features/settings/ModelSelectField';
import { ModelListField } from '../../src/features/settings/ModelListField';
import { CapabilityModelField } from '../../src/features/settings/CapabilityModelField';
import { ProviderDiagnostics } from '../../src/features/settings/ProviderDiagnostics';
import ModelThinkingAction from '../../src/features/chat/input/actions/ModelThinkingAction';
import ModelAction from '../../src/features/chat/input/actions/ModelAction';
import { useSessionStore } from '../../src/store/session';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import { MODEL_VISIBILITY_STORAGE_KEY, useModelVisibilityStore } from '../../src/stores/modelVisibilityStore';
import type { UiProvider } from '../../src/features/settings/providerConfigAdapter';
import type { SessionPreferences } from '../../src/lib/sessionPreferences';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

const WS = '/model-visibility';
const SESSION = `${WS}/current.jsonl`;
const HOST_KEY = 'model-visibility-fixture-host';
const BOOT_KEY = 'model-visibility-fixture-boot';
const boot = Number(sessionStorage.getItem(BOOT_KEY) ?? 0) + 1;
sessionStorage.setItem(BOOT_KEY, String(boot));
if (boot === 1) {
  localStorage.removeItem(MODEL_VISIBILITY_STORAGE_KEY);
  useModelVisibilityStore.setState({ hidden: [] });
}
const gpt = {
  id: 'gpt-5', name: 'Visibility Reasoning GPT', api: 'openai-responses',
  reasoning: true, fast: true, input: ['text', 'image'] as ('text' | 'image')[], contextWindow: 200000, maxTokens: 32000,
  cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
  thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' }, compat: { supportsFastMode: true },
};
const catalog = {
  openai: [gpt, ...['gpt-image-1', 'dall-e-3'].map((id) => ({
    ...gpt, id, name: `Visibility ${id}`, reasoning: false, fast: false, compat: {},
  }))],
  anthropic: [{ ...gpt, name: 'Visibility Other Provider GPT', api: 'anthropic-messages' }],
};
const models = Object.entries(catalog).flatMap(([provider, items]) => items.map((model) => ({ ...model, provider })));
const initialPreferences: SessionPreferences = {
  revision: 1, model: { provider: 'openai', id: gpt.id }, thinkingLevel: 'high', fastMode: true, mode: 'agent', approval: 'ask',
};
const initialModelsJson = JSON.stringify({ providers: { openai: { modelOverrides: { 'gpt-5': { name: 'Saved override remains' } } } } });
const authJson = JSON.stringify({ openai: { type: 'api_key', key: 'fixture-not-a-real-key' } });
const initialSettings = { defaultSessionModel: 'openai/gpt-5', ULTRA_ALLOWED_MODELS: '["openai/gpt-5"]', IMAGE_PROVIDER: 'openai', IMAGE_MODEL: 'gpt-5' };
const initialHost = { modelsJson: initialModelsJson, authJson, settings: initialSettings, preferences: initialPreferences };
let disk: typeof initialHost = structuredClone(initialHost);
if (boot > 1) {
  try { disk = JSON.parse(localStorage.getItem(HOST_KEY) ?? 'null') ?? disk; } catch { /* Only fixture host I/O. */ }
}
localStorage.setItem(HOST_KEY, JSON.stringify(disk));
const stateOf = () => ({
  sessionFile: SESSION, sessionPath: SESSION, sessionId: 'visibility-current',
  preferences: structuredClone(disk.preferences), model: models[0], thinkingLevel: disk.preferences.thinkingLevel, unavailable: [],
});
installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'get_provider_config': return { modelsJson: disk.modelsJson, authJson: disk.authJson, agentDir: '/fixture-agent' };
      case 'get_settings': return structuredClone(disk.settings);
      case 'list_builtin_models': return structuredClone(catalog[String(args.provider) as keyof typeof catalog] ?? []);
      case 'list_models_global': case 'agent_get_available_models': return { models: structuredClone(models) };
      case 'agent_get_session_defaults': return { revision: 0, model: initialPreferences.model, thinkingLevel: 'high' };
      case 'agent_get_state': return stateOf();
      case 'agent_set_model': case 'agent_set_thinking_level': case 'agent_set_fast_mode':
      case 'agent_set_session_defaults': case 'set_settings': case 'set_provider_config':
      case 'set_provider_api_key': case 'provider_oauth_login': case 'provider_oauth_logout':
      case 'diagnose_provider_model':
        track(`forbidden:${command}`);
        throw new Error(`可见性操作不得改模型、设置、凭据或请求模型：${command}`);
      default:
        track(`unexpected:${command}`);
        throw new Error(`Unexpected command ${command}`);
    }
  },
});
useSessionStore.setState({ activeWorkspace: WS, activeSessionPath: SESSION, draftConversationCwd: null, draftConversationId: null });

// Inject only storage I/O failure; production store and card own the transaction/error UI.
const originalSetItem = Storage.prototype.setItem;
let failStorage = false;
Storage.prototype.setItem = function (key: string, value: string) {
  if (failStorage && this === localStorage && key === MODEL_VISIBILITY_STORAGE_KEY) throw new Error('夹具：可见性存储不可写');
  return originalSetItem.call(this, key, value);
};
let replaceImage = (_enabled: boolean) => {};
let deleteImage = (_enabled: boolean) => {};
exposeData({ boot, models, initialModelsJson, authJson, initialSettings, initialPreferences, storageKey: MODEL_VISIBILITY_STORAGE_KEY });
exposeActions({
  snapshot: () => ({ disk: structuredClone(disk), hidden: [...useModelVisibilityStore.getState().hidden], storage: localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY) }),
  failStorage: (enabled: boolean) => { failStorage = enabled; },
  externalHidden: (provider: string, id: string, hidden: boolean) => useModelVisibilityStore.getState().setHidden(provider, id, hidden),
  replaceImage: (enabled: boolean) => replaceImage(enabled),
  deleteImage: (enabled: boolean) => deleteImage(enabled),
  corruptStorage: () => localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, '{broken fixture'),
});
const capField = { key: 'IMAGE_PROVIDER', modelKey: 'IMAGE_MODEL', type: 'capability', capability: 'image', label: '能力候选（目录与预设合并）' } as const;
const providerFixture = (id: string): UiProvider => ({
  id, name: id, builtIn: true, api: id === 'openai' ? 'openai-responses' : 'anthropic-messages',
  models: [], ...(id === 'openai' ? { modelOverrides: { 'gpt-5': { name: 'Saved override remains' } } } : {}),
});

export default function ModelVisibilityScenario() {
  const [active, setActive] = useState('openai');
  const [providers, setProviders] = useState(() => [providerFixture('openai'), providerFixture('anthropic')]);
  const [single, setSingle] = useState(disk.settings.defaultSessionModel);
  const [routes, setRoutes] = useState(disk.settings.ULTRA_ALLOWED_MODELS);
  const [capability, setCapability] = useState<Record<string, string>>({ IMAGE_PROVIDER: disk.settings.IMAGE_PROVIDER, IMAGE_MODEL: disk.settings.IMAGE_MODEL });
  const [revision, setRevision] = useState(0);
  const provider = providers.find((item) => item.id === active)!;
  replaceImage = (enabled) => setProviders((all) => all.map((item) => item.id === 'openai' ? { ...item, models: enabled ? [{ ...catalog.openai[1] }] : [] } : item));
  deleteImage = (enabled) => {
    const exists = catalog.openai.some((model) => model.id === 'gpt-image-1');
    if (enabled && exists) catalog.openai.splice(catalog.openai.findIndex((model) => model.id === 'gpt-image-1'), 1);
    if (!enabled && !exists) catalog.openai.splice(1, 0, { ...gpt, id: 'gpt-image-1', name: 'Visibility gpt-image-1', reasoning: false, fast: false, compat: {} });
    setRevision((value) => value + 1);
  };
  return <App><main data-testid="visibility-root" data-boot={boot} style={{ height: '100vh', padding: 16, boxSizing: 'border-box', display: 'flex', gap: 20, background: 'var(--gren-content-bg)' }}>
    <section data-testid="visibility-management" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <button data-testid="manage-openai" onClick={() => setActive('openai')}>OpenAI 管理</button>
        <button data-testid="manage-anthropic" onClick={() => setActive('anthropic')}>Anthropic 管理</button>
      </nav>
      <BuiltinModelEditor key={`${active}:${revision}`} provider={provider} onChange={(modelOverrides) => {
        track('override-edit');
        setProviders((all) => all.map((item) => item.id === active ? { ...item, modelOverrides } : item));
      }} />
    </section>
    <section data-testid="visibility-candidates" style={{ flex: 1, minWidth: 420, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AgentStoreContext.Provider value={{ workspace: WS, workspaceReady: true, store: {} as never, setWorkspaceReady: () => {}, appBooted: true }}>
        <div data-testid="visibility-current"><ModelThinkingAction /></div>
        <div data-testid="visibility-legacy"><ModelAction /></div>
      </AgentStoreContext.Provider>
      <div>设置单选（普通 / Ultra 复用同一组件）<ModelSelectField testId="visibility-single" value={single} onChange={(value) => { track('single-edit'); setSingle(value); }} /></div>
      <div>路由多选<ModelListField testId="visibility-routes" value={routes} onChange={(value) => { track('routes-edit'); setRoutes(value); }} /></div>
      <CapabilityModelField field={capField} values={capability} setValue={(key, value) => { track(`capability-edit:${key}`); setCapability((old) => ({ ...old, [key]: value })); }} />
      <output data-testid="visibility-saved-fields">{JSON.stringify({ single, routes, capability })}</output>
      <div style={{ minHeight: 350, display: 'flex', flexDirection: 'column' }}><ProviderDiagnostics providerId="openai" dirty={false} missingKey={false} /></div>
    </section>
  </main></App>;
}
