import { completeTiers, serializeCompat, toUiModel, type UiModel, type UiProvider } from './providerConfigAdapter';

export type BuiltinOverride = NonNullable<UiProvider['modelOverrides']>[string];
const metadataKeys = ['name', 'reasoning', 'thinkingLevelMap', 'input', 'contextWindow', 'maxTokens', 'cost'] as const;
export const advancedOverrideKeys = ['samplingParams', 'samplingParamsByThinkingLevel', 'inputLimits', 'promptCache', '_advancedDrafts', '_advancedErrors'] as const;
type ObjectValue = Record<string, unknown>;
function isObject(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Match SDK provider-composer merge boundaries; deeper JSON values replace atomically. */
function mergesObject(path: string[]): boolean {
  if (path.length === 0) return true;
  if (path.length === 1) return ['thinkingLevelMap', 'cost', 'compat', 'samplingParams', 'samplingParamsByThinkingLevel', 'inputLimits', 'promptCache'].includes(path[0]);
  if (path[0] === 'compat') return path.length === 2 && ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs'].includes(path[1]);
  if (path[0] === 'samplingParamsByThinkingLevel') return path.length === 2;
  return path[0] === 'inputLimits' && path[1] === 'images' && (path.length === 2 || (path.length === 3 && path[2] === 'resize'));
}

function merge(base: ObjectValue, override: ObjectValue, path: string[] = []): ObjectValue {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const nextPath = [...path, key];
    result[key] = isObject(value) && mergesObject(nextPath) ? merge(isObject(base[key]) ? base[key] : {}, value, nextPath) : value;
  }
  return result;
}

/** Apply only edited leaves: inherited siblings must never become saved overrides. */
function changedLeaves(current: unknown, before: unknown, after: unknown, path: string[]): unknown {
  if (same(before, after)) return current;
  if (!isObject(after) || !mergesObject(path)) return after;
  const result: ObjectValue = isObject(current) ? { ...current } : {};
  const previous = isObject(before) ? before : {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(after)])) {
    if (same(previous[key], after[key])) continue;
    const value = changedLeaves(result[key], previous[key], after[key], [...path, key]);
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export function builtinModelDraft(base: UiModel, override: BuiltinOverride): UiModel {
  return toUiModel(merge(base as unknown as ObjectValue, override) as unknown as UiModel, base.api);
}

export function patchBuiltinModel(base: UiModel, current: BuiltinOverride, patch: Partial<UiModel>): BuiltinOverride {
  const draft = builtinModelDraft(base, current);
  const next: BuiltinOverride = { ...current };
  for (const key of metadataKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    // The custom card uses undefined for false; a built-in must explicitly override true.
    let value = key === 'reasoning' ? patch.reasoning === true : patch[key];
    if (key === 'cost' && patch.cost?.tiers && !same(patch.cost.tiers, draft.cost?.tiers)) {
      const cost = { ...draft.cost, ...patch.cost };
      value = { ...patch.cost, tiers: completeTiers(patch.cost.tiers, {
        input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0,
      }) };
    }
    const changed = changedLeaves(next[key], draft[key], value, [key]);
    if (changed === undefined) delete next[key];
    else next[key] = changed;
  }
  if (['compat', 'fast', 'thinkingFormat', 'forceAdaptiveThinking'].some((key) => Object.hasOwn(patch, key))) {
    const before = serializeCompat(draft, base.api);
    const edited = { ...draft, ...patch };
    if (Object.hasOwn(patch, 'thinkingFormat') && !patch.thinkingFormat) {
      edited.compat = { ...edited.compat };
      delete edited.compat.thinkingFormat;
    }
    const after = serializeCompat(edited, base.api);
    const changed = changedLeaves(next.compat, before, after, ['compat']);
    if (changed === undefined) delete next.compat;
    else next.compat = changed;
  }
  // Advanced editor receives sparse overrides, not the merged draft. Empty means inherit.
  for (const key of advancedOverrideKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    if (patch[key] === undefined) delete next[key];
    else (next as ObjectValue)[key] = patch[key];
  }
  return next;
}
