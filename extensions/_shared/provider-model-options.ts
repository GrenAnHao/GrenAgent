export interface ProviderModelOptions {
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>>;
  inputLimits?: {
    maxRequestBytes?: number;
    images?: { maxPerMessage?: number; maxPerRequest?: number; resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
  };
  promptCache?: { short?: number; long?: number; [key: string]: unknown };
}

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是 JSON 对象`);
}

export function parseSamplingJson(text: string, name: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${name} 不是有效 JSON`); }
  object(parsed, name);
  return parsed;
}

/** Credential blind, shared renderer/main validation. Unknown future fields are retained. */
export function validateProviderModelOptions(value: ProviderModelOptions, path = '模型'): void {
  if (value.samplingParams !== undefined) object(value.samplingParams, `${path}.samplingParams`);
  if (value.samplingParamsByThinkingLevel !== undefined) {
    object(value.samplingParamsByThinkingLevel, `${path}.samplingParamsByThinkingLevel`);
    for (const [key, params] of Object.entries(value.samplingParamsByThinkingLevel)) object(params, `${path}.samplingParamsByThinkingLevel.${key}`);
  }
  const positiveInteger = (value: unknown, path: string, max = Number.MAX_VALUE) => {
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)) throw new Error(`${path} 必须是${max === 100 ? ' 1–100 的' : '正'}整数`);
  };
  if (value.inputLimits !== undefined) {
    object(value.inputLimits, `${path}.inputLimits`);
    positiveInteger(value.inputLimits.maxRequestBytes, `${path}.inputLimits.maxRequestBytes`);
    const images = value.inputLimits.images;
    if (images !== undefined) {
      object(images, `${path}.inputLimits.images`);
      for (const key of ['maxPerMessage', 'maxPerRequest'] as const) positiveInteger(images[key], `${path}.inputLimits.images.${key}`);
      if (images.resize !== undefined) {
        object(images.resize, `${path}.inputLimits.images.resize`);
        for (const key of ['maxWidth', 'maxHeight', 'maxBytes', 'jpegQuality'] as const) positiveInteger(images.resize[key], `${path}.inputLimits.images.resize.${key}`, key === 'jpegQuality' ? 100 : Number.MAX_VALUE);
      }
    }
  }
  if (value.promptCache !== undefined) {
    object(value.promptCache, `${path}.promptCache`);
    for (const key of ['short', 'long'] as const) {
      const seconds = value.promptCache[key];
      if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)) throw new Error(`${path}.promptCache.${key} 必须是有限正数秒；留空继承 SDK，不接受 null`);
    }
  }
}

export function validateModelsAdvancedOptions(document: unknown): void {
  object(document, 'models.json');
  const providers = document.providers;
  if (providers === undefined) return;
  object(providers, 'providers');
  for (const [id, provider] of Object.entries(providers)) {
    object(provider, `providers.${id}`);
    if (Array.isArray(provider.models)) for (const model of provider.models) {
      object(model, `providers.${id}.models`);
      validateProviderModelOptions(model, `providers.${id}/${String(model.id)}`);
    }
    if (provider.modelOverrides !== undefined) {
      object(provider.modelOverrides, `providers.${id}.modelOverrides`);
      for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
        object(override, `providers.${id}.modelOverrides.${modelId}`);
        validateProviderModelOptions(override, `providers.${id}.modelOverrides.${modelId}`);
      }
    }
  }
}

/** Apply one editor field, pruning only objects made empty by this edit. */
export function patchOptionPath<T extends ProviderModelOptions>(value: T, path: string[], next: unknown): T {
  const copy = { ...value } as Record<string, unknown>;
  const [key, ...rest] = path;
  if (rest.length) {
    const nested = patchOptionPath((copy[key] ?? {}) as ProviderModelOptions, rest, next);
    if (Object.keys(nested).length) copy[key] = nested;
    else delete copy[key];
  } else if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy as T;
}
