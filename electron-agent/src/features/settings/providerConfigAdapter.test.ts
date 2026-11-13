import { describe, expect, it } from 'vitest';
import { allowedCompatKeys, groupsForEditor } from './modelCompatCatalog';
import { defaultThinkingLevelMap, loadState, MODELS_JSON_SCHEMA, modelsWithApiThinkingLevels, serializeState, type UiProvider } from './providerConfigAdapter';
import { PROVIDER_PRESETS } from './providerPresets';

const presets = [{ id: 'openai', name: 'OpenAI', api: 'openai-responses' }];

describe('providerConfigAdapter', () => {
  it('round-trips Pi 1.5 OpenAI compatibility overrides including explicit false', () => {
    for (const promptCacheKeyMode of ['auto', 'enabled', 'disabled']) {
      const compat = { requiresNonNullAssistantContent: true, requiresToolsWithToolHistory: false, promptCacheKeyMode };
      const { modelsJson } = serializeState([{
        id: 'relay', name: 'Relay', builtIn: false, api: 'openai-completions',
        models: [{ id: 'fixture', compat }],
      }]);
      expect(JSON.parse(modelsJson).providers.relay.models[0].compat).toEqual(compat);
      const back = loadState(modelsJson, '{}', presets).find((p) => p.id === 'relay')!;
      expect(back.models[0].compat).toEqual(compat);
      expect(JSON.parse(serializeState([back]).modelsJson).providers.relay.models[0].compat).toEqual(compat);
    }
  });

  it('keeps message threads tri-state and filters Pi 1.5 fields by protocol', () => {
    for (const supportsMessageThreads of [undefined, false, true]) {
      const { modelsJson } = serializeState([{
        id: 'relay', name: 'Relay', builtIn: false, api: 'anthropic-messages',
        models: [{ id: 'fixture', compat: { supportsMessageThreads, requiresToolsWithToolHistory: true, promptCacheKeyMode: 'enabled' } }],
      }]);
      const raw = JSON.parse(modelsJson).providers.relay.models[0].compat;
      expect(raw?.supportsMessageThreads).toBe(supportsMessageThreads);
      expect(raw?.requiresToolsWithToolHistory).toBeUndefined();
      expect(raw?.promptCacheKeyMode).toBeUndefined();
      const back = loadState(modelsJson, '{}', presets).find((p) => p.id === 'relay')!;
      expect(back.models[0].compat?.supportsMessageThreads).toBe(supportsMessageThreads);
    }
    expect(allowedCompatKeys('openai-responses').has('promptCacheKeyMode')).toBe(true);
    expect(allowedCompatKeys('openai-responses').has('requiresToolsWithToolHistory')).toBe(false);
    expect(allowedCompatKeys('openai-completions').has('supportsMessageThreads')).toBe(false);
    const fields = groupsForEditor('anthropic-messages').flatMap((group) => group.fields);
    expect(fields.find((field) => field.key === 'supportsMessageThreads')).toMatchObject({ kind: 'bool', defaultLabel: expect.any(String) });
  });

  it('omits inherited Pi 1.5 flags rather than silently opting every model in or out', () => {
    for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      const { modelsJson } = serializeState([{ id: 'relay', name: 'Relay', builtIn: false, api, models: [{ id: 'fixture' }] }]);
      expect(JSON.parse(modelsJson).providers.relay.models[0].compat).toBeUndefined();
    }
  });

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
    const { modelsJson } = serializeState(custom);
    const back = loadState(modelsJson, null, presets).find((p) => p.id === 'my');
    expect(back).toMatchObject({ id: 'my', apiKey: 'k', baseUrl: 'https://x/v1', builtIn: false });
    expect(back?.models[0].id).toBe('m1');
  });

  it('built-in API key is never written to models.json or a generated auth.json', () => {
    const result = serializeState([
      { id: 'openai', name: 'OpenAI', builtIn: true, apiKey: 'sk-y', models: [] },
    ]);
    expect(JSON.parse(result.modelsJson).providers.openai).toBeUndefined();
    // 凭据归官方 CredentialStore：设置页不再生成整份 auth.json，避免保存时抹掉 OAuth 凭据。
    expect(Object.keys(result)).toEqual(['modelsJson']);
  });

  it('writes the published models.json $schema first and still loads it back', () => {
    const { modelsJson } = serializeState([]);
    const parsed = JSON.parse(modelsJson);
    expect(Object.keys(parsed)[0]).toBe('$schema');
    expect(parsed.$schema).toBe(MODELS_JSON_SCHEMA);
    expect(MODELS_JSON_SCHEMA).toBe('https://pi.dev/schemas/models.schema.json');
    expect(loadState(modelsJson, null, presets)).toHaveLength(presets.length);
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
    const { modelsJson } = serializeState([
      { id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages', headers: { 'X-Foo': 'bar' }, models: [] },
    ]);
    const back = loadState(modelsJson, null, presets).find((x) => x.id === 'p');
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
    const anthropic = { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-opus-4-6')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-opus-4-8')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages', 'claude-fable-5')).toEqual(anthropic);
    expect(defaultThinkingLevelMap('anthropic-messages')).toEqual(anthropic);
  });

  it('round-trips a custom anthropic reasoning model: per-model map + adaptive thinking on by default', () => {
    const { modelsJson } = serializeState([
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
    expect(raw[0].thinkingLevelMap).toEqual({ minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
    expect(raw[1].thinkingLevelMap).toEqual(raw[0].thinkingLevelMap);

    const back = loadState(modelsJson, null, presets).find((x) => x.id === 'p');
    expect(back?.models[0]).toMatchObject({ id: 'claude-opus-4-6', reasoning: true, forceAdaptiveThinking: true });
    expect(back?.models[1]).toMatchObject({ id: 'claude-opus-4-8', reasoning: true, forceAdaptiveThinking: true });
  });

  it('persists adaptive-thinking turned off (budget thinking, no effort) for older anthropic models', () => {
    const { modelsJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages',
        models: [{ id: 'claude-3-7-sonnet', reasoning: true, forceAdaptiveThinking: false }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].compat).toEqual({ forceAdaptiveThinking: false });
    const back = loadState(modelsJson, null, presets).find((x) => x.id === 'p');
    expect(back?.models[0].forceAdaptiveThinking).toBe(false);
  });

  it('does not write compat/forceAdaptiveThinking for non-anthropic reasoning models', () => {
    const { modelsJson } = serializeState([
      {
        id: 'p', name: 'P', builtIn: false, api: 'openai-completions',
        models: [{ id: 'gpt-x', reasoning: true }],
      },
    ]);
    expect(JSON.parse(modelsJson).providers.p.models[0].compat).toBeUndefined();
    const back = loadState(modelsJson, null, presets).find((x) => x.id === 'p');
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
    const anthropic = { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
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

  const costOf = (providers: UiProvider[]) => JSON.parse(serializeState(providers).modelsJson).providers.p.models[0].cost;
  const priced = (cost: UiProvider['models'][number]['cost']): UiProvider[] => [
    { id: 'p', name: 'P', builtIn: false, api: 'anthropic-messages', models: [{ id: 'claude-haiku-5-5', cost }] },
  ];

  it('fills missing cache rates with 0 without dropping existing tiers', () => {
    const cost = costOf(priced({
      input: 0.1,
      output: 0.5,
      tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    }));
    expect(cost).toEqual({
      input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
  });

  it('writes every tier with its threshold and all four rates, borrowing unset rates from the base price', () => {
    const cost = costOf(priced({
      input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5 }],
    }));
    expect(cost.tiers).toEqual([
      { inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.01, cacheWrite: 0.125 },
    ]);
  });

  it('keeps the last row of a duplicated threshold, sorts tiers ascending and drops rows without a threshold', () => {
    const cost = costOf(priced({
      input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25,
      tiers: [
        { inputTokensAbove: 200000, input: 3 },
        { inputTokensAbove: 100000, input: 2 },
        { input: 9 },
        { inputTokensAbove: -1, input: 9 },
        { inputTokensAbove: 200000, input: 4 },
      ],
    }));
    expect(cost.tiers.map((t: { inputTokensAbove: number; input: number }) => [t.inputTokensAbove, t.input])).toEqual([
      [100000, 2],
      [200000, 4],
    ]);
  });

  it('omits tiers when no row is valid, and omits cost entirely when nothing is priced', () => {
    expect(costOf(priced({ input: 1, tiers: [{ input: 2 }] }))).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(costOf(priced({ tiers: [] }))).toBeUndefined();
  });

  it('keeps tiers even when only the tier is priced', () => {
    expect(costOf(priced({ tiers: [{ inputTokensAbove: 100000, input: 2 }] }))).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 100000, input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }],
    });
  });

  it('loads tiers from models.json back into UiModel.cost.tiers and survives another save', () => {
    const fileCost = {
      input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    };
    const modelsJson = JSON.stringify({
      providers: { p: { name: 'P', api: 'anthropic-messages', apiKey: 'k', models: [{ id: 'claude-haiku-5-5', cost: fileCost }] } },
    });
    const loaded = loadState(modelsJson, '{}', presets);
    expect(loaded.find((x) => x.id === 'p')?.models[0].cost).toEqual(fileCost);
    expect(costOf(loaded.filter((x) => x.id === 'p'))).toEqual(fileCost);
  });

  it('round-trips image input, thinkingFormat and openai compat flags', () => {
    const { modelsJson } = serializeState([
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

    const back = loadState(modelsJson, null, presets).find((x) => x.id === 'p');
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

  it('lists the 1.4.0 subscription providers without hardcoding OAuth capability', () => {
    for (const id of ['github-copilot', 'openai-codex', 'meta']) {
      const preset = PROVIDER_PRESETS.find((p) => p.id === id);
      expect(preset?.name).toBeTruthy();
      // 是否支持 OAuth 一律由运行时探测，preset 只负责显示名与默认 api。
      expect(preset).not.toHaveProperty('oauth');
    }
  });

  it('shows the Anthropic group in the editor but does not allow those keys on openai-completions', () => {
    const groups = groupsForEditor('openai-completions');
    expect(groups.some((g) => g.id === 'anthropic')).toBe(true);
    expect(allowedCompatKeys('openai-completions').has('forceAdaptiveThinking')).toBe(false);
    expect(allowedCompatKeys('anthropic-messages').has('forceAdaptiveThinking')).toBe(true);
  });
});

describe('advanced options lossless patch',()=>{
 const original={version:'future',providers:{openai:{futureProvider:{x:1},api:'anthropic-messages',modelOverrides:{shared:{samplingParams:{top_p:0},future:{x:true}}},models:[{id:'shared',api:'openai-completions',reasoning:true,compat:{supportsFastMode:false,unknownCompat:'keep'},samplingParams:{top_p:0,flag:false,future:{x:1}},samplingParamsByThinkingLevel:{low:{top_k:3},future:{temperature:0}},inputLimits:{images:{maxPerMessage:2,resize:{maxWidth:100,future:9}},future:{x:1}},promptCache:{short:0.5,future:9},futureModel:['keep']}]}}};
 it('keeps the whole unedited document and coexisting replacement/override entries',()=>{
  const state=loadState(JSON.stringify(original),'{}',presets);
  expect(JSON.parse(serializeState(state).modelsJson)).toMatchObject(original);
  expect(JSON.parse(serializeState(state).modelsJson).providers.openai.models[0]).toEqual(original.providers.openai.models[0]);
 });
 it('patches advanced fields without rewriting model api, compat or future nested metadata',()=>{
  const state=loadState(JSON.stringify(original),'{}',presets);
  const provider=state[0];
  provider.models[0]={...provider.models[0],samplingParams:{...provider.models[0].samplingParams,top_p:0.8}};
  const saved=JSON.parse(serializeState(state).modelsJson);
  expect(saved.providers.openai.modelOverrides).toEqual(original.providers.openai.modelOverrides);
  expect(saved.providers.openai.models[0]).toEqual({...original.providers.openai.models[0],samplingParams:{...original.providers.openai.models[0].samplingParams,top_p:0.8}});
 });
 it('rejects invalid advanced values including hand-written TTL null',()=>{
  for(const patch of [{samplingParams:[]},{samplingParams:'x'},{inputLimits:{images:{maxPerMessage:0}}},{promptCache:{long:null}},{promptCache:{short:0}}]){
   expect(()=>serializeState([{id:'p',name:'p',builtIn:false,api:'openai-completions',models:[{id:'m',...patch} as never]}])).toThrow();
  }
 });
 it('does not synthesize advanced defaults for new models',()=>{
  const saved=JSON.parse(serializeState([{id:'p',name:'p',builtIn:false,models:[{id:'m'}]}]).modelsJson);
  for(const field of ['samplingParams','samplingParamsByThinkingLevel','inputLimits','promptCache'])expect(saved.providers.p.models[0]).not.toHaveProperty(field);
 });
});

it('preserves inline built-in credentials for model-only edits but removes the legacy inline fallback only after explicit key edits',()=>{
 const raw=JSON.stringify({providers:{openai:{apiKey:'fixture-old',modelOverrides:{'gpt-5':{samplingParams:{top_p:0.2}}}}}});
 const unchanged=loadState(raw,'{}',presets);expect(JSON.parse(serializeState(unchanged).modelsJson).providers.openai.apiKey).toBe('fixture-old');
 unchanged[0].apiKey='fixture-new';expect(JSON.parse(serializeState(unchanged).modelsJson).providers.openai.apiKey).toBeUndefined();
 const cleared=loadState(raw,'{}',presets);cleared[0].apiKey=undefined;expect(JSON.parse(serializeState(cleared).modelsJson).providers.openai.apiKey).toBeUndefined();
});

it('loaded custom providers still clear known optional fields rather than resurrecting raw source values',()=>{
 const state=loadState(JSON.stringify({providers:{relay:{name:'Relay',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-key',models:[{id:'m'}],future:'keep'}}}),'{}',[]);
 state[0].api=undefined;state[0].baseUrl=undefined;state[0].apiKey=undefined;const saved=JSON.parse(serializeState(state).modelsJson).providers.relay;
 expect(saved.api).toBeUndefined();expect(saved.baseUrl).toBeUndefined();expect(saved.apiKey).toBeUndefined();expect(saved.future).toBe('keep');
});
