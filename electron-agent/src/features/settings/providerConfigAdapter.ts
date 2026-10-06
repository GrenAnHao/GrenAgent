import { allowedCompatKeys, showsThinkingFormat } from './modelCompatCatalog';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** models.json 模型 compat：按当前 API 过滤后写入。对象型路由字段用字符串编辑，保存时再解析。 */
export type ModelCompat = Record<string, unknown>;

export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UiModel {
  id: string;
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
  /** 用户自定义/追加的模型（不含 Pi 内置只读模型） */
  models: UiModel[];
}

/** models.json 里的单个模型条目（落盘形态）：含 pi 的 compat，不含 UI 专用的 thinkingFormat / forceAdaptiveThinking。 */
interface ModelEntry {
  id: string;
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
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: ModelEntry[];
}

// 各兼容协议「官方原生推理档位」→ models.json 的 thinkingLevelMap（pi 内部档位 → 供应商原生取值，null = 隐藏）。
// pi 内部档位只作传输；选择器直接拿这里的供应商原生取值当标签，做到照搬各家而非迁就 pi。依据各家 API 文档：
//  - OpenAI reasoning_effort: minimal/low/medium/high/xhigh（pi 同名直传）
//  - Anthropic effort: low/medium/high/xhigh/max（无 minimal；pi 5 个推理档整体上移）。不按模型 ID 裁剪，默认全部露出。
//  - Gemini thinking_level: minimal/low/medium/high（无 xhigh）
const OPENAI_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
const GOOGLE_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };
const ANTHROPIC_THINKING_MAP: ThinkingLevelMap = { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' };
const CURSOR_THINKING_MAP: ThinkingLevelMap = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

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
    case 'cursor-agent':
      return CURSOR_THINKING_MAP;
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
    if (!m.reasoning) return m;
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

function serializeCompat(m: UiModel, api: string | undefined): ModelCompat | undefined {
  const allowed = allowedCompatKeys(api);
  const merged: ModelCompat = { ...(m.compat ?? {}) };
  if (showsThinkingFormat(api) && m.thinkingFormat) merged.thinkingFormat = m.thinkingFormat;
  if (api === 'anthropic-messages' && m.reasoning) {
    merged.forceAdaptiveThinking =
      m.forceAdaptiveThinking ?? (merged.forceAdaptiveThinking as boolean | undefined) ?? true;
  }

  const out: ModelCompat = {};
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
function toUiModel(m: ModelEntry, api: string | undefined): UiModel {
  const { compat, ...rest } = m;
  const thinkingFormat = typeof compat?.thinkingFormat === 'string' ? compat.thinkingFormat : undefined;
  const uiCompat: ModelCompat = { ...(compat ?? {}) };
  if (uiCompat.openRouterRouting !== undefined) uiCompat.openRouterRouting = stringifyRoutingObject(uiCompat.openRouterRouting);
  if (uiCompat.vercelGatewayRouting !== undefined) uiCompat.vercelGatewayRouting = stringifyRoutingObject(uiCompat.vercelGatewayRouting);
  if (uiCompat.chatTemplateKwargs !== undefined) uiCompat.chatTemplateKwargs = stringifyRoutingObject(uiCompat.chatTemplateKwargs);
  const model: UiModel = {
    ...rest,
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
/**
 * Pi 的 models.json schema 要求 cost 一旦出现，input/output/cacheRead/cacheWrite 四个数字都必须在。
 * 设置页只编辑输入/输出价格；缺任一字段时整份文件会被拒绝，自定义供应商会全部从模型列表消失。
 */
function completeCost(cost: ModelCost | undefined): ModelCost | undefined {
  if (!cost) return undefined;
  const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (rates.every((value) => typeof value !== 'number')) return undefined;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
  };
}

function serializeModel(m: UiModel, api: string | undefined): ModelEntry {
  const { forceAdaptiveThinking, thinkingFormat, compat, cost, ...rest } = m;
  void forceAdaptiveThinking;
  void thinkingFormat;
  void compat;
  const priced = completeCost(cost);
  const base: ModelEntry = priced ? { ...rest, cost: priced } : { ...rest };
  if (!m.reasoning) return { ...base, thinkingLevelMap: undefined, compat: serializeCompat(m, api) };
  return {
    ...base,
    thinkingLevelMap: m.thinkingLevelMap ?? defaultThinkingLevelMap(api, m.id),
    compat: serializeCompat(m, api),
  };
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
      api,
      baseUrl: providers[p.id]?.baseUrl,
      apiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey,
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
      api: c.api,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey ?? auth[id]?.key,
      headers: c.headers,
      models: (c.models ?? []).map((m) => toUiModel(m, c.api)),
    }));

  return [...builtIns, ...customs];
}

/**
 * UI 列表 → { modelsJson, authJson }。
 * 内置: Key 写 auth.json；仅当有 baseUrl/自定义模型时才写 models.json 段。
 * 自定义: 整段写 models.json（含 apiKey，Pi schema 要求）。
 */
export function serializeState(providers: UiProvider[]): { modelsJson: string; authJson: string } {
  const modelsProviders: Record<string, ProviderEntry> = {};
  const auth: AuthJson = {};

  for (const p of providers) {
    const models = p.models.map((m) => serializeModel(m, p.api));
    if (p.builtIn) {
      if (p.apiKey) auth[p.id] = { type: 'api_key', key: p.apiKey };
      const hasHeaders = p.headers && Object.keys(p.headers).length > 0;
      if (p.baseUrl || models.length > 0 || hasHeaders) {
        modelsProviders[p.id] = {
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(hasHeaders ? { headers: p.headers } : {}),
          ...(models.length ? { models } : {}),
        };
      }
    } else {
      modelsProviders[p.id] = {
        name: p.name,
        ...(p.api ? { api: p.api } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        headers: withDefaultUserAgent(p.headers),
        models,
      };
    }
  }

  return {
    modelsJson: JSON.stringify({ providers: modelsProviders }, null, 2),
    authJson: JSON.stringify(auth, null, 2),
  };
}
