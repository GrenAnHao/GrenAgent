import { describe, expect, it } from 'vitest';
import { builtinModelDraft, patchBuiltinModel } from './builtinModelOverrides';
import type { UiModel } from './providerConfigAdapter';

const base: UiModel = {
  id: 'fixture', api: 'openai-responses', name: 'Fixture', reasoning: true,
  contextWindow: 200000, maxTokens: 16000, input: ['text', 'image'],
  thinkingLevelMap: { low: 'low', high: 'high', xhigh: null },
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, tiers: [{ inputTokensAbove: 100000, input: 2, output: 4 }] },
  compat: { supportsFastMode: true, supportsStrictMode: true, futureFlag: 'catalog' },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000 } } },
  promptCache: { short: 300, long: 3600 },
};

describe('built-in model field overrides', () => {
  it('shows inherited metadata merged with saved partial overrides', () => {
    const draft = builtinModelDraft(base, { cost: { input: 0 }, compat: { supportsFastMode: false } });
    expect(draft.cost).toMatchObject({ input: 0, output: 2, cacheRead: 0.1 });
    expect(draft.fast).toBe(false);
    expect(draft.contextWindow).toBe(200000);
    expect(base.cost?.input).toBe(1);
  });

  it('stores a changed context only, not an SDK snapshot or identity', () => {
    expect(patchBuiltinModel(base, {}, { contextWindow: 100000, id: 'wrong', api: 'wrong' })).toEqual({ contextWindow: 100000 });
  });

  it('retains explicit false when disabling reasoning instead of inheriting true', () => {
    expect(patchBuiltinModel(base, {}, { reasoning: undefined, thinkingLevelMap: undefined })).toEqual({ reasoning: false });
  });

  it('writes fast false without freezing unrelated compat flags', () => {
    expect(patchBuiltinModel(base, { future: { keep: 1 } }, { fast: false })).toEqual({ future: { keep: 1 }, compat: { supportsFastMode: false } });
  });

  it('patches one price leaf, preserving zero and unknown saved metadata', () => {
    const current = { cost: { output: 9, futurePrice: 42 }, compat: { futureFlag: 'user' } };
    const draft = builtinModelDraft(base, current);
    expect(patchBuiltinModel(base, current, { cost: { ...draft.cost, input: 0 } })).toEqual({
      cost: { input: 0, output: 9, futurePrice: 42 }, compat: { futureFlag: 'user' },
    });
  });

  it('clears a price override without removing unrelated prices', () => {
    const current = { cost: { input: 3, output: 9 } };
    const draft = builtinModelDraft(base, current);
    expect(patchBuiltinModel(base, current, { cost: { ...draft.cost, input: undefined } })).toEqual({ cost: { output: 9 } });
  });

  it('can explicitly remove inherited price tiers with an empty array', () => {
    expect(patchBuiltinModel(base, {}, { cost: { ...base.cost, tiers: [] } })).toEqual({ cost: { tiers: [] } });
  });

  it('changes a thinking level without freezing inherited levels', () => {
    expect(patchBuiltinModel(base, {}, { thinkingLevelMap: { ...base.thinkingLevelMap, high: null } })).toEqual({ thinkingLevelMap: { high: null } });
  });

  it('retains unknown compatibility fields while editing a supported field', () => {
    const current = { compat: { futureFlag: 'saved' } };
    const draft = builtinModelDraft(base, current);
    expect(patchBuiltinModel(base, current, { compat: { ...draft.compat, supportsStrictMode: false } })).toEqual({
      compat: { futureFlag: 'saved', supportsStrictMode: false },
    });
  });

  it('keeps advanced values sparse, including invalid drafts and zero sampling', () => {
    const current = { promptCache: { short: 60, long: 1800 }, future: 'keep' };
    const next = patchBuiltinModel(base, current, {
      promptCache: { long: 1800 }, samplingParams: { top_p: 0, flag: false },
      _advancedDrafts: { 'promptCache.short': '' }, _advancedErrors: { samplingParams: 'bad JSON' },
    });
    expect(next).toEqual({ promptCache: { long: 1800 }, future: 'keep', samplingParams: { top_p: 0, flag: false },
      _advancedDrafts: { 'promptCache.short': '' }, _advancedErrors: { samplingParams: 'bad JSON' } });
    expect(builtinModelDraft(base, next).promptCache).toEqual({ short: 300, long: 1800 });
  });

  it('matches SDK shallow merging for sampling objects and nested compatibility data', () => {
    const nested = { ...base, api: 'openai-completions', samplingParams: { routing: { a: 1, b: 2 } },
      compat: { chatTemplateKwargs: { sampling: { a: 1, b: 2 }, enabled: true } } };
    const draft = builtinModelDraft(nested, { samplingParams: { routing: { a: 0 } }, compat: { chatTemplateKwargs: { sampling: { a: 0 } } } });
    expect(draft.samplingParams).toEqual({ routing: { a: 0 } });
    expect(JSON.parse(String(draft.compat?.chatTemplateKwargs))).toEqual({ sampling: { a: 0 }, enabled: true });
  });

  it('stores atomic nested compatibility objects in full when SDK replaces that object', () => {
    const nested = { ...base, api: 'openai-completions', compat: { chatTemplateKwargs: { sampling: { a: 1, b: 2 }, enabled: true } } };
    const draft = builtinModelDraft(nested, {});
    const patch = { compat: { ...draft.compat, chatTemplateKwargs: JSON.stringify({ sampling: { a: 0, b: 2 }, enabled: true }) } };
    expect(patchBuiltinModel(nested, {}, patch)).toEqual({ compat: { chatTemplateKwargs: { sampling: { a: 0, b: 2 } } } });
  });

  it('normalizes edited price tiers against effective prices and skips missing thresholds', () => {
    expect(patchBuiltinModel(base, {}, { cost: { ...base.cost, tiers: [
      { output: 99 }, { inputTokensAbove: 1000, output: 4 },
    ] } })).toEqual({ cost: { tiers: [{ inputTokensAbove: 1000, input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 }] } });
  });

  it('clears the thinking format alias without resurrecting saved compat', () => {
    const completions = { ...base, api: 'openai-completions' };
    expect(patchBuiltinModel(completions, { compat: { thinkingFormat: 'deepseek', future: true } }, { thinkingFormat: undefined })).toEqual({ compat: { future: true } });
  });

  it('does not leak UI source metadata into the saved override', () => {
    const next = patchBuiltinModel(base, {}, { name: 'Edited', _source: base });
    expect(next).toEqual({ name: 'Edited' });
  });
});
