import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { remoteTransportKind, type McpServerConfig } from "./config.js";
import {
  authorizationIssMatches,
  callbackUrl,
  credentialKey,
  mergeStepUpScope,
  normalizeOAuthTokenFields,
  oauthConfigError,
  OAUTH_DYNAMIC_CLIENT_NAME,
  type McpOAuthConfig,
} from "./oauthRules.js";

export interface OAuthConnectHooks {
  /** 登录地址已经生成。打开浏览器失败时也要先记下，面板才能复制。 */
  onLoginUrl?: (url: string) => void;
  /** 测试或宿主可以替换系统浏览器。缺省用操作系统打开。 */
  openLoginUrl?: (url: string) => Promise<void>;
}

export interface McpTransportAuth {
  authProvider?: OAuthClientProvider;
  fetch?: FetchLike;
}

interface OAuthCredentialRecord {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  client_information?: OAuthClientInformationMixed;
  code_verifier?: string;
  discovery?: OAuthDiscoveryState;
  /** 未配置 callbackPort / callbackUrl 时记住实际端口，避免每次登录换 redirect URI。 */
  callback_port?: number;
}

type CallbackResult = { code: string; iss: string } | { error: string };

interface OAuthSession {
  transport: Transport;
  exchangeCode: () => Promise<void>;
  nextTransport: () => Transport;
  close: () => Promise<void>;
}

export function oauthCredentialPath(): string {
  return join(homedir(), ".pi", "agent", "mcp-auth.json");
}

export function remoteRequestInit(headers?: Record<string, string>): { requestInit?: RequestInit } {
  if (!headers) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    if (name && typeof value === "string") clean[name] = value;
  }
  if (Object.keys(clean).length === 0) return {};
  return { requestInit: { headers: clean } };
}

export function createMcpTransport(s: McpServerConfig, authOptions?: McpTransportAuth): Transport {
  if (s.transport === "stdio" || !s.url) {
    return new StdioClientTransport({
      command: s.command ?? "",
      args: s.args ?? [],
      ...(s.cwd ? { cwd: s.cwd } : {}),
      env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
    });
  }
  const opts: StreamableHTTPClientTransportOptions = {
    ...remoteRequestInit(s.headers),
    ...(authOptions?.authProvider ? { authProvider: authOptions.authProvider } : {}),
    ...(authOptions?.fetch ? { fetch: authOptions.fetch } : {}),
  };
  const kind = s.transport === "sse" ? "sse" : remoteTransportKind(s.url);
  if (kind === "sse") return new SSEClientTransport(new URL(s.url), opts);
  return new StreamableHTTPClientTransport(new URL(s.url), opts);
}

/**
 * HTTP / SSE 且配置了 oauth 时，走 SDK 的 `auth` 与 `OAuthClientProvider`。
 * 第一次连接若需要登录，会在浏览器回来之后先核对 iss，再交换 code，然后只再连一次。
 * 没有 oauth 时直接连，不额外包一层。
 */
export async function establishMcpConnection<T>(
  server: McpServerConfig,
  hooks: OAuthConnectHooks | undefined,
  connectTransport: (transport: Transport) => Promise<T>,
): Promise<T> {
  const session = await startOAuthSession(server, hooks);
  if (!session) return connectTransport(createMcpTransport(server));
  try {
    try {
      return await connectTransport(session.transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      await session.exchangeCode();
      return await connectTransport(session.nextTransport());
    }
  } finally {
    await session.close();
  }
}

async function startOAuthSession(server: McpServerConfig, hooks: OAuthConnectHooks | undefined): Promise<OAuthSession | undefined> {
  if ((server.transport !== "http" && server.transport !== "sse") || !server.url || server.oauth == null) return undefined;
  const config = parseOAuthConfig(server.oauth);
  const error = oauthConfigError(config);
  if (error) throw new Error(error);
  const store = new CredentialFile(credentialKey(server.name, server.url));
  const savedPort = store.read().callback_port;
  const callback = await bindCallback(
    config.callbackUrl || config.callbackPort != null || typeof savedPort !== "number" || savedPort <= 0
      ? config
      : { ...config, callbackPort: savedPort },
  );
  const boundPort = Number(new URL(callback.redirectUrl).port);
  if (!config.callbackUrl && config.callbackPort == null && Number.isFinite(boundPort)) {
    store.update((record) => {
      record.callback_port = boundPort;
    });
  }
  const fetchFn = createOAuthFetch(() => store.read().scope);
  const provider = new FileOAuthProvider(config, callback.redirectUrl, store, hooks);
  const authOptions = { authProvider: provider, fetch: fetchFn };
  const serverUrl = server.url;
  return {
    transport: createMcpTransport(server, authOptions),
    nextTransport: () => createMcpTransport(server, authOptions),
    async exchangeCode() {
      const pending = await callback.result;
      if ("error" in pending) throw new Error(pending.error);
      // 交换 code 之前核对 iss。对不上就停，不调用 auth() 的带 code 路径。
      if (!authorizationIssMatches(provider.expectedIssuer(), pending.iss)) {
        throw new Error("授权服务器 iss 不匹配");
      }
      await auth(provider, { serverUrl, authorizationCode: pending.code, fetchFn });
    },
    close: callback.close,
  };
}

function parseOAuthConfig(value: unknown): McpOAuthConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof raw[key] === "string" ? raw[key] : undefined);
  const port = raw.callbackPort;
  return {
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    callbackPort: typeof port === "number" && Number.isFinite(port) ? port : undefined,
    callbackUrl: text("callbackUrl"),
    scope: text("scope"),
    clientName: text("clientName"),
    authServerMetadataUrl: text("authServerMetadataUrl"),
    clientRegistration: text("clientRegistration"),
    clientMetadataUrl: text("clientMetadataUrl"),
  };
}

