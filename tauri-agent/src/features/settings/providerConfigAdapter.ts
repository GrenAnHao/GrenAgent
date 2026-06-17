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

interface ProviderEntry {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: UiModel[];
}

// 各兼容协议官方标准推理档位 → models.json 的 thinkingLevelMap（pi 档位 → 供应商取值，null = 不支持/隐藏）。
// 依据各家 API 文档：OpenAI reasoning_effort = minimal/low/medium/high（xhigh 仅 codex-max，隐藏）；
// Anthropic effort = low/medium/high/xhigh（无 minimal；pi 内部最高档即 xhigh，Anthropic 的 max 无对应内部档位故不单列）；
// Gemini thinking_level = minimal/low/medium/high（无 xhigh）。
const OPENAI_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };
const ANTHROPIC_THINKING_MAP: ThinkingLevelMap = { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
const GOOGLE_THINKING_MAP: ThinkingLevelMap = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null };

/** 按供应商 API 类型给出标准推理档位映射；勾「推理」时写入自定义模型，让 pi 按标准档位生效、不会钳回 off。 */
export function defaultThinkingLevelMap(api: string | undefined): ThinkingLevelMap | undefined {
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

  const builtIns: UiProvider[] = presets.map((p) => ({
    id: p.id,
    name: providers[p.id]?.name ?? p.name,
    builtIn: true,
    api: providers[p.id]?.api ?? p.api,
    baseUrl: providers[p.id]?.baseUrl,
    apiKey: auth[p.id]?.key ?? providers[p.id]?.apiKey,
    headers: providers[p.id]?.headers,
    models: providers[p.id]?.models ?? [],
  }));

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
      models: c.models ?? [],
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
    if (p.builtIn) {
      if (p.apiKey) auth[p.id] = { type: 'api_key', key: p.apiKey };
      const hasHeaders = p.headers && Object.keys(p.headers).length > 0;
      if (p.baseUrl || p.models.length > 0 || hasHeaders) {
        modelsProviders[p.id] = {
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(hasHeaders ? { headers: p.headers } : {}),
          ...(p.models.length ? { models: p.models } : {}),
        };
      }
    } else {
      modelsProviders[p.id] = {
        name: p.name,
        ...(p.api ? { api: p.api } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        headers: withDefaultUserAgent(p.headers),
        models: p.models,
      };
    }
  }

  return {
    modelsJson: JSON.stringify({ providers: modelsProviders }, null, 2),
    authJson: JSON.stringify(auth, null, 2),
  };
}
