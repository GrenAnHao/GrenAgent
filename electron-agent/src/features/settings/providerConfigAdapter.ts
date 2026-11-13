import { allowedCompatKeys, showsThinkingFormat } from './modelCompatCatalog';
import { fastApiSupported } from '../../../../extensions/_shared/fast-mode';
import { validateModelsAdvancedOptions, type ProviderModelOptions } from '../../../../extensions/_shared/provider-model-options';
import type { AdvancedDrafts } from './ModelAdvancedOptionsEditor';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** models.json 模型 compat：按当前 API 过滤后写入。对象型路由字段用字符串编辑，保存时再解析。 */
export type ModelCompat = Record<string, unknown>;

/** 单价：$/百万 token。cacheWrite 是 5 分钟缓存写；1 小时缓存写由 pi 按 input × 2 计，没有单独字段。 */
export interface ModelCostRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 分段计费：当次 input + cacheRead + cacheWrite 严格大于 inputTokensAbove 时整单按这一档，多档取阈值最高的命中档。 */
export interface ModelCostTier extends ModelCostRates {
  /** UI 里新加的一行可能还没填阈值；落盘前没填的行会被丢掉。 */
  inputTokensAbove?: number;
}

export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[];
}

export interface UiModel extends ProviderModelOptions, AdvancedDrafts {
  id: string;
  api?: string;
  /** Original SDK entry, retained through form spreads; never serialized as a field. */
  _source?: ModelEntry;
  /** Fast access capability, separate from the per-model active preference. */
  fast?: boolean;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  /** 写入 compat.thinkingFormat。仅 openai-completions 落盘。 */
  thinkingFormat?: string;
  compat?: ModelCompat;
  /**
   * 仅 anthropic-messages 推理模型有意义：写入 models.json 的 compat.forceAdaptiveThinking。
   * 开启时 pi 走自适应思考、发送 effort（供应商后台「推理强度」列才有值）；关闭时走 budget 思考、不发 effort。
   * 老 claude（3.7/4.0/4.5）不支持自适应思考，需关闭。默认对 anthropic 推理模型开启。
   */
  forceAdaptiveThinking?: boolean;
}

export interface UiProvider {
  id: string;
  name: string;
  builtIn: boolean;
  api?: string;
  baseUrl?: string;
  /** 内置: 写入 auth.json；自定义: 写入 models.json.apiKey */
  apiKey?: string;
  /** 自定义请求头（写入 models.json.headers）。自定义供应商会自动补一个中性 User-Agent。 */
  headers?: Record<string, string>;
  /** 用户自定义/追加的模型（不含内置目录；内置参数修改保存在 modelOverrides） */
  models: UiModel[];
  modelOverrides?: Record<string, ProviderModelOptions & Record<string, unknown>>;
  _source?: ProviderEntry;
  _document?: ModelsJson;
  /** Credential ownership remains with the explicit key command; model-only edits leave inline legacy keys alone. */
  _initialApiKey?: string;
}

/** models.json 里的单个模型条目（落盘形态）：含 pi 的 compat，不含 UI 专用的 thinkingFormat / forceAdaptiveThinking。 */
interface ModelEntry extends ProviderModelOptions {
  id: string;
  api?: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  compat?: ModelCompat;
}

interface ProviderEntry {
  [key: string]: unknown;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, ProviderModelOptions & Record<string, unknown>>;
}

