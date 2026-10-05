import { describe, expect, it } from 'vitest';
import { allowedCompatKeys, groupsForEditor } from './modelCompatCatalog';
import { defaultThinkingLevelMap, loadState, modelsWithApiThinkingLevels, serializeState, type UiProvider } from './providerConfigAdapter';

const presets = [{ id: 'openai', name: 'OpenAI', api: 'openai-responses' }];

describe('providerConfigAdapter', () => {
  it('loads built-in key from auth.json', () => {
    const ps = loadState('{}', '{"openai":{"type":"api_key","key":"sk-x"}}', presets);
    expect(ps[0]).toMatchObject({ id: 'openai', builtIn: true, apiKey: 'sk-x' });
  });

  it('round-trips a custom provider', () => {
    const custom: UiProvider[] = [
      {
        id: 'my',
        name: 'My',
        builtIn: false,
        api: 'openai-completions',
        baseUrl: 'https://x/v1',
        apiKey: 'k',
        models: [{ id: 'm1', name: 'M1' }],
      },
    ];
    const { modelsJson, authJson } = serializeState(custom);
    const back = loadState(modelsJson, authJson, presets).find((p) => p.id === 'my');
    expect(back).toMatchObject({ id: 'my', apiKey: 'k', baseUrl: 'https://x/v1', builtIn: false });
    expect(back?.models[0].id).toBe('m1');
  });

  it('built-in key goes to auth.json, not models.json', () => {
    const { modelsJson, authJson } = serializeState([
      { id: 'openai', name: 'OpenAI', builtIn: true, apiKey: 'sk-y', models: [] },
    ]);
    expect(JSON.parse(modelsJson).providers.openai).toBeUndefined();
    expect(JSON.parse(authJson).openai).toEqual({ type: 'api_key', key: 'sk-y' });
  });

  it('built-in with custom model writes a models.json entry', () => {
    const { modelsJson } = serializeState([
      { id: 'openai', name: 'OpenAI', builtIn: true, models: [{ id: 'gpt-x' }] },
    ]);
    expect(JSON.parse(modelsJson).providers.openai.models[0].id).toBe('gpt-x');
  });

  it('injects a neutral User-Agent for custom providers (bypasses proxy WAF blocking SDK UA)', () => {
    const { modelsJson } = serializeState([
      { id: 'proxy', name: 'Proxy', builtIn: false, api: 'anthropic-messages', baseUrl: 'https://x', models: [] },
    ]);
    expect(JSON.parse(modelsJson).providers.proxy.headers['User-Agent']).toBe('pi-agent/1.0');
  });

  it('keeps a user-defined User-Agent instead of overriding it', () => {
    const { modelsJson } = serializeState([
      {
        id: 'proxy',
        name: 'Proxy',
        builtIn: false,
        api: 'anthropic-messages',
        headers: { 'User-Agent': 'my-app/2.0' },
        models: [],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.proxy.headers['User-Agent']).toBe('my-app/2.0');
  });

  it('round-trips custom provider headers', () => {
    const { modelsJson, authJson } = serializeState([
      { id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages', headers: { 'X-Foo': 'bar' }, models: [] },
    ]);
    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.headers).toMatchObject({ 'X-Foo': 'bar', 'User-Agent': 'pi-agent/1.0' });
  });

  it('maps each API type to its native reasoning ladder', () => {
    const openai = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
    expect(defaultThinkingLevelMap('openai-completions')).toEqual(openai);
    expect(defaultThinkingLevelMap('openai-responses')).toEqual(openai);
    expect(defaultThinkingLevelMap('google-generative-ai')).toEqual({ minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null });
    expect(defaultThinkingLevelMap('unknown')).toBeUndefined();
  });

  it('uses the full Anthropic effort ladder for every model', () => {
    const anthropic = { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' };
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-opus-4-6')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-opus-4-8')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-fable-5')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages')).toEqual(anthropic);
  });

  it('round-trips a custom anthropic reasoning model: per-model map + adaptive thinking on by default', () => {
    const { modelsJson, authJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages',
        models: [
          { id: 'claude-opus-4-6', reasoning: true },
          { id: 'claude-opus-4-8', reasoning: true },
        ],
      },
    ]);
    // anthropic 推理模型默认写入 compat.forceAdaptiveThinking=true（pi 才会发送 effort/推理强度）。
    const raw = JSON.parse(modelsJson).providers.p.models;
    expect(raw[0]).toMatchObject({ id: 'claude-opus-4-6', compat: { forceAdaptiveThinking: true } });
    expect(raw[0].thinkingLevelMap).toEqual({ minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' });
    expect(raw[1].thinkingLevelMap).toEqual(raw[0].thinkingLevelMap);

    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.models[0]).toMatchObject({ id: 'claude-opus-4-6', reasoning: true, forceAdaptiveThinking: true });
    expect(back?.models[1]).toMatchObject({ id: 'claude-opus-4-8', reasoning: true, forceAdaptiveThinking: true });
  });

  it('persists adaptive-thinking turned off (budget thinking, no effort) for older anthropic models', () => {
    const { modelsJson, authJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages',
        models: [{ id: 'claude-3-7-sonnet', reasoning: true, forceAdaptiveThinking: false }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].compat).toEqual({ forceAdaptiveThinking: false });
    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.models[0].forceAdaptiveThinking).toBe(false);
  });

  it('does not write compat/forceAdaptiveThinking for non-anthropic reasoning models', () => {
    const { modelsJson, authJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'openai-completions',
        models: [{ id: 'gpt-x', reasoning: true }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].compat).toBeUndefined();
    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.models[0].forceAdaptiveThinking).toBeUndefined();
  });

  it('rewrites reasoning models to the new API ladder when the provider API type changes', () => {
    const openai = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
    const models = modelsWithApiThinkingLevels(
      [
        { id: 'glm-5.2', reasoning: true, thinkingLevelMap: openai },
        { id: 'claude-opus-4-6', reasoning: true, thinkingLevelMap: openai },
        { id: 'plain', thinkingLevelMap: openai },
      ],
      'anthropic-messages',
    );
    const anthropic = { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' };
    expect(models[0].thinkingLevelMap).toEqual(anthropic);
    expect(models[1].thinkingLevelMap).toEqual(anthropic);
    expect(models[2].thinkingLevelMap).toEqual(openai);
  });

  it('preserves a per-model thinkingLevelMap instead of overwriting it with the API default', () => {
    const customMap = { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' };
    const { modelsJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'openai-completions',
        models: [{ id: 'glm-5.2', reasoning: true, thinkingLevelMap: customMap }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].thinkingLevelMap).toEqual(customMap);
  });

  it('fills cache rates so a partial price does not invalidate models.json', () => {
    const { modelsJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages',
        models: [{ id: 'claude', cost: { input: 4, output: 20 } }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].cost).toEqual({
      input: 4, output: 20, cacheRead: 0, cacheWrite: 0,
    });
  });

  it('round-trips image input, thinkingFormat and openai compat flags', () => {
    const { modelsJson, authJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'openai-completions',
        models: [{
          id: 'glm-5.2',
          reasoning: true,
          input: ['text', 'image'],
          maxTokens: 16384,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          thinkingFormat: 'zai',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
        }],
      },
    ]);
    const raw = JSON.parse(modelsJson).providers.p.models[0];
    expect(raw.input).toEqual(['text', 'image']);
    expect(raw.maxTokens).toBe(16384);
    expect(raw.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    expect(raw.compat).toMatchObject({
      thinkingFormat: 'zai',
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
    });
    expect(raw.compat.forceAdaptiveThinking).toBeUndefined();

    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.models[0]).toMatchObject({
      id: 'glm-5.2',
      input: ['text', 'image'],
      thinkingFormat: 'zai',
      maxTokens: 16384,
    });
    expect(back?.models[0].compat).toMatchObject({ supportsDeveloperRole: false, thinkingFormat: 'zai' });
  });

  it('does not persist anthropic-only compat on openai-completions models', () => {
    const { modelsJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'openai-completions',
        models: [{
          id: 'm',
          reasoning: true,
          forceAdaptiveThinking: true,
          compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, thinkingFormat: 'qwen' },
        }],
      },
    ]);
    const compat = JSON.parse(modelsJson).providers.p.models[0].compat;
    expect(compat.thinkingFormat).toBe('qwen');
    expect(compat.forceAdaptiveThinking).toBeUndefined();
    expect(compat.supportsMidConvoEffort).toBeUndefined();
  });

  it('shows the Anthropic group in the editor but does not allow those keys on openai-completions', () => {
    const groups = groupsForEditor('openai-completions');
    expect(groups.some((g) => g.id === 'anthropic')).toBe(true);
    expect(allowedCompatKeys('openai-completions').has('forceAdaptiveThinking')).toBe(false);
    expect(allowedCompatKeys('anthropic-messages').has('forceAdaptiveThinking')).toBe(true);
  });
});