function callbackTarget(config: McpOAuthConfig): URL {
  if (config.callbackUrl) return new URL(config.callbackUrl);
  if (typeof config.callbackPort === "number") return new URL(`http://127.0.0.1:${config.callbackPort}/callback`);
  return new URL("http://127.0.0.1:0/callback");
}

function listenHost(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === "[::1]" || host === "::1") return "::1";
  if (host === "localhost") return "127.0.0.1";
  return hostname;
}

async function bindCallback(config: McpOAuthConfig): Promise<{ redirectUrl: string; result: Promise<CallbackResult>; close: () => Promise<void> }> {
  const target = callbackTarget(config);
  const configuredError = config.callbackUrl ? callbackUrl(config.callbackUrl) : undefined;
  if (configuredError) throw new Error(configuredError);
  let resolveResult: (value: CallbackResult) => void = () => {};
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });
  let settled = false;
  const settle = (value: CallbackResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const expectedPath = target.pathname.replace(/\/+$/, "") || "/";
  const server = createServer((req, res) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? "/", target);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const path = requestUrl.pathname.replace(/\/+$/, "") || "/";
    if (path !== expectedPath) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const code = requestUrl.searchParams.get("code");
    const oauthError = requestUrl.searchParams.get("error");
    if (!code && !oauthError) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = oauthError ? 400 : 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(oauthError ? "登录没有完成，可以关闭此页面。" : "登录完成，可以关闭此页面。");
    if (oauthError) settle({ error: requestUrl.searchParams.get("error_description") || oauthError });
    else settle({ code: code ?? "", iss: requestUrl.searchParams.get("iss") ?? "" });
  });
  const port = target.port === "" ? 80 : Number(target.port);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, listenHost(target.hostname), () => resolve());
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  const redirect = new URL(target.toString());
  if (address && typeof address === "object") redirect.port = String(address.port);
  return {
    redirectUrl: redirect.toString(),
    result,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

class CredentialFile {
  constructor(private readonly key: string) {}

  read(): OAuthCredentialRecord {
    return { ...(loadCredentialStore()[this.key] ?? {}) };
  }

  update(change: (record: OAuthCredentialRecord) => void): void {
    const store = loadCredentialStore();
    const record = { ...(store[this.key] ?? {}) };
    change(record);
    store[this.key] = record;
    saveCredentialStore(store);
  }
}

function loadCredentialStore(): Record<string, OAuthCredentialRecord> {
  const path = oauthCredentialPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, OAuthCredentialRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function saveCredentialStore(store: Record<string, OAuthCredentialRecord>): void {
  const path = oauthCredentialPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

class FileOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  constructor(
    private readonly config: McpOAuthConfig,
    private readonly redirect: string,
    private readonly store: CredentialFile,
    private readonly hooks: OAuthConnectHooks | undefined,
  ) {
    const metadataUrl = config.clientMetadataUrl?.trim();
    if (config.clientRegistration === "cimd" && metadataUrl) this.clientMetadataUrl = metadataUrl;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.config.scope?.trim();
    const secret = this.config.clientSecret || this.store.read().client_information?.client_secret;
    return {
      redirect_uris: [this.redirect],
      client_name: this.config.clientName?.trim() || OAUTH_DYNAMIC_CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: secret ? "client_secret_post" : "none",
      ...(scope ? { scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const saved = this.store.read().client_information;
    if (saved?.client_id) return saved;
    if (!this.config.clientId) return undefined;
    return {
      client_id: this.config.clientId,
      ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
    };
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.store.update((record) => {
      record.client_information = clientInformation;
    });
  }

  tokens(): OAuthTokens | undefined {
    const record = this.store.read();
    if (!record.access_token) return undefined;
    const tokens: OAuthTokens = { access_token: record.access_token, token_type: "Bearer" };
    if (record.refresh_token) tokens.refresh_token = record.refresh_token;
    if (record.scope) tokens.scope = record.scope;
    if (typeof record.expires_at === "number") {
      const expiresIn = record.expires_at - Math.floor(Date.now() / 1000);
      if (expiresIn > 0) tokens.expires_in = expiresIn;
    }
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const normalized = normalizeOAuthTokenFields({ ...tokens });
    this.store.update((record) => {
      if (typeof normalized.access_token === "string") record.access_token = normalized.access_token;
      if (typeof normalized.refresh_token === "string") record.refresh_token = normalized.refresh_token;
      if (typeof normalized.scope === "string") record.scope = normalized.scope;
      if (typeof normalized.expires_in === "number" && Number.isFinite(normalized.expires_in)) {
        record.expires_at = Math.floor(Date.now() / 1000) + normalized.expires_in;
      }
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();
    this.hooks?.onLoginUrl?.(url);
    try {
      await (this.hooks?.openLoginUrl ?? openSystemBrowser)(url);
    } catch (error) {
      const failed = new Error(error instanceof Error ? error.message : "无法打开浏览器");
      (failed as Error & { loginUrl?: string }).loginUrl = url;
      throw failed;
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update((record) => {
      record.code_verifier = codeVerifier;
    });
  }

  codeVerifier(): string {
    const value = this.store.read().code_verifier;
    if (!value) throw new Error("缺少 PKCE code_verifier");
    return value;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const saved = this.store.read().discovery;
    if (saved?.authorizationServerUrl) return saved;
    const metadataUrl = this.config.authServerMetadataUrl;
    if (!metadataUrl) return undefined;
    const response = await fetch(metadataUrl);
    if (!response.ok) throw new Error(`授权服务器元数据获取失败: ${response.status}`);
    const metadata = await response.json() as AuthorizationServerMetadata;
    const authorizationServerUrl = typeof metadata.issuer === "string" && metadata.issuer
      ? metadata.issuer
      : new URL(metadataUrl).origin;
    const state: OAuthDiscoveryState = { authorizationServerUrl, authorizationServerMetadata: metadata };
    this.store.update((record) => {
      record.discovery = state;
    });
    return state;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.update((record) => {
      record.discovery = state;
    });
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    this.store.update((record) => {
      if (scope === "all" || scope === "tokens") {
        delete record.access_token;
        delete record.refresh_token;
        delete record.expires_at;
        delete record.scope;
      }
      if (scope === "all" || scope === "client") delete record.client_information;
      if (scope === "all" || scope === "verifier") delete record.code_verifier;
      if (scope === "all" || scope === "discovery") delete record.discovery;
    });
  }

  expectedIssuer(): string {
    const discovery = this.store.read().discovery;
    const issuer = discovery?.authorizationServerMetadata?.issuer;
    if (typeof issuer === "string" && issuer) return issuer;
    return discovery?.authorizationServerUrl ?? "";
  }
}

function createOAuthFetch(grantedScope: () => string | undefined): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    const www = response.headers.get("WWW-Authenticate");
    if (response.status === 401 && www) {
      const rewritten = rewriteInsufficientScope(www, grantedScope());
      if (rewritten !== www) {
        const headers = new Headers(response.headers);
        headers.set("WWW-Authenticate", rewritten);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
    }
    if (!isTokenRequest(init)) return response;
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const normalized = normalizeOAuthTokenFields(parsed as Record<string, unknown>);
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify(normalized), { status: response.status, statusText: response.statusText, headers });
      }
    } catch {
      // 不是 JSON 时按原文交回去。
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function isTokenRequest(init?: RequestInit): boolean {
  const body = init?.body;
  if (typeof body === "string") return body.includes("grant_type=");
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.has("grant_type");
  return false;
}

function rewriteInsufficientScope(header: string, granted: string | undefined): string {
  if (!granted) return header;
  if (!/error=(?:"insufficient_scope"|insufficient_scope)(?:\s|,|$)/i.test(header)) return header;
  const match = header.match(/scope=(?:"([^"]*)"|([^\s,]+))/i);
  const required = match?.[1] ?? match?.[2] ?? "";
  const merged = mergeStepUpScope(granted, required);
  if (!match) return `${header}, scope="${merged}"`;
  return header.replace(match[0], `scope="${merged}"`);
}

function openSystemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" })
      : process.platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore" })
        : spawn("xdg-open", [url], { stdio: "ignore" });
    child.once("error", (error) => finish(error));
    child.once("spawn", () => {
      child.unref();
      finish();
    });
  });
}

export function loginUrlOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("loginUrl" in error)) return undefined;
  const value = (error as { loginUrl?: unknown }).loginUrl;
  return typeof value === "string" && value ? value : undefined;
}