// 各兼容协议「官方原生推理档位」→ models.json 的 thinkingLevelMap（pi 内部档位 → 供应商原生取值，null = 隐藏）。
// pi 内部档位只作传输；选择器直接拿这里的供应商原生取值当标签，做到照搬各家而非迁就 pi。依据各家 API 文档：
//  - OpenAI reasoning_effort: minimal/low/medium/high/xhigh（pi 同名直传）
//  - Anthropic effort: low/medium/high/xhigh/max（无 minimal）。pi 的 low…max 与 effort 同名一一对应，minimal 隐藏。不按模型 ID 裁剪，默认全部露出。
//  - Gemini thinking_level: minimal/low/medium/high（无 xhigh）
const OPENAI_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
const GOOGLE_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };
const ANTHROPIC_THINKING_MAP: ThinkingLevelMap = { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/**
 * 按供应商 API 类型给出官方原生推理档位映射；勾「推理」时写入自定义模型，让 pi 按各家原生档位生效、不会钳回 off。
 * modelId 保留给调用方，Anthropic 不再按模型区分最高档。
 */
export function defaultThinkingLevelMap(api: string | undefined, _modelId?: string): ThinkingLevelMap | undefined {
  switch (api) {
    case 'anthropic-messages':
      return ANTHROPIC_THINKING_MAP;
    case 'google-generative-ai':
      return GOOGLE_THINKING_MAP;
    case 'openai-completions':
    case 'openai-responses':
      return OPENAI_THINKING_MAP;
    default:
      return undefined;
  }
}

/**
 * 供应商 API 类型切换后，已勾选推理的模型改用该协议的官方思考档位。
 * 未勾推理的模型保持原样；之后再勾推理时由模型卡片按当前 API 补默认。
 */
export function modelsWithApiThinkingLevels<T extends UiModel>(models: T[], api: string | undefined): T[] {
  return models.map((m) => {
    if (!m.reasoning || m.api) return m;
    const next = defaultThinkingLevelMap(api, m.id);
    return { ...m, thinkingLevelMap: next ? { ...next } : undefined };
  });
}

function parseRoutingObject(raw: unknown): unknown {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return undefined;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  const only = text.replace(/^only:\s*/i, '');
  const items = only.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return items.length ? { only: items } : undefined;
}

function stringifyRoutingObject(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function serializeCompat(m: UiModel, api: string | undefined): ModelCompat | undefined {
  const allowed = allowedCompatKeys(api);
  const merged: ModelCompat = { ...(m.compat ?? {}) };
  if (showsThinkingFormat(api) && m.thinkingFormat) merged.thinkingFormat = m.thinkingFormat;
  if (api === 'anthropic-messages' && m.reasoning) {
    merged.forceAdaptiveThinking =
      m.forceAdaptiveThinking ?? (merged.forceAdaptiveThinking as boolean | undefined) ?? true;
  }

  const out: ModelCompat = {};
  if (fastApiSupported(api) && m.fast !== undefined) out.supportsFastMode = m.fast === true;
  for (const [key, value] of Object.entries(merged)) {
    if (!allowed.has(key) || value === undefined || value === '') continue;
    if (key === 'openRouterRouting' || key === 'vercelGatewayRouting' || key === 'chatTemplateKwargs') {
      const parsed = parseRoutingObject(value);
      if (parsed !== undefined) out[key] = parsed;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** models.json 模型条目 → UI 模型：还原 compat / thinkingFormat / 自适应思考。 */
export function toUiModel(m: ModelEntry, api: string | undefined): UiModel {
  api = m.api ?? api;
  const { compat, ...rest } = m;
  const thinkingFormat = typeof compat?.thinkingFormat === 'string' ? compat.thinkingFormat : undefined;
  const uiCompat: ModelCompat = { ...(compat ?? {}) };
  if (uiCompat.openRouterRouting !== undefined) uiCompat.openRouterRouting = stringifyRoutingObject(uiCompat.openRouterRouting);
  if (uiCompat.vercelGatewayRouting !== undefined) uiCompat.vercelGatewayRouting = stringifyRoutingObject(uiCompat.vercelGatewayRouting);
  if (uiCompat.chatTemplateKwargs !== undefined) uiCompat.chatTemplateKwargs = stringifyRoutingObject(uiCompat.chatTemplateKwargs);
  const model: UiModel = {
    ...rest,
    _source: m,
    ...(fastApiSupported(api) && typeof compat?.supportsFastMode === 'boolean' ? { fast: compat.supportsFastMode } : {}),
    ...(thinkingFormat ? { thinkingFormat } : {}),
    ...(Object.keys(uiCompat).length ? { compat: uiCompat } : {}),
  };
  if (api === 'anthropic-messages' && m.reasoning) {
    model.forceAdaptiveThinking = (compat?.forceAdaptiveThinking as boolean | undefined) ?? true;
  }
  return model;
}

/**
 * UI 模型 → models.json 模型条目：
 * - 推理模型保留用户 thinkingLevelMap；没有映射时才按协议补默认。
 * - 非推理模型清掉映射。
 * - compat 按当前 API 过滤；thinkingFormat 写入 compat。
 */
type CompleteRates = Required<ModelCostRates>;
type CompleteTier = CompleteRates & { inputTokensAbove: number };

function isValidThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 分段落盘：没填阈值的行丢掉，没填的价格沿用基础价；同阈值只留最后一行，按阈值升序。
 * pi 的 tier schema 同样要求四个价格都是数字。
 */
export function completeTiers(tiers: ModelCostTier[] | undefined, base: CompleteRates): CompleteTier[] {
  const byThreshold = new Map<number, CompleteTier>();
  for (const tier of tiers ?? []) {
    if (!isValidThreshold(tier?.inputTokensAbove)) continue;
    byThreshold.set(tier.inputTokensAbove, {
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input ?? base.input,
      output: tier.output ?? base.output,
      cacheRead: tier.cacheRead ?? base.cacheRead,
      cacheWrite: tier.cacheWrite ?? base.cacheWrite,
    });
  }
  return [...byThreshold.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
}

/**
 * Pi 的 models.json schema 要求 cost 一旦出现，input/output/cacheRead/cacheWrite 四个数字都必须在。
 * 缺任一字段时整份文件会被拒绝，自定义供应商会全部从模型列表消失，所以没填的基础价补 0。
 * 基础价一个没填、也没有有效分段时不写 cost；有分段时照样写，不把用户填的分段吞掉。
 */
function completeCost(cost: ModelCost | undefined): ModelCost | undefined {
  if (!cost) return undefined;
  const base: CompleteRates = {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
  };
  const tiers = completeTiers(cost.tiers, base);
  const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (rates.every((value) => typeof value !== 'number') && tiers.length === 0) return undefined;
  return tiers.length > 0 ? { ...base, tiers } : base;
}

function serializeModel(m: UiModel, api: string | undefined): ModelEntry {
  api = m.api ?? api;
  const { forceAdaptiveThinking, thinkingFormat, compat, cost, fast, _source, _advancedDrafts, _advancedErrors, ...rest } = m;
  if (_advancedErrors && Object.keys(_advancedErrors).length) throw new Error(Object.values(_advancedErrors)[0]);
  void fast;
  void forceAdaptiveThinking;
  void thinkingFormat;
  void compat;
  const priced = completeCost(cost);
  const base: ModelEntry = priced ? { ...rest, cost: priced } : { ...rest };
  const serialized = !m.reasoning ? { ...base, thinkingLevelMap: undefined, compat: serializeCompat(m, api) } : {
    ...base,
    thinkingLevelMap: m.thinkingLevelMap ?? defaultThinkingLevelMap(api, m.id),
    compat: serializeCompat(m, api),
  };
  if (_source) {
    const initial = toUiModel(_source, api);
    if (JSON.stringify([m.compat, m.fast, m.thinkingFormat, m.forceAdaptiveThinking]) === JSON.stringify([initial.compat, initial.fast, initial.thinkingFormat, initial.forceAdaptiveThinking])) serialized.compat = _source.compat;
    if (JSON.stringify(m.cost) === JSON.stringify(initial.cost)) serialized.cost = _source.cost;
    if (JSON.stringify([m.thinkingLevelMap, m.reasoning]) === JSON.stringify([initial.thinkingLevelMap, initial.reasoning])) serialized.thinkingLevelMap = _source.thinkingLevelMap;
  }
  return serialized;
}

/**
 * 中性 User-Agent。自定义供应商多为二手代理站，其 WAF 常按官方 SDK 的 UA
 * （如 `Anthropic/JS x.y.z`、`OpenAI/JS x.y.z`）整条拦截，返回 403「Your request was blocked」。
 * Pi 走官方 SDK 必带这种 UA，故对自定义供应商默认覆盖成中性 UA 规避。用户自设 UA 时不覆盖。
 */
const DEFAULT_USER_AGENT = 'pi-agent/1.0';

function hasUserAgent(headers: Record<string, string> | undefined): boolean {
  return !!headers && Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent');
}

export function withDefaultUserAgent(headers: Record<string, string> | undefined): Record<string, string> {
  const h = { ...(headers ?? {}) };
  if (!hasUserAgent(h)) h['User-Agent'] = DEFAULT_USER_AGENT;
  return h;
}
interface ModelsJson {
  [key: string]: unknown;
  providers?: Record<string, ProviderEntry>;
}
type AuthEntry = { type?: string; key?: string } | undefined;
type AuthJson = Record<string, AuthEntry>;

export interface PresetLike {
  id: string;
  name: string;
  api?: string;
}

export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** auth.json + models.json + 预设 → UI 供应商列表（内置在前，自定义在后）。 */
export function loadState(
  modelsRaw: string | null,
  authRaw: string | null,
  presets: PresetLike[],
): UiProvider[] {
  const models = parseJson<ModelsJson>(modelsRaw, {});
  const auth = parseJson<AuthJson>(authRaw, {});
  const providers = models.providers ?? {};

  const builtIns: UiProvider[] = presets.map((p) => {
    const api = providers[p.id]?.api ?? p.api;
    return {
      id: p.id,
      name: providers[p.id]?.name ?? p.name,
      builtIn: true,
      _source: providers[p.id], _document: models,
      modelOverrides: providers[p.id]?.modelOverrides,
      api,
      baseUrl: providers[p.id]?.baseUrl,
      apiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey,
      _initialApiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey,
      headers: providers[p.id]?.headers,
      models: (providers[p.id]?.models ?? []).map((m) => toUiModel(m, api)),
    };
  });

  const presetIds = new Set(presets.map((p) => p.id));
  const customs: UiProvider[] = Object.entries(providers)
    .filter(([id]) => !presetIds.has(id))
    .map(([id, c]) => ({
      id,
      name: c.name ?? id,
      builtIn: false,
      _source: c, _document: models, modelOverrides: c.modelOverrides,
      api: c.api,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey ?? auth[id]?.key,
      headers: c.headers,
      models: (c.models ?? []).map((m) => toUiModel(m, c.api)),
    }));

  return [...builtIns, ...customs];
}

/**
 * UI 列表 → models.json。
 * 内置: API Key 不再写 auth.json——凭据归官方 CredentialStore 所有，由
 *       setProviderApiKey / login 写入；仅当有 baseUrl/自定义模型/请求头时才写 models.json 段。
 * 自定义: 整段写 models.json（含 apiKey，Pi schema 要求）。
 */
/** Published by pi (1.2+); `$schema` is an accepted top-level key of models.json. */
export const MODELS_JSON_SCHEMA = 'https://pi.dev/schemas/models.schema.json';

export function serializeState(providers: UiProvider[]): { modelsJson: string } {
  const modelsProviders: Record<string, ProviderEntry> = {};

  for (const p of providers) {
    const overrides = p.modelOverrides ? Object.fromEntries(Object.entries(p.modelOverrides).map(([id, value]) => {
      const { _advancedDrafts, _advancedErrors, ...options } = value;
      if (_advancedErrors && Object.keys(_advancedErrors).length) throw new Error(Object.values(_advancedErrors as Record<string, string>)[0]);
      return [id, options];
    }).filter(([, value]) => Object.keys(value).length)) : undefined;
    const models = p.models.map((m) => serializeModel(m, p.api));
    if (p.builtIn) {
      const hasHeaders = p.headers && Object.keys(p.headers).length > 0;
      if (p._source || p.baseUrl || models.length > 0 || hasHeaders || (p.modelOverrides && Object.keys(p.modelOverrides).length)) {
        modelsProviders[p.id] = {
          ...p._source,
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(hasHeaders ? { headers: p.headers } : {}),
          ...(models.length ? { models } : {}),
          ...(overrides ? { modelOverrides: overrides } : {}),
        };
        if (!p.baseUrl) delete modelsProviders[p.id].baseUrl;
        if (!hasHeaders) delete modelsProviders[p.id].headers;
        if (!models.length) delete modelsProviders[p.id].models;
        if (!overrides || !Object.keys(overrides).length) delete modelsProviders[p.id].modelOverrides;
        if (p.apiKey !== p._initialApiKey) delete modelsProviders[p.id].apiKey;
        if (!Object.keys(modelsProviders[p.id]).length) delete modelsProviders[p.id];
      }
    } else {
      modelsProviders[p.id] = {
        ...p._source,
        name: p.name,
        ...(p.api ? { api: p.api } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        headers: p._source && JSON.stringify(p.headers) === JSON.stringify(p._source.headers) ? p._source.headers : withDefaultUserAgent(p.headers),
        models,
        ...(overrides ? { modelOverrides: overrides } : {}),
      };
      if (p._source?.name === undefined && p.name === p.id) delete modelsProviders[p.id].name;
      for (const key of ['api', 'baseUrl', 'apiKey'] as const) if (!p[key]) delete modelsProviders[p.id][key];
      if (!overrides || !Object.keys(overrides).length) delete modelsProviders[p.id].modelOverrides;
    }
  }

  const document = { ...providers[0]?._document, $schema: MODELS_JSON_SCHEMA, providers: modelsProviders };
  validateModelsAdvancedOptions(document);
  return {
    // pi 1.2+ publishes the schema; editors use it to validate and complete models.json.
    modelsJson: JSON.stringify(document, null, 2),
  };
}
