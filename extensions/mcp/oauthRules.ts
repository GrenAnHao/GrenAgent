// MCP OAuth 的纯规则：回调地址、iss、scope 提升、令牌字段、配置错误、凭据键。
// 不发网络请求，也不读写凭据文件。

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  authServerMetadataUrl?: string;
  clientRegistration?: string;
  clientMetadataUrl?: string;
}

/** 动态注册时的客户端名。调用方在没写 clientName 时用这个。 */
export const OAUTH_DYNAMIC_CLIENT_NAME = "GrenAgent";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** 接受则返回 undefined，否则返回错误说明。 */
export function callbackUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "回调地址不是合法 URL";
  }
  if (url.protocol !== "http:") return "回调地址必须是 http";
  if (!isLoopbackHost(url.hostname)) return "回调地址必须是 localhost、127.0.0.1 或 [::1]";
  if (url.search) return "回调地址不能带 query";
  if (url.hash) return "回调地址不能带 fragment";
  return undefined;
}

/**
 * 授权响应里的 iss。actual 为空时跳过（旧授权服务器不回 iss）。
 * 两边都有且不同则拒绝，调用方不得继续交换 code。
 */
export function authorizationIssMatches(expected: string | undefined | null, actual: string | undefined | null): boolean {
  if (actual == null || actual === "") return true;
  if (expected == null || expected === "") return true;
  return expected === actual;
}

/** 已授予的 scope 保留，再补上这次还缺的。 */
export function mergeStepUpScope(granted: string, required: string): string {
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const part of `${granted} ${required}`.split(/\s+/)) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    scopes.push(part);
  }
  return scopes.join(" ");
}

/** 空字符串和 null 按缺失处理，避免把 `scope: ""` 交给会报 Invalid scope 的解析。 */
export function normalizeOAuthTokenFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

export function oauthConfigError(oauth: McpOAuthConfig): string | undefined {
  if (oauth.clientRegistration === "cimd" && !oauth.clientMetadataUrl?.trim()) {
    return "clientRegistration 为 cimd 时必须提供 clientMetadataUrl";
  }
  if (oauth.callbackUrl) {
    const error = callbackUrl(oauth.callbackUrl);
    if (error) return error;
  }
  if (oauth.authServerMetadataUrl) {
    const error = metadataUrlError(oauth.authServerMetadataUrl);
    if (error) return error;
  }
  return undefined;
}

function metadataUrlError(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "authServerMetadataUrl 不是合法 URL";
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  return "authServerMetadataUrl 必须是 https，本机回环除外";
}

/** 同一 URL 的两台服务器各用各的键。 */
export function credentialKey(name: string, url: string): string {
  return JSON.stringify([name, url]);
}

/** `auth: { provider }` 里的供应商 id。不是这种形状则没有。 */
export function authProviderName(auth: unknown): string | undefined {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  const provider = (auth as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

/**
 * 接受则返回 undefined。
 * 项目级 mcp.json 不能声明 auth.provider。
 * 其余来源的 URL 必须是 https，或者 http 落在本机回环上。
 */
export function authProviderError(input: { source: string; provider: string; url?: string }): string | undefined {
  if (input.source === "project") return "项目级 mcp.json 不能使用 auth.provider";
  let url: URL | undefined;
  try {
    url = input.url ? new URL(input.url) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol === "https:") return undefined;
  if (url?.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  return "auth.provider 需要 https，或本机回环上的 http";
}
