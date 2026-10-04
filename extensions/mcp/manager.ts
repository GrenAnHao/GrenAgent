// 进程级 MCP 连接管理器：跨会话存活，绝不引用 pi/ctx。
// 按 workspace 分 Map，同一 workspace 共享一套 manager。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getAllConfig, getConfig, refreshConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { expandServerVars, injectDefaultServers, type McpLayerEntry, type McpServerConfig, parseMcpLayerEntries, parseMcpServers, sanitize } from "./config.js";
import { mergeMcpLayers, type McpMergeServer } from "./merge.js";
import { authProviderName } from "./oauthRules.js";
import { establishMcpConnection, loginUrlOf, type OAuthConnectHooks } from "./transport.js";
import { diffServers } from "./diff.js";
import { serverNamesConflict } from "./naming.js";
import type { ProbeResult } from "./probe.js";
import { appendCappedLog } from "./logRotate.js";
import { readToolsCache, writeToolsCacheEntry } from "./toolsCache.js";
import { mcpConfigPaths, watchMcpConfigFiles } from "../resource-manager/mcp-store.js";

export const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? "60000") || 60000;

function mcpLogPath(): string {
  return join(homedir(), ".pi", "agent", "mcp.log");
}

function logMcp(server: string, event: string, detail?: string): void {
  const text = detail ? `${event} ${detail}` : event;
  try {
    appendCappedLog(mcpLogPath(), `${new Date().toISOString()} [${server}] ${text}\n`);
  } catch {
    // 日志写失败不打断连接
  }
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export type McpStatus = "connecting" | "connected" | "failed";
export type McpAuthKind = "none" | "oauth" | "provider";
export interface ServerEntry {
  status: McpStatus;
  error?: string;
  tools: McpToolDef[];
  exposure?: string;
  toolExposure?: Record<string, string>;
  description?: string;
  auth?: McpAuthKind;
  /** 服务器配置的调用超时，单位秒。缺省时调用按 60 秒计。 */
  timeout?: number;
  /** 需要登录时的授权地址。打开浏览器失败时仍保留，供面板复制。 */
  loginUrl?: string;
  /** 连接后是否列出了资源或资源模板。列举失败为 false，不因此把服务器标失败。 */
  hasResources?: boolean;
}
export interface McpSnapshot {
  servers: Map<string, ServerEntry>;
  /** 来自 mergeMcpLayers。缺省 true：项目层优先，两层都没写则为 true。 */
  autoEnableCodemode?: boolean;
  /** 扩展登记被配置文件盖住，或和已有服务器只差 - / _ 时的说明。 */
  errors?: string[];
}

/** 管理器需要的最小 MCP 客户端能力（真实 SDK Client 结构兼容）。 */
export interface McpClient {
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
    onProgress?: () => void;
  }): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
  listResources?(params?: { cursor?: string }): Promise<{ resources?: unknown[]; nextCursor?: string }>;
  listResourceTemplates?(params?: { cursor?: string }): Promise<{ resourceTemplates?: unknown[]; nextCursor?: string }>;
  readResource?(args: { uri: string }): Promise<{ contents?: Array<{ uri?: string; text?: string; blob?: string }> }>;
}

export type GetProviderToken = (provider: string) => Promise<string | undefined> | string | undefined;

export interface ManagerDeps {
  workspace?: string;
  connect?: (s: McpServerConfig, hooks?: OAuthConnectHooks) => Promise<McpClient>;
  readServers?: () => McpServerConfig[];
  watch?: (cb: () => void) => () => void;
  writeCache?: (name: string, r: ProbeResult) => void;
  /** 测试可预置。正式路径由 bind() 在 init 之前写入。 */
  getProviderToken?: GetProviderToken;
}

