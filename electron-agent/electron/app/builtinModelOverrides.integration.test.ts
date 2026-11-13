import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listBuiltinModels } from '../../../cli/src/builtin-models';
import { ModelRuntime } from '../../../cli/src/pi-sdk';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('applies sparse desktop overrides through the real SDK, then restores inherited defaults without credential writes', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NETWORK_FORBIDDEN'); });
  const { patchBuiltinModel, builtinModelDraft } = await import(new URL('../../src/features/settings/builtinModelOverrides.ts', import.meta.url).href);
  const { loadState, serializeState } = await import(new URL('../../src/features/settings/providerConfigAdapter.ts', import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), 'gren-builtin-overrides-'));
  roots.push(root);
  const base = listBuiltinModels('openai').find((model) => model.id === 'gpt-6.1-sol')!;
  expect(base).toBeDefined();
  const override = patchBuiltinModel(base, {}, {
    name: 'Edited built-in', reasoning: false, input: ['text'], contextWindow: 99999, maxTokens: 4444,
    cost: { ...base.cost, input: 0, tiers: [{ output: 99 }, { inputTokensAbove: 1000, output: 99 }] }, compat: { ...base.compat, supportsStrictMode: false },
    samplingParams: { top_p: 0 }, promptCache: { short: 0.5 },
  });
  const provider = { id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: { [base.id]: override } };
  const file = join(root, 'models.json');
  const authPath = join(root, 'auth.json');
  const auth = JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } });
  await writeFile(authPath, auth);
  const saved = serializeState([provider]).modelsJson;
  expect(JSON.parse(saved).providers.openai.models).toBeUndefined();
  await writeFile(file, saved);
  const runtime = await ModelRuntime.create({ modelsPath: file, authPath, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  expect(runtime.getError()).toBeUndefined();
  const model = runtime.getModel('openai', base.id)!;
  expect(model).toMatchObject({ name: 'Edited built-in', reasoning: false, input: ['text'], contextWindow: 99999, maxTokens: 4444, cost: { input: 0, output: base.cost.output }, compat: { supportsStrictMode: false }, samplingParams: { top_p: 0 }, promptCache: { short: 0.5 } });
  expect(model.api).toBe(base.api);
  expect(model.cost.tiers).toEqual([{ inputTokensAbove: 1000, input: 0, output: 99, cacheRead: base.cost.cacheRead, cacheWrite: base.cost.cacheWrite }]);
  const restored = loadState(saved, auth, [{ id: 'openai', name: 'OpenAI' }]);
  expect(builtinModelDraft(base, restored[0].modelOverrides[base.id]).contextWindow).toBe(99999);
  restored[0].modelOverrides = {};
  await writeFile(file, serializeState(restored).modelsJson);
  const reset = await ModelRuntime.create({ modelsPath: file, authPath, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  expect(reset.getError()).toBeUndefined();
  expect(reset.getModel('openai', base.id)).toMatchObject({ name: base.name, contextWindow: base.contextWindow, maxTokens: base.maxTokens, cost: base.cost, reasoning: base.reasoning, input: base.input });
  expect(await readFile(authPath, 'utf8')).toBe(auth);
});

it('preserves atomic chat template variables in SDK schema and shallow override composition', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('NETWORK_FORBIDDEN'); });
  const { patchBuiltinModel, builtinModelDraft } = await import(new URL('../../src/features/settings/builtinModelOverrides.ts', import.meta.url).href);
  const { serializeState } = await import(new URL('../../src/features/settings/providerConfigAdapter.ts', import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), 'gren-builtin-template-'));
  roots.push(root);
  const base = { ...listBuiltinModels('openai')[0], api: 'openai-completions' as const, compat: {
    thinkingFormat: 'chat-template', chatTemplateKwargs: { flag: { $var: 'thinking.enabled', omitWhenOff: true } },
  } };
  const draft = builtinModelDraft(base, {});
  const override = patchBuiltinModel(base, {}, { compat: { ...draft.compat,
    chatTemplateKwargs: JSON.stringify({ flag: { $var: 'thinking.enabled', omitWhenOff: false } }),
  } });
  expect(override).toEqual({ compat: { chatTemplateKwargs: { flag: { $var: 'thinking.enabled', omitWhenOff: false } } } });
  const file = join(root, 'models.json');
  await writeFile(file, serializeState([{ id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: { [base.id]: override } }]).modelsJson);
  const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(root, 'auth.json'), modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  expect(runtime.getError()).toBeUndefined();
  expect((runtime.getModel('openai', base.id)!.compat as Record<string, unknown>).chatTemplateKwargs).toEqual({ flag: { $var: 'thinking.enabled', omitWhenOff: false } });
});
