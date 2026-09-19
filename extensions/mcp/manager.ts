// 进程级 MCP 连接管理器：跨会话存活，绝不引用 pi/ctx。
// 按 workspace 分 Map，同一 workspace 共享一套 manager。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getAllConfig, getConfig, refreshConfig, watchConfig } from "../_shared/runtime-config.js";
import { currentWorkspaceContext } from "../_shared/workspace-context.js";
import { expandServerVars, injectDefaultServers, type McpServerConfig, parseMcpServers, sanitize } from "./config.js";
import { createMcpTransport } from "./transport.js";
import { diffServers } from "./diff.js";
import type { ProbeResult } from "./probe.js";
import { readToolsCache, writeToolsCacheEntry } from "./toolsCache.js";
import { readLayeredMcpServersSync, watchMcpConfigFiles } from "../resource-manager/mcp-store.js";

export const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? "60000") || 60000;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export type McpStatus = "connecting" | "connected" | "failed";
export interface ServerEntry {
  status: McpStatus;
  error?: string;
  tools: McpToolDef[];
}
export interface McpSnapshot {
  servers: Map<string, ServerEntry>;
}

/** 管理器需要的最小 MCP 客户端能力（真实 SDK Client 结构兼容）。 */
export interface McpClient {
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: unknown }>;
  close(): Promise<void>;
}

export interface ManagerDeps {
  workspace?: string;
  connect?: (s: McpServerConfig) => Promise<McpClient>;
  readServers?: () => McpServerConfig[];
  watch?: (cb: () => void) => () => void;
  writeCache?: (name: string, r: ProbeResult) => void;
}

export interface McpManager {
  init(): void;
  reloadServer(name: string): Promise<void>;
  snapshot(): McpSnapshot;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string }>;
  subscribe(listener: (snap: McpSnapshot) => void): () => void;
  /** 配置已落盘后立刻重读（不依赖 fs.watch）。未 init 时为空操作。 */
  reconcile(): void;
  closeAll(): void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function realConnect(s: McpServerConfig): Promise<McpClient> {
  const client = new Client({ name: "grenagent", version: "0.1.0" });
  const transport = createMcpTransport(s);
  try {
    await withTimeout(client.connect(transport), MCP_TIMEOUT_MS);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    listTools: () => client.listTools(),
    callTool: async (args) => {
      const result = await client.callTool(args);
      return { content: "content" in result ? result.content : undefined };
    },
    close: () => client.close(),
  };
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

function defaultReadServers(workspace: string): McpServerConfig[] {
  rememberAlsConfig(workspace);
  const captured = alsConfigByWorkspace.get(workspace);
  const als = currentWorkspaceContext()?.config;
  const raw = captured?.[LIVE_MCP_FLAG] === "1"
    ? captured.PI_MCP_CONFIG
    : (als?.PI_MCP_CONFIG ?? captured?.PI_MCP_CONFIG ?? getConfig("PI_MCP_CONFIG"));
  const all = { ...getAllConfig(), ...captured, ...als };
  // PI_MCP_CONFIG 是回合开始时的 ALS 快照，watch/中途写入读不到它。
  // 现场分层文件（MCP_SERVERS + mcp.json）覆盖同名项，并补上快照里没有的新 server。
  const servers = injectDefaultServers(
    overlayMcpServers(managedServers(raw), readLayeredMcpServersSync(workspace, getConfig("MCP_SERVERS") ?? "")),
    all,
    process.platform,
    readToolsCache(),
    process.arch,
  );
  return expandServerVars(servers, workspace);
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
  const readServers = deps.readServers ?? (() => defaultReadServers(workspace));
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

  const clients = new Map<string, McpClient>();
  const catalog = new Map<string, ServerEntry>();
  const inflight = new Map<string, Promise<void>>();
  const generation = new Map<string, number>();
  const listeners = new Set<(snap: McpSnapshot) => void>();
  let current: McpServerConfig[] = [];
  let started = false;
  let unwatch: (() => void) | undefined;

  const snapshot = (): McpSnapshot => ({
    servers: new Map(
      [...catalog.entries()].map(([k, v]) => [k, { status: v.status, error: v.error, tools: [...v.tools] }]),
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
    catalog.set(s.name, { status: "connecting", tools: [] });
    emit();
    try {
      const client = await connect(s);
      if (generation.get(s.name) !== gen) {
        await client.close().catch(() => {});
        return;
      }
      clients.set(s.name, client);
      const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS);
      if (generation.get(s.name) !== gen) {
        if (clients.get(s.name) === client) {
          clients.delete(s.name);
          await client.close().catch(() => {});
        }
        return;
      }
      catalog.set(s.name, { status: "connected", tools });
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
      catalog.set(s.name, { status: "failed", error: msg, tools: [] });
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
    catalog.set(s.name, { status: "connecting", tools: [] });
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

  const onConfigChange = (): void => {
    if (!started) return;
    void (async () => {
      const desired = readServers();
      const { added, removed, changed } = diffServers(current, desired);
      if (!added.length && !removed.length && !changed.length) return;
      current = desired;
      await Promise.all([...removed, ...changed.map((c) => c.name)].map(disconnectServer));
      await Promise.all([...added, ...changed].map(runConnect));
    })();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    current = readServers();
    for (const s of current) void runConnect(s);
    unwatch = watch(onConfigChange);
  };

  return {
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
      const c = clients.get(server);
      if (!c) throw new Error(`MCP server not connected: ${server}`);
      const r = await c.callTool({ name: tool, arguments: args ?? {} });
      const blocks = Array.isArray((r as { content?: unknown }).content) ? (r as { content: unknown[] }).content : [];
      const text =
        blocks
          .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
          .map((b) => b.text)
          .join("\n") || "(no output)";
      return { text };
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