export interface McpManager {
  init(): void;
  reloadServer(name: string): Promise<void>;
  snapshot(): McpSnapshot;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  subscribe(listener: (snap: McpSnapshot) => void): () => void;
  /** 配置已落盘后立刻重读（不依赖 fs.watch）。未 init 时为空操作。 */
  reconcile(): void;
  closeAll(): void;
  /** 该服务器仍在连接时返回本次连接的 promise。已结束则没有。 */
  connectPromise(name: string): Promise<void> | undefined;
  /** 用扩展登记替换上一份。同名文件服务器保留，只差 - / _ 的名字不进入连接列表。 */
  applyExtensionServers(servers: McpServerConfig[]): Promise<void>;
  listResources(args: Record<string, unknown>): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  listResourceTemplates(args: Record<string, unknown>): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  readResource(args: Record<string, unknown>): Promise<{
    content?: unknown;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  /**
   * 现读供应商登录态。bind() 把它设成读取进程内那一份 ModelRuntime。
   * 管理器只留这个函数，不留 pi 会话或运行时对象。
   */
  getProviderToken?: GetProviderToken;
}

const DEFAULT_CALL_TIMEOUT_SECONDS = 60;

function callTimeoutMs(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return timeoutSeconds * 1000;
  }
  return DEFAULT_CALL_TIMEOUT_SECONDS * 1000;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function callWithProgressTimeout<T>(run: (onProgress: () => void) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = setTimeout(expire, timeoutMs);
    function expire() {
      if (settled) return;
      settled = true;
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }
    function onProgress() {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(expire, timeoutMs);
    }
    run(onProgress).then(
      (value) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

async function realConnect(s: McpServerConfig, hooks?: OAuthConnectHooks): Promise<McpClient> {
  return establishMcpConnection(s, hooks, async (transport) => {
    const client = new Client({ name: "grenagent", version: "0.1.0" });
    try {
      await withTimeout(client.connect(transport), MCP_TIMEOUT_MS);
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    return {
      listTools: () => client.listTools(),
      callTool: async (args) => {
        const timeoutMs = callTimeoutMs(s.timeout);
        const result = await client.callTool(
          { name: args.name, arguments: args.arguments },
          undefined,
          {
            timeout: timeoutMs,
            resetTimeoutOnProgress: true,
            onprogress: () => args.onProgress?.(),
          },
        );
        const raw = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
        return {
          content: "content" in result ? raw.content : undefined,
          isError: raw.isError,
          structuredContent: raw.structuredContent,
        };
      },
      listResources: (params) => client.listResources(params),
      listResourceTemplates: (params) => client.listResourceTemplates(params),
      readResource: (args) => client.readResource(args),
      close: () => client.close(),
    };
  });
}

const managers = new Map<string, McpManager>();
const alsConfigByWorkspace = new Map<string, Readonly<Record<string, string>>>();

const LIVE_MCP_FLAG = "PI_MCP_CONFIG_LIVE";

function rememberAlsConfig(workspace: string): void {
  const als = currentWorkspaceContext();
  if (!als) return;
  const prev = alsConfigByWorkspace.get(workspace);
  // 中途 upsert 写入的 live 快照优先于回合开始时的 ALS PI_MCP_CONFIG。
  if (prev?.[LIVE_MCP_FLAG] === "1") {
    alsConfigByWorkspace.set(workspace, { ...als.config, PI_MCP_CONFIG: prev.PI_MCP_CONFIG, [LIVE_MCP_FLAG]: "1" });
    return;
  }
  alsConfigByWorkspace.set(workspace, als.config);
}

/** 配置落盘后用完整 runtime 列表替换冻住的 ALS 快照（含新增与删除）。 */
export function setLiveWorkspaceMcpConfig(workspace: string, raw: string): void {
  const prev = alsConfigByWorkspace.get(workspace) ?? {};
  alsConfigByWorkspace.set(workspace, { ...prev, PI_MCP_CONFIG: raw, [LIVE_MCP_FLAG]: "1" });
}

function overlayMcpServers(base: McpServerConfig[] | undefined, overlay: McpServerConfig[]): McpServerConfig[] {
  if (!base?.length) return overlay;
  if (!overlay.length) return base;
  const map = new Map<string, McpServerConfig>();
  for (const s of base) map.set(s.name, s);
  for (const s of overlay) map.set(s.name, s);
  return [...map.values()];
}

function readWorkspaceMcp(workspace: string): { servers: McpServerConfig[]; autoEnableCodemode: boolean } {
  rememberAlsConfig(workspace);
  const captured = alsConfigByWorkspace.get(workspace);
  const als = currentWorkspaceContext()?.config;
  const raw = captured?.[LIVE_MCP_FLAG] === "1"
    ? captured.PI_MCP_CONFIG
    : (als?.PI_MCP_CONFIG ?? captured?.PI_MCP_CONFIG ?? getConfig("PI_MCP_CONFIG"));
  const all = { ...getAllConfig(), ...captured, ...als };
  // PI_MCP_CONFIG 是回合开始时的 ALS 快照。桌面 MCP_SERVERS 覆盖同名项，
  // 再与全局/项目 mcp.json 合并（禁用名单、enabled:false、exposure）。
  const paths = mcpConfigPaths(workspace);
  const globalLayer = readScopeLayer(paths.global);
  const projectLayer = readScopeLayer(paths.project);
  const merged = mergeMcpLayers({
    desktop: overlayMcpServers(managedServers(raw), parseMcpServers(getConfig("MCP_SERVERS") ?? "")),
    global: globalLayer.servers,
    project: projectLayer.entries,
    globalDisabled: globalLayer.disabled,
    projectDisabled: projectLayer.disabled,
    globalAutoEnableCodemode: globalLayer.autoEnableCodemode,
    projectAutoEnableCodemode: projectLayer.autoEnableCodemode,
  });
  const servers = injectDefaultServers(
    merged.servers.filter(isRuntimeServer),
    all,
    process.platform,
    readToolsCache(),
    process.arch,
  );
  return { servers: expandServerVars(servers, workspace), autoEnableCodemode: merged.autoEnableCodemode };
}

function classifyAuth(server: { oauth?: unknown; auth?: unknown }): McpAuthKind {
  if (authProviderName(server.auth)) return "provider";
  if (server.oauth !== undefined && server.oauth !== null) return "oauth";
  return "none";
}

const MISSING_PROVIDER_TOKEN = "没有供应商登录态";

function usesProviderAuth(server: McpServerConfig): string | undefined {
  const provider = authProviderName(server.auth);
  if (!provider) return undefined;
  if ((server.transport !== "http" && server.transport !== "sse") || !server.url) return undefined;
  return provider;
}

async function readProviderToken(read: GetProviderToken | undefined, provider: string): Promise<string | undefined> {
  if (!read) return undefined;
  try {
    const token = await read(provider);
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function serverSnapshotMeta(server: McpServerConfig): Pick<ServerEntry, "exposure" | "toolExposure" | "description" | "auth" | "timeout"> {
  return {
    exposure: server.exposure,
    ...(server.toolExposure ? { toolExposure: { ...server.toolExposure } } : {}),
    ...(server.description !== undefined ? { description: server.description } : {}),
    auth: classifyAuth(server),
    ...(typeof server.timeout === "number" ? { timeout: server.timeout } : {}),
  };
}

function filterExtensionServers(
  file: McpServerConfig[],
  incoming: McpServerConfig[],
): { accepted: McpServerConfig[]; errors: string[] } {
  const errors: string[] = [];
  const accepted: McpServerConfig[] = [];
  for (const server of incoming) {
    if (file.some((entry) => entry.name === server.name)) {
      errors.push(`扩展登记的服务器 ${server.name} 被配置文件盖住`);
      continue;
    }
    const conflict = [...file, ...accepted].find((entry) => serverNamesConflict(entry.name, server.name));
    if (conflict) {
      errors.push(`扩展登记的服务器 ${server.name} 与 ${conflict.name} 冲突`);
      continue;
    }
    accepted.push({ ...server, source: "extension" });
  }
  return { accepted, errors };
}

async function probeResources(client: McpClient): Promise<boolean> {
  const listed = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await withTimeout(run(), MCP_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  };
  if (typeof client.listResources === "function") {
    const result = await listed(() => client.listResources!());
    if ((result?.resources?.length ?? 0) > 0) return true;
  }
  if (typeof client.listResourceTemplates === "function") {
    const result = await listed(() => client.listResourceTemplates!());
    if ((result?.resourceTemplates?.length ?? 0) > 0) return true;
  }
  return false;
}

function isRuntimeServer(server: McpMergeServer): server is McpServerConfig {
  return server.transport === "stdio" || server.transport === "sse" || server.transport === "http";
}

interface ScopeLayer {
  servers: McpServerConfig[];
  entries: McpLayerEntry[];
  disabled: string[];
  autoEnableCodemode: boolean | undefined;
}

function readScopeLayer(filePath: string): ScopeLayer {
  const empty: ScopeLayer = { servers: [], entries: [], disabled: [], autoEnableCodemode: undefined };
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP 配置 JSON 损坏: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP 配置必须是对象: ${filePath}`);
  }
  const root = parsed as Record<string, unknown>;
  if (root.mcpServers !== undefined && (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))) {
    throw new Error(`mcpServers 必须是对象: ${filePath}`);
  }
  if (root.disabledMcpServers !== undefined && (!root.disabledMcpServers || typeof root.disabledMcpServers !== "object" || Array.isArray(root.disabledMcpServers))) {
    throw new Error(`disabledMcpServers 必须是对象: ${filePath}`);
  }
  const disabledRoot = root.disabledMcpServers;
  const disabled = disabledRoot && typeof disabledRoot === "object" && !Array.isArray(disabledRoot)
    ? Object.keys(disabledRoot)
    : [];
  const serversRoot = root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
    ? root.mcpServers
    : {};
  const json = JSON.stringify({ mcpServers: serversRoot });
  return {
    servers: parseMcpServers(json),
    entries: parseMcpLayerEntries(json),
    disabled,
    autoEnableCodemode: typeof root.autoEnableCodemode === "boolean" ? root.autoEnableCodemode : undefined,
  };
}

export function managedServers(raw: string | undefined): McpServerConfig[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) return [];
    const servers = Object.fromEntries(entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as { name?: unknown; config?: unknown };
      return typeof value.name === 'string' && value.config && typeof value.config === 'object' ? [[value.name, value.config]] : [];
    }));
    return parseMcpServers(JSON.stringify({ mcpServers: servers }));
  } catch {
    return [];
  }
}

export function createManager(deps: ManagerDeps = {}): McpManager {
  const workspace = deps.workspace ?? currentWorkspaceContext()?.workspace ?? process.cwd();
  const connect = deps.connect ?? realConnect;
  let autoEnableCodemode = true;
  const readServers = deps.readServers ?? (() => {
    const loaded = readWorkspaceMcp(workspace);
    autoEnableCodemode = loaded.autoEnableCodemode;
    return loaded.servers;
  });
  const watch =
    deps.watch ??
    ((cb: () => void) => {
      const offConfig = watchConfig(() => cb());
      const offFiles = watchMcpConfigFiles(workspace, cb);
      return () => {
        offConfig();
        offFiles();
      };
    });
  const writeCache = deps.writeCache ?? writeToolsCacheEntry;
  let providerToken = deps.getProviderToken;

  const clients = new Map<string, McpClient>();
  const catalog = new Map<string, ServerEntry>();
  const inflight = new Map<string, Promise<void>>();
  const generation = new Map<string, number>();
  const listeners = new Set<(snap: McpSnapshot) => void>();
  let current: McpServerConfig[] = [];
  let fileList: McpServerConfig[] = [];
  let extensionRequested: McpServerConfig[] = [];
  let extensionErrors: string[] = [];
  let reconcileChain: Promise<void> = Promise.resolve();
  let started = false;
  let unwatch: (() => void) | undefined;

  const snapshot = (): McpSnapshot => ({
    autoEnableCodemode,
    errors: [...extensionErrors],
    servers: new Map(
      [...catalog.entries()].map(([k, v]) => [k, {
        status: v.status,
        error: v.error,
        tools: [...v.tools],
        exposure: v.exposure,
        toolExposure: v.toolExposure ? { ...v.toolExposure } : undefined,
        description: v.description,
        auth: v.auth,
        hasResources: v.hasResources === true,
        ...(v.loginUrl ? { loginUrl: v.loginUrl } : {}),
      }]),
    ),
  });

  const emit = (): void => {
    const snap = snapshot();
    for (const l of listeners) {
      try {
        l(snap);
      } catch {
        // 单个 listener 异常隔离
      }
    }
  };

  const connectServer = async (s: McpServerConfig): Promise<void> => {
    const gen = (generation.get(s.name) ?? 0) + 1;
    generation.set(s.name, gen);
    const meta = serverSnapshotMeta(s);
    catalog.set(s.name, { status: "connecting", tools: [], ...meta });
    emit();
    logMcp(s.name, "connect");
    try {
      const provider = usesProviderAuth(s);
      if (provider) {
        const token = await readProviderToken(providerToken, provider);
        if (generation.get(s.name) !== gen) return;
        if (!token) {
          catalog.set(s.name, { status: "failed", error: MISSING_PROVIDER_TOKEN, tools: [], ...meta });
          logMcp(s.name, "failed", MISSING_PROVIDER_TOKEN);
          try {
            writeCache(s.name, { ok: false, toolNames: [], error: MISSING_PROVIDER_TOKEN });
          } catch {
            // best-effort 缓存
          }
          emit();
          return;
        }
      }
      const client = await connect(s, {
        getProviderToken: (name) => providerToken?.(name),
        onLoginUrl(url) {
          if (generation.get(s.name) !== gen) return;
          const current = catalog.get(s.name);
          if (!current || current.status === "connected") return;
          catalog.set(s.name, { ...current, loginUrl: url });
          logMcp(s.name, "login", url);
          emit();
        },
      });
      if (generation.get(s.name) !== gen) {
        await client.close().catch(() => {});
        return;
      }
      clients.set(s.name, client);
      const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS);
      const hasResources = await probeResources(client);
      if (generation.get(s.name) !== gen) {
        if (clients.get(s.name) === client) {
          clients.delete(s.name);
          await client.close().catch(() => {});
        }
        return;
      }
      catalog.set(s.name, { status: "connected", tools, hasResources, ...meta });
      logMcp(s.name, "connect", "connected");
      try {
        // 写「全名」mcp__server__tool（与 probe.ts、运行时工具注册、mcp-policy 查询一致）。
        // 原先写裸名 t.name 导致 UI/策略 key 与扩展查的全名对不上 → 权限设置不生效。
        writeCache(s.name, { ok: true, toolNames: tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`) });
      } catch {
        // best-effort 缓存
      }
    } catch (e) {
      if (generation.get(s.name) !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      const loginUrl = loginUrlOf(e) ?? catalog.get(s.name)?.loginUrl;
      catalog.set(s.name, { status: "failed", error: msg, tools: [], ...meta, ...(loginUrl ? { loginUrl } : {}) });
      logMcp(s.name, "failed", msg);
      try {
        writeCache(s.name, { ok: false, toolNames: [], error: msg });
      } catch {
        // best-effort 缓存
      }
    }
    if (generation.get(s.name) === gen) emit();
  };

  const runConnect = (s: McpServerConfig): Promise<void> => {
    const p = connectServer(s).finally(() => {
      if (inflight.get(s.name) === p) inflight.delete(s.name);
    });
    inflight.set(s.name, p);
    return p;
  };

  const forceReconnect = async (s: McpServerConfig): Promise<void> => {
    generation.set(s.name, (generation.get(s.name) ?? 0) + 1);
    const existing = clients.get(s.name);
    if (existing) {
      await existing.close().catch(() => {});
      clients.delete(s.name);
    }
    catalog.set(s.name, { status: "connecting", tools: [], ...serverSnapshotMeta(s) });
    emit();
    await runConnect(s);
  };

  const findEnabled = (name: string, servers: McpServerConfig[]): McpServerConfig => {
    const found = servers.find((s) => s.name === name);
    if (!found) throw new Error(`MCP server not enabled: ${name}`);
    return found;
  };

  const disconnectServer = async (name: string): Promise<void> => {
    const c = clients.get(name);
    if (c) await c.close().catch(() => {});
    clients.delete(name);
    catalog.delete(name);
    emit();
  };

  const reconcile = (): Promise<void> => {
    if (!started) return Promise.resolve();
    // 和原来的配置回调一样，读服务器发生在返回之前，watch 测试能立刻数到这次读取。
    const fileNow = readServers();
    const run = reconcileChain.then(async () => {
      if (!started) return;
      fileList = fileNow;
      const filtered = filterExtensionServers(fileList, extensionRequested);
      const errorsChanged = extensionErrors.join("\n") !== filtered.errors.join("\n");
      extensionErrors = filtered.errors;
      const desired = [...fileList, ...filtered.accepted];
      const { added, removed, changed } = diffServers(current, desired);
      if (!added.length && !removed.length && !changed.length) {
        if (errorsChanged) emit();
        return;
      }
      current = desired;
      await Promise.all([...removed, ...changed.map((entry) => entry.name)].map(disconnectServer));
      await Promise.all([...added, ...changed].map(runConnect));
    });
    reconcileChain = run.then(() => undefined, () => undefined);
    return run;
  };

  const onConfigChange = (): void => {
    if (!started) return;
    void reconcile();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    fileList = readServers();
    const filtered = filterExtensionServers(fileList, extensionRequested);
    extensionErrors = filtered.errors;
    current = [...fileList, ...filtered.accepted];
    for (const server of current) void runConnect(server);
    unwatch = watch(onConfigChange);
  };

  const resourceTargets = (args: Record<string, unknown>): { names: string[]; missing?: string } => {
    const serverName = typeof args.server === "string" && args.server.trim() ? args.server.trim() : undefined;
    const names: string[] = [];
    for (const [name, entry] of catalog) {
      if (entry.status !== "connected" || entry.hasResources !== true) continue;
      if (serverName && name !== serverName) continue;
      names.push(name);
    }
    if (serverName && names.length === 0) return { names: [], missing: serverName };
    return { names };
  };

  const resourceText = (payload: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError,
    structuredContent: payload,
  });

