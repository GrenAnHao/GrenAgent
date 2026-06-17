import { describe, expect, it } from 'vitest';
import { defaultThinkingLevelMap, loadState, serializeState, type UiProvider } from './providerConfigAdapter';

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

  it('maps each API type to its standard reasoning level map', () => {
    const openai = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };
    expect(defaultThinkingLevelMap('openai-completions')).toEqual(openai);
    expect(defaultThinkingLevelMap('openai-responses')).toEqual(openai);
    expect(defaultThinkingLevelMap('anthropic-messages')).toEqual({ minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
    expect(defaultThinkingLevelMap('google-generative-ai')).toEqual({ minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null });
    expect(defaultThinkingLevelMap('unknown')).toBeUndefined();
  });

  it('round-trips a custom reasoning model with its thinking level map', () => {
    const { modelsJson, authJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages',
        models: [{ id: 'm', reasoning: true, thinkingLevelMap: defaultThinkingLevelMap('anthropic-messages') }],
      },
    ]);
    const back = loadState(modelsJson, authJson, presets).find((x) => x.id === 'p');
    expect(back?.models[0]).toMatchObject({ id: 'm', reasoning: true });
    expect(back?.models[0].thinkingLevelMap).toEqual({ minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' });
  });
});
