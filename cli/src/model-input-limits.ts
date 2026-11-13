import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { validateProviderModelOptions, type ProviderModelOptions } from '../../extensions/_shared/provider-model-options.js';
import { assertModelInputLimits, GOOGLE_INPUT_LIMIT_APIS, HTTP_INPUT_LIMIT_APIS } from '../../extensions/_shared/model-input-limit-policy.js';

export interface ModelInputLimitsOptions { modelsPath?: string }
/** Read intent only. getRegisteredProviderConfig contains extension registrations, not models.json. */
export function configuredInputQuotas(modelsPath: string, model: { provider?: string; id?: string }): ProviderModelOptions['inputLimits'] {
  if (!model.provider || !model.id) return undefined;
  let document: any;
  try {
    const text = readFileSync(modelsPath, 'utf8').replace(/^\uFEFF/, '').replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '');
    try { document = JSON.parse(text); } catch { throw new Error('模型配额来源 models.json 格式无效，请修复后重试。'); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const provider = document?.providers?.[model.provider];
  const base = provider?.models?.find((entry: any) => entry.id === model.id)?.inputLimits;
  const override = provider?.modelOverrides?.[model.id]?.inputLimits;
  const selected: NonNullable<ProviderModelOptions['inputLimits']> = {};
  const bytes = override && Object.hasOwn(override, 'maxRequestBytes') ? override.maxRequestBytes : base?.maxRequestBytes;
  if (bytes !== undefined) selected.maxRequestBytes = bytes;
  for (const field of ['maxPerMessage', 'maxPerRequest'] as const) {
    const value = override?.images && Object.hasOwn(override.images, field) ? override.images[field] : base?.images?.[field];
    if (value !== undefined) selected.images = { ...selected.images, [field]: value };
  }
  validateProviderModelOptions({ inputLimits: selected }, '模型配额声明');
  return Object.keys(selected).length ? selected : undefined;
}

function quotaModel(model: any, declared: ProviderModelOptions['inputLimits']): any {
  if (!declared) return { ...model, inputLimits: undefined };
  for (const [field, value] of Object.entries(declared.images ?? {})) if (model.inputLimits?.images?.[field] !== value) throw new Error('模型配额尚未同步，请刷新模型配置后重试。未发送请求。');
  if (declared.maxRequestBytes !== undefined && model.inputLimits?.maxRequestBytes !== declared.maxRequestBytes) throw new Error('模型配额尚未同步，请刷新模型配置后重试。未发送请求。');
  return { ...model, inputLimits: declared };
}
function supported(model: any, options: any): 'http' | 'google' {
  if (GOOGLE_INPUT_LIMIT_APIS.has(model.api)) {
    if (model.inputLimits?.maxRequestBytes !== undefined) throw new Error('输入限制暂不支持：Google SDK 不暴露最终 HTTP JSON，不能验证请求字节；请清除 maxRequestBytes。未发送请求。');
    return 'google';
  }
  if ((HTTP_INPUT_LIMIT_APIS.has(model.api) || model.api === 'openai-codex-responses' && options.transport === 'sse') && !options.client) return 'http';
  throw new Error(`输入限制暂不支持：${model.api} 的当前传输 / 自定义 client 没有可验证的最终 HTTP 边界。请清除数量 / 字节限制，或由调用方显式使用受支持的 SSE。未发送请求。`);
}

async function inspectBody(input: RequestInfo | URL, init?: RequestInit): Promise<{ bytes: Buffer; forward: RequestInit | undefined }> {
  const request = input instanceof Request ? input : undefined;
  const body = init?.body ?? request?.clone().body;
  const bytes = Buffer.from(await new Response(body).arrayBuffer());
  const streaming = body instanceof ReadableStream;
  const headers = new Headers(init?.headers ?? request?.headers);
  let decoded = bytes;
  for (const encoding of (headers.get('content-encoding') ?? '').split(',').map((value) => value.trim()).filter(Boolean).reverse()) {
    if (encoding === 'zstd') decoded = zstdDecompressSync(decoded);
    else if (encoding === 'gzip') decoded = gunzipSync(decoded);
    else if (encoding === 'deflate') decoded = inflateSync(decoded);
    else if (encoding === 'br') decoded = brotliDecompressSync(decoded);
    else if (encoding !== 'identity') throw new Error(`输入限制暂不支持：无法验证 ${encoding} 编码的请求。未发送请求。`);
  }
  return { bytes: decoded, forward: streaming && init?.body ? { ...init, body: bytes } : init };
}

const guarded = new WeakSet<object>();
const facades = new WeakMap<object, Map<string, object>>();
/** Stateless public SDK facade. Auth, continuation, serialization and image resizing stay with the SDK. */
export function guardModelInputLimits<T extends object>(runtime: T, source: ModelInputLimitsOptions = {}): T {
  if (guarded.has(runtime)) return runtime;
  const modelsPath = resolve(source.modelsPath ?? join(getAgentDir(), 'models.json'));
  const existing = facades.get(runtime)?.get(modelsPath);
  if (existing) return existing as T;
  const bound = new Map<PropertyKey, unknown>();
  const facade = new Proxy(runtime, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (bound.has(key)) return bound.get(key);
      const method = !['stream', 'streamSimple', 'complete', 'completeSimple'].includes(String(key)) ? value.bind(target)
        : (model: any, context: unknown, options: any = {}) => {
          if (!source.modelsPath && model.inputLimits?.maxRequestBytes === undefined && model.inputLimits?.images?.maxPerMessage === undefined && model.inputLimits?.images?.maxPerRequest === undefined) return value.call(target, model, context, options);
          const declared = configuredInputQuotas(modelsPath, model);
          if (!declared) return value.call(target, model, context, options);
          const scoped = quotaModel(model, declared);
          const kind = supported(scoped, options);
          const onPayload = options.onPayload;
          let effectiveModel = scoped;
          const fetch = options.fetch ?? globalThis.fetch;
          const wrapped = { ...options, onPayload: async (payload: unknown, actualModel: any, ...rest: unknown[]) => {
            effectiveModel = quotaModel(actualModel ?? model, declared);
            const replacement = await onPayload?.call(options, payload, actualModel, ...rest);
            const actualKind = supported(effectiveModel, options);
            if (actualKind === 'google') assertModelInputLimits(replacement === undefined ? payload : replacement, effectiveModel);
            return replacement;
          } };
          if (kind === 'http') wrapped.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const body = await inspectBody(input, init);
            let payload: unknown;
            try { payload = JSON.parse(body.bytes.toString('utf8')); }
            catch { throw new Error('输入限制：最终 HTTP body 不是可验证的 UTF-8 JSON，未发送请求。'); }
            assertModelInputLimits(payload, effectiveModel, body.bytes.byteLength);
            return fetch(input, body.forward);
          };
          return value.call(target, model, context, wrapped);
        };
      bound.set(key, method);
      return method;
    },
  });
  guarded.add(facade);
  const paths = facades.get(runtime) ?? new Map<string, object>();
  paths.set(modelsPath, facade);
  facades.set(runtime, paths);
  return facade;
}