  const listKind = async (
    kind: "resources" | "resourceTemplates",
    args: Record<string, unknown>,
  ) => {
    const { names, missing } = resourceTargets(args);
    if (missing) {
      return { content: [{ type: "text" as const, text: `MCP server "${missing}" has no resources` }], isError: true };
    }
    const items: unknown[] = [];
    const errors: { server: string; error: string }[] = [];
    const params = typeof args.cursor === "string" && args.cursor.length > 0 ? { cursor: args.cursor } : undefined;
    let nextCursor: string | undefined;
    for (const name of names) {
      const client = clients.get(name);
      const run = kind === "resources" ? client?.listResources : client?.listResourceTemplates;
      if (!run) continue;
      try {
        const listed = await withTimeout(params ? run(params) : run(), callTimeoutMs(catalog.get(name)?.timeout)) as {
          resources?: unknown[];
          resourceTemplates?: unknown[];
          nextCursor?: string;
        };
        const batch = kind === "resources" ? listed.resources : listed.resourceTemplates;
        for (const item of batch ?? []) {
          items.push(item && typeof item === "object" ? { server: name, ...(item as Record<string, unknown>) } : { server: name });
        }
        if (names.length === 1 && typeof listed.nextCursor === "string" && listed.nextCursor) {
          nextCursor = listed.nextCursor;
        }
      } catch (error) {
        errors.push({ server: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const key = kind === "resources" ? "resources" : "resourceTemplates";
    return resourceText({
      ...(typeof args.server === "string" && args.server.trim() ? { server: args.server.trim() } : {}),
      [key]: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    }, items.length === 0 && errors.length > 0);
  };

  return {
    get getProviderToken() {
      return providerToken;
    },
    set getProviderToken(value) {
      providerToken = value;
    },
    init: start,
    async reloadServer(name) {
      if (!started) {
        start();
        const target = findEnabled(name, current);
        await inflight.get(target.name);
        return;
      }
      const target = findEnabled(name, readServers());
      await forceReconnect(target);
      await inflight.get(target.name);
    },
    snapshot,
    async callTool(server, tool, args) {
      while (catalog.get(server)?.status === "connecting") {
        const pending = inflight.get(server);
        if (!pending) break;
        await pending;
      }
      const entry = catalog.get(server);
      if (entry?.status === "failed") {
        return {
          content: [{ type: "text", text: entry.error ?? "" }],
          isError: true,
        };
      }
      const client = clients.get(server);
      if (!client) throw new Error(`MCP server not connected: ${server}`);
      return callWithProgressTimeout(
        (onProgress) => client.callTool({ name: tool, arguments: args ?? {}, onProgress }),
        callTimeoutMs(entry?.timeout),
      );
    },
    connectPromise(name) {
      if (catalog.get(name)?.status !== "connecting") return undefined;
      return inflight.get(name);
    },
    applyExtensionServers(servers) {
      extensionRequested = servers.map((server) => ({ ...server, source: "extension" }));
      if (!started) return Promise.resolve();
      return reconcile();
    },
    listResources(args) {
      return listKind("resources", args ?? {});
    },
    listResourceTemplates(args) {
      return listKind("resourceTemplates", args ?? {});
    },
    async readResource(args) {
      const serverName = typeof args?.server === "string" ? args.server.trim() : "";
      const uri = typeof args?.uri === "string" ? args.uri : "";
      const entry = catalog.get(serverName);
      const client = clients.get(serverName);
      if (!client?.readResource || entry?.status !== "connected" || entry.hasResources !== true) {
        return { content: [{ type: "text", text: `MCP server "${serverName}" has no resources` }], isError: true };
      }
      try {
        const result = await withTimeout(client.readResource({ uri }), callTimeoutMs(entry.timeout));
        const text = (result.contents ?? [])
          .map((item) => (typeof item.text === "string" ? item.text : JSON.stringify(item)))
          .join("\n");
        return {
          content: [{ type: "text", text: text || JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconcile() {
      onConfigChange();
    },
    closeAll() {
      started = false;
      unwatch?.();
      unwatch = undefined;
      for (const c of clients.values()) void c.close().catch(() => {});
      clients.clear();
      inflight.clear();
    },
  };
}

export function getMcpManagerFor(workspace: string): McpManager {
  let mgr = managers.get(workspace);
  if (!mgr) {
    mgr = createManager({ workspace });
    managers.set(workspace, mgr);
  }
  return mgr;
}

export function getMcpManager(): McpManager {
  return getMcpManagerFor(currentWorkspaceContext()?.workspace ?? process.cwd());
}

export async function reloadMcpServer(workspace: string, name: string): Promise<void> {
  await getMcpManagerFor(workspace).reloadServer(name);
}

export function disposeMcpManager(workspace: string): void {
  const mgr = managers.get(workspace);
  if (!mgr) return;
  mgr.closeAll();
  managers.delete(workspace);
  alsConfigByWorkspace.delete(workspace);
}

/** 配置落盘后刷新 runtime-settings 缓存并重读该 workspace 的 MCP 连接。 */
export function reconcileMcpManager(workspace: string): void {
  refreshConfig();
  managers.get(workspace)?.reconcile();
}

export function __resetMcpManagersForTest(): void {
  for (const mgr of managers.values()) mgr.closeAll();
  managers.clear();
  alsConfigByWorkspace.clear();
}
