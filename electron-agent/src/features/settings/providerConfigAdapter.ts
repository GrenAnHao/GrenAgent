export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface UiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
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

/** models.json 里的单个模型条目（落盘形态）：含 pi 的 compat，不含 UI 专用的 forceAdaptiveThinking。 */
interface ModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: { forceAdaptiveThinking?: boolean };
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
//  - Anthropic effort: low/medium/high/xhigh/max（无 minimal；pi 5 个推理档整体上移映射）。最高档随模型而异：
//    仅 opus-4-6 系支持 "max"，其余（4-7/4-8/fable-5/sonnet-4-6 等）最高到 "xhigh"——故非 4-6 把 pi-xhigh 隐藏(null)，
//    顶档落在 pi-high→原生 "xhigh"，避免发出该模型不支持的 "max" 被拒。见 anthropicThinkingLevelMap。
//  - Gemini thinking_level: minimal/low/medium/high（无 xhigh）
const OPENAI_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
const GOOGLE_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };

/** 该 anthropic 模型最高档是否支持原生 effort "max"（仅 opus-4-6 系；其余封顶到 "xhigh"）。 */
function anthropicSupportsMaxEffort(modelId: string | undefined): boolean {
  return !!modelId && /opus-4-6/i.test(modelId);
}

/** anthropic 原生 effort 阶梯（pi 档位整体上移）；最高档按模型能力：4-6 用 "max"，其余封顶 "xhigh"（pi-xhigh 隐藏）。 */
function anthropicThinkingLevelMap(modelId: string | undefined): ThinkingLevelMap {
  return {
    minimal: 'low',
    low: 'medium',
    medium: 'high',
    high: 'xhigh',
    xhigh: anthropicSupportsMaxEffort(modelId) ? 'max' : null,
  };
}

/**
 * 按供应商 API 类型给出官方原生推理档位映射；勾「推理」时写入自定义模型，让 pi 按各家原生档位生效、不会钳回 off。
 * anthropic 的最高档与具体模型有关，故可传入 modelId（缺省时按「不支持 max」封顶到 xhigh）。
 */
export function defaultThinkingLevelMap(api: string | undefined, modelId?: string): ThinkingLevelMap | undefined {
  switch (api) {
    case 'anthropic-messages':
      return anthropicThinkingLevelMap(modelId);
    case 'google-generative-ai':
      return GOOGLE_THINKING_MAP;
    case 'openai-completions':
    case 'openai-responses':
      return OPENAI_THINKING_MAP;
    default:
      return undefined;
  }
}

/** models.json 模型条目 → UI 模型：把 compat.forceAdaptiveThinking 还原成 UI 字段（anthropic 推理模型缺省视为开启）。 */
function toUiModel(m: ModelEntry, api: string | undefined): UiModel {
  const { compat, ...rest } = m;
  if (api === 'anthropic-messages' && m.reasoning) {
    return { ...rest, forceAdaptiveThinking: compat?.forceAdaptiveThinking ?? true };
  }
  return { ...rest };
}

/**
 * UI 模型 → models.json 模型条目：
 * - 推理模型按供应商 API 协议（含模型）重写 thinkingLevelMap；非推理模型清掉映射。
 * - anthropic 推理模型据 forceAdaptiveThinking（缺省 true）写 compat.forceAdaptiveThinking，决定是否发送 effort。
 */
function serializeModel(m: UiModel, api: string | undefined): ModelEntry {
  const { forceAdaptiveThinking, ...rest } = m;
  if (!m.reasoning) return { ...rest, thinkingLevelMap: undefined };
  const entry: ModelEntry = { ...rest, thinkingLevelMap: defaultThinkingLevelMap(api, m.id) };
  if (api === 'anthropic-messages') {
    entry.compat = { forceAdaptiveThinking: forceAdaptiveThinking ?? true };
  }
  return entry;
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

function withDefaultUserAgent(headers: Record<string, string> | undefined): Record<string, string> {
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
    // 推理模型按供应商 API 协议 + 模型重写官方原生档位映射与 compat；非推理模型清掉映射。保存即刷新，无需手动重勾。
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
