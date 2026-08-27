// 进程级 MCP 连接管理器：跨会话存活，绝不引用 pi/ctx。
// 一个 workspace 一个 pi 进程，故 globalThis 单例即「workspace 共享一套」。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAllConfig, getConfig, watchConfig } from "../_shared/runtime-config.js";
import { expandServerVars, injectDefaultServers, type McpServerConfig, parseMcpServers, sanitize } from "./config.js";
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
  connect?: (s: McpServerConfig) => Promise<McpClient>;
  readServers?: () => McpServerConfig[];
  watch?: (cb: () => void) => () => void;
  writeCache?: (name: string, r: ProbeResult) => void;
}

export interface McpManager {
  init(): void;
  snapshot(): McpSnapshot;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string }>;
  subscribe(listener: (snap: McpSnapshot) => void): () => void;
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
  const transport =
    s.transport === "sse"
      ? new SSEClientTransport(new URL(s.url ?? ""))
      : new StdioClientTransport({
          command: s.command ?? "",
          args: s.args ?? [],
          ...(s.cwd ? { cwd: s.cwd } : {}),
          env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
        });
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

function defaultReadServers(): McpServerConfig[] {
  const servers = injectDefaultServers(
    readLayeredMcpServersSync(process.cwd(), getConfig("MCP_SERVERS") ?? ""),
    getAllConfig(),
    process.platform,
    readToolsCache(),
    process.arch,
    {
      knowledgeApiToken: getConfig("TDAI_MEMORY_API_KEY"),
      knowledgeUserKey: getConfig("TDAI_MEMORY_USER_KEY"),
    },
  );
  return expandServerVars(servers, process.cwd());
}

export function createManager(deps: ManagerDeps = {}): McpManager {
  const connect = deps.connect ?? realConnect;
  const readServers = deps.readServers ?? defaultReadServers;
  const watch = deps.watch ?? ((cb: () => void) => {
    const offConfig = watchConfig(() => cb());
    const offFiles = watchMcpConfigFiles(process.cwd(), cb);
    return () => { offConfig(); offFiles(); };
  });
  const writeCache = deps.writeCache ?? writeToolsCacheEntry;

  const clients = new Map<string, McpClient>();
  const catalog = new Map<string, ServerEntry>();
  const listeners = new Set<(snap: McpSnapshot) => void>();
  let current: McpServerConfig[] = [];
  let started = false;

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
    catalog.set(s.name, { status: "connecting", tools: [] });
    try {
      const client = await connect(s);
      clients.set(s.name, client);
      const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS);
      catalog.set(s.name, { status: "connected", tools });
      try {
        // 写「全名」mcp__server__tool（与 probe.ts、运行时工具注册、mcp-policy 查询一致）。
        // 原先写裸名 t.name 导致 UI/策略 key 与扩展查的全名对不上 → 权限设置不生效。
        writeCache(s.name, { ok: true, toolNames: tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`) });
      } catch {
        // best-effort 缓存
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      catalog.set(s.name, { status: "failed", error: msg, tools: [] });
      try {
        writeCache(s.name, { ok: false, toolNames: [], error: msg });
      } catch {
        // best-effort 缓存
      }
    }
    emit();
  };

  const disconnectServer = async (name: string): Promise<void> => {
    const c = clients.get(name);
    if (c) await c.close().catch(() => {});
    clients.delete(name);
    catalog.delete(name);
    emit();
  };

  const onConfigChange = (): void => {
    void (async () => {
      const desired = readServers();
      const { added, removed, changed } = diffServers(current, desired);
      if (!added.length && !removed.length && !changed.length) return;
      current = desired;
      await Promise.all([...removed, ...changed.map((c) => c.name)].map(disconnectServer));
      await Promise.all([...added, ...changed].map(connectServer));
    })();
  };

  return {
    init() {
      if (started) return;
      started = true;
      current = readServers();
      void Promise.all(current.map(connectServer));
      watch(onConfigChange);
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
    closeAll() {
      for (const c of clients.values()) void c.close().catch(() => {});
      clients.clear();
    },
  };
}

export function getMcpManager(): McpManager {
  const g = globalThis as { __grenMcpManager?: McpManager; __grenMcpExitHooked?: boolean };
  const mgr = (g.__grenMcpManager ??= createManager());
  if (!g.__grenMcpExitHooked) {
    g.__grenMcpExitHooked = true;
    const close = () => mgr.closeAll();
    process.on("exit", close);
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  }
  return mgr;
}
