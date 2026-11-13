import { useState } from 'react';
import { App } from 'antd';
import { ProvidersSettings } from '../../src/features/settings/ProvidersSettings';
import { MODEL_VISIBILITY_STORAGE_KEY, useModelVisibilityStore } from '../../src/stores/modelVisibilityStore';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

// Start this regression independently of visibility choices from other scenarios.
localStorage.removeItem(MODEL_VISIBILITY_STORAGE_KEY);
useModelVisibilityStore.setState({ hidden: [] });

const catalog = {
  openai: [
    {
      id: 'gpt-5', name: 'Fixture GPT 5', api: 'openai-responses', reasoning: true,
      input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
      cost: {
        input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 150000, input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75 }],
      },
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      compat: { supportsFastMode: true }, samplingParams: { top_p: 0.9 },
      samplingParamsByThinkingLevel: { high: { top_p: 0.8 } },
      inputLimits: { images: { maxPerMessage: 6, maxPerRequest: 12, resize: { maxWidth: 2048 } } },
      promptCache: { short: 300, long: 3600 },
    },
    {
      id: 'gpt-4.1', name: 'Fixture GPT 4.1', api: 'openai-completions', reasoning: true,
      input: ['text', 'image'], contextWindow: 128000, maxTokens: 16000,
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      compat: { supportsFastMode: true, thinkingFormat: 'openai' }, samplingParams: { temperature: 0.7 },
      promptCache: { short: 120, long: 1800 },
    },
  ],
  anthropic: [
    {
      id: 'claude-fixture', name: 'Fixture Claude', api: 'anthropic-messages', reasoning: true,
      input: ['text', 'image'], contextWindow: 200000, maxTokens: 24000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      compat: { forceAdaptiveThinking: true }, promptCache: { short: 300, long: 3600 },
    },
  ],
};
const initialDocument = {
  futureDocument: { keep: true },
  providers: {
    openai: {
      futureProvider: { keep: 'openai' },
      modelOverrides: { 'unavailable-fixture': { name: 'Unavailable override', future: { keep: 1 } } },
      models: [{
        id: 'custom-fixture', name: 'Custom appended fixture', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 8000, samplingParams: { top_p: 0.25 },
        futureModel: { keep: 'custom' },
      }],
    },
    anthropic: { futureProvider: { keep: 'anthropic' } },
  },
};
const authJson = JSON.stringify({ openai: { type: 'api_key', key: 'fixture-not-a-real-key' } });
let savedModelsJson = JSON.stringify(initialDocument);
let failSave = false;
let partialRefresh = false;
let failRefresh = false;
const catalogFailures = new Set<string>();
let remount = () => {};

exposeData({ catalog, initialDocument, savedModelsJson, authJson });
installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'get_provider_config':
        return { modelsJson: savedModelsJson, authJson, agentDir: '/fixture-agent' };
      case 'get_settings': return {};
      case 'get_provider_credentials': return [];
      case 'get_provider_oauth_capabilities': return [];
      case 'list_builtin_models': {
        const provider = String(args.provider);
        track(`catalog:${provider}`);
        if (catalogFailures.has(provider)) throw new Error(`夹具：${provider} 目录不可用`);
        return structuredClone(catalog[provider as keyof typeof catalog] ?? []);
      }
      case 'list_models_global':
        return { ok: true, models: Object.entries(catalog).flatMap(([provider, models]) => models.map((model) => ({ ...model, provider }))) };
      case 'set_provider_config':
        track('save-attempt');
        if (Object.hasOwn(args, 'authJson')) throw new Error('模型编辑不得重写 auth.json');
        if (failSave) throw new Error('夹具：磁盘不可写');
        savedModelsJson = String(args.modelsJson);
        exposeData({ savedModelsJson });
        track('save');
        return {
          refreshed: ['fixture-a'],
          failed: partialRefresh ? [{ workspace: 'fixture-b', error: '夹具：工作区刷新失败' }] : [],
        };
      case 'refresh_model_registry':
        track('refresh-only');
        if (failRefresh) throw new Error('夹具：仅刷新失败');
        return { refreshed: ['fixture-a', 'fixture-b'], failed: [] };
      case 'set_provider_api_key':
      case 'provider_oauth_login':
      case 'provider_oauth_logout':
      case 'diagnose_provider_model':
        track(`forbidden:${command}`);
        throw new Error(`此场景禁止凭据写入、登录或模型请求：${command}`);
      default:
        track(`unexpected:${command}`);
        throw new Error(`Unexpected command ${command}`);
    }
  },
});
exposeActions({
  remount: () => remount(),
  failSave: (value: boolean) => { failSave = value; },
  partialRefresh: (value: boolean) => { partialRefresh = value; },
  failRefresh: (value: boolean) => { failRefresh = value; },
  failCatalog: (provider: string, value: boolean) => {
    if (value) catalogFailures.add(provider);
    else catalogFailures.delete(provider);
  },
});

export default function BuiltinModelSettingsScenario() {
  const [epoch, setEpoch] = useState(0);
  remount = () => setEpoch((value) => value + 1);
  return <App>
    <main data-testid="builtin-settings-root" data-epoch={epoch} style={{
      height: '100vh', padding: 20, boxSizing: 'border-box', display: 'flex',
      flexDirection: 'column', minWidth: 0, background: 'var(--gren-content-bg)',
    }}>
      <ProvidersSettings key={epoch} />
    </main>
  </App>;
}
