# MCP 连接管理器（进程级单例 + 每会话薄绑定）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 `extensions/mcp` 的连接管理抽成进程级 `globalThis` 单例、每会话只做薄绑定重投射，根除「extension ctx is stale」守卫错误，实现「workspace 共享一套连接、切会话零重连」。

**架构：** 新增 `manager.ts` 持有跨会话存活的连接/目录/配置监听（绝不引用 `pi`/`ctx`）；`index.ts` 瘦身为每会话薄绑定——`session_start` 用新鲜 `pi` 登记并激活当前目录、订阅变化、`session_shutdown` 解绑。

**技术栈：** TypeScript（ESM）、`@modelcontextprotocol/sdk`、`typebox`、vitest 4。设计见 `docs/superpowers/specs/2026-06-15-mcp-connection-manager-design.md`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `extensions/mcp/manager.ts` | 进程级连接管理器：connect/diff 热更新、工具目录、状态、`callTool`、订阅；`getMcpManager()` 单例。**不引用 `pi`/`ctx`** | 创建 |
| `extensions/mcp/manager.test.ts` | 管理器单元测试（注入假 connect/readServers/watch/writeCache） | 创建 |
| `extensions/mcp/index.ts` | 每会话薄绑定：`summary` / `project` / `bind` / 默认导出 | 重写 |
| `extensions/mcp/index.test.ts` | `summary` / `project` / `bind` 单元测试（假 `pi`/`mgr`） | 创建 |
| `extensions/mcp/{config,diff,toolsCache,probe}.ts` | 复用，不改 | — |

运行测试：在 `extensions/` 目录执行 `bunx vitest run mcp/<file>.test.ts`。

---

## 任务 1：连接管理器 `manager.ts`

**文件：**
- 创建：`extensions/mcp/manager.ts`
- 测试：`extensions/mcp/manager.test.ts`

- [x] **步骤 1：编写失败的测试 `extensions/mcp/manager.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./config";
import { createManager, type McpClient, type McpSnapshot } from "./manager";

function fakeClient(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  callResult: unknown = { content: [{ type: "text", text: "ok" }] },
): McpClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async () => callResult as { content: unknown },
    close: async () => {},
  };
}

function waitFor(
  subscribe: (l: (s: McpSnapshot) => void) => () => void,
  snapshot: () => McpSnapshot,
  pred: (s: McpSnapshot) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    if (pred(snapshot())) return resolve();
    const un = subscribe((s) => {
      if (pred(s)) {
        un();
        resolve();
      }
    });
  });
}

const srv = (name: string, command = "x"): McpServerConfig => ({ name, transport: "stdio", command, args: [] });

describe("createManager", () => {
  it("connects servers on init and reflects tools in snapshot", async () => {
    const connect = vi.fn(async (_s: McpServerConfig) => fakeClient([{ name: "alpha" }]));
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    const entry = mgr.snapshot().servers.get("a");
    expect(entry?.status).toBe("connected");
    expect(entry?.tools.map((t) => t.name)).toEqual(["alpha"]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: init twice connects each server once", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "alpha" }]));
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("records failed status and error when connect throws", async () => {
    const writeCache = vi.fn();
    const connect = async (s: McpServerConfig) => {
      if (s.name === "bad") throw new Error("boom");
      return fakeClient([]);
    };
    const mgr = createManager({ connect, readServers: () => [srv("bad")], watch: () => () => {}, writeCache });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("bad")?.status === "failed");
    expect(mgr.snapshot().servers.get("bad")?.error).toBe("boom");
    expect(writeCache).toHaveBeenCalledWith("bad", expect.objectContaining({ ok: false, error: "boom" }));
  });

  it("routes callTool to the connected client and extracts text", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }], { content: [{ type: "text", text: "hi" }] });
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(await mgr.callTool("a", "alpha", {})).toEqual({ text: "hi" });
    await expect(mgr.callTool("nope", "x", {})).rejects.toThrow(/not connected/);
  });

  it("subscribe delivers snapshots and unsub stops them", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }]);
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    const seen: number[] = [];
    const un = mgr.subscribe((s) => seen.push(s.servers.size));
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    const count = seen.length;
    un();
    await mgr.callTool("a", "alpha", {}).catch(() => {});
    expect(seen.length).toBe(count);
  });

  it("applies config changes via the watch callback (add/remove)", async () => {
    let servers = [srv("a")];
    let trigger = () => {};
    const connect = vi.fn(async () => fakeClient([{ name: "alpha" }]));
    const mgr = createManager({
      connect,
      readServers: () => servers,
      watch: (cb) => {
        trigger = cb;
        return () => {};
      },
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    servers = [srv("b")];
    trigger();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => !s.servers.has("a") && s.servers.get("b")?.status === "connected");
    expect(mgr.snapshot().servers.has("a")).toBe(false);
    expect(mgr.snapshot().servers.get("b")?.status).toBe("connected");
  });

  it("isolates a throwing listener from others", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }]);
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    let good = 0;
    mgr.subscribe(() => {
      throw new Error("bad listener");
    });
    mgr.subscribe(() => {
      good += 1;
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(good).toBeGreaterThan(0);
  });
});
```

- [x] **步骤 2：运行测试验证失败**

在 `extensions/` 运行：`bunx vitest run mcp/manager.test.ts`
预期：FAIL，报 `Failed to resolve import "./manager"` / `createManager is not a function`。

- [x] **步骤 3：编写实现 `extensions/mcp/manager.ts`**

```ts
// 进程级 MCP 连接管理器：跨会话存活，绝不引用 pi/ctx。
// 一个 workspace 一个 pi 进程，故 globalThis 单例即「workspace 共享一套」。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAllConfig, getConfig, watchConfig } from "../_shared/runtime-config.js";
import { injectDefaultServers, type McpServerConfig, parseMcpServers } from "./config.js";
import { diffServers } from "./diff.js";
import type { ProbeResult } from "./probe.js";
import { writeToolsCacheEntry } from "./toolsCache.js";

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
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content: unknown }>;
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
    callTool: (args) => client.callTool(args),
    close: () => client.close(),
  };
}

function defaultReadServers(): McpServerConfig[] {
  return injectDefaultServers(parseMcpServers(getConfig("MCP_SERVERS") ?? ""), getAllConfig(), process.platform);
}

export function createManager(deps: ManagerDeps = {}): McpManager {
  const connect = deps.connect ?? realConnect;
  const readServers = deps.readServers ?? defaultReadServers;
  const watch = deps.watch ?? watchConfig;
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
        writeCache(s.name, { ok: true, toolNames: tools.map((t) => t.name) });
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
```

- [x] **步骤 4：运行测试验证通过**

在 `extensions/` 运行：`bunx vitest run mcp/manager.test.ts`
预期：PASS（7 个用例全过）。

- [x] **步骤 5：Commit**

```bash
git add extensions/mcp/manager.ts extensions/mcp/manager.test.ts
git commit -m "feat(mcp): 进程级连接管理器(globalThis 单例) + 单测"
```

---

## 任务 2：每会话薄绑定 `index.ts`

**文件：**
- 修改（整文件重写）：`extensions/mcp/index.ts`
- 测试：`extensions/mcp/index.test.ts`

- [x] **步骤 1：编写失败的测试 `extensions/mcp/index.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { McpSnapshot } from "./manager";
import { bind, project, summary } from "./index";

function snap(servers: Record<string, { status: string; tools: string[] }>): McpSnapshot {
  return {
    servers: new Map(
      Object.entries(servers).map(([name, v]) => [
        name,
        { status: v.status as never, tools: v.tools.map((t) => ({ name: t })) },
      ]),
    ),
  };
}

function fakeProjectPi() {
  const registered: string[] = [];
  let active: string[] = [];
  return {
    registered,
    get active() {
      return active;
    },
    registerTool: (t: { name: string }) => {
      registered.push(t.name);
    },
    getActiveTools: () => active,
    setActiveTools: (n: string[]) => {
      active = n;
    },
  };
}

const fakeMgr = () => ({ callTool: async () => ({ text: "x" }) });

describe("summary", () => {
  it("builds prefixed tool names per server", () => {
    const out = summary(snap({ a: { status: "connected", tools: ["x", "y"] }, b: { status: "failed", tools: [] } }));
    expect(out).toEqual([
      { name: "a", status: "connected", tools: 2, toolNames: ["mcp__a__x", "mcp__a__y"] },
      { name: "b", status: "failed", tools: 0, toolNames: [] },
    ]);
  });
});

describe("project", () => {
  it("registers connected tools and activates them, deactivating stale mcp tools", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read", "mcp__old__gone"]);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), fakeMgr());
    expect(pi.registered).toEqual(["mcp__a__x"]);
    expect(pi.active).toEqual(["read", "mcp__a__x"]);
  });

  it("does not register tools for non-connected servers", () => {
    const pi = fakeProjectPi();
    project(pi as never, snap({ a: { status: "connecting", tools: [] }, b: { status: "failed", tools: [] } }), fakeMgr());
    expect(pi.registered).toEqual([]);
  });
});

function fakePiWithOn() {
  const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  const registered: string[] = [];
  let active: string[] = [];
  return {
    registered,
    on: (ev: string, h: (...a: unknown[]) => unknown) => {
      const l = handlers.get(ev) ?? [];
      l.push(h);
      handlers.set(ev, l);
    },
    registerTool: (t: { name: string }) => registered.push(t.name),
    getActiveTools: () => active,
    setActiveTools: (n: string[]) => {
      active = n;
    },
    fire: (ev: string, ...args: unknown[]) => (handlers.get(ev) ?? []).forEach((h) => h(...args)),
  };
}

function fakeBindMgr(s: McpSnapshot) {
  let listener: ((s: McpSnapshot) => void) | undefined;
  const calls = { init: 0, unsub: 0 };
  return {
    init: () => {
      calls.init += 1;
    },
    snapshot: () => s,
    callTool: async () => ({ text: "x" }),
    subscribe: (l: (s: McpSnapshot) => void) => {
      listener = l;
      return () => {
        calls.unsub += 1;
      };
    },
    closeAll: () => {},
    emit: (next: McpSnapshot) => listener?.(next),
    calls,
  };
}

describe("bind", () => {
  it("init + project + subscribe on session_start, re-project on emit, unsub on shutdown", () => {
    const pi = fakePiWithOn();
    const mgr = fakeBindMgr(snap({ a: { status: "connected", tools: ["x"] } }));
    bind(pi as never, mgr as never);

    pi.fire("session_start", {}, { hasUI: false });
    expect(mgr.calls.init).toBe(1);
    expect(pi.registered).toContain("mcp__a__x");

    mgr.emit(snap({ a: { status: "connected", tools: ["x", "y"] } }));
    expect(pi.registered).toContain("mcp__a__y");

    pi.fire("session_shutdown");
    expect(mgr.calls.unsub).toBe(1);

    const before = pi.registered.length;
    mgr.emit(snap({ a: { status: "connected", tools: ["z"] } }));
    expect(pi.registered.length).toBe(before);
  });
});
```

- [x] **步骤 2：运行测试验证失败**

在 `extensions/` 运行：`bunx vitest run mcp/index.test.ts`
预期：FAIL，报 `summary is not exported` / 类型导出缺失（旧 `index.ts` 无这些导出）。

- [x] **步骤 3：重写 `extensions/mcp/index.ts`**

```ts
// mcp: 把外部 MCP server（stdio/SSE）的工具暴露给 agent，名为 mcp__<server>__<tool>。
// 连接/热更新在进程级管理器（manager.ts），跨会话存活；本文件只做每会话薄绑定：
// session_start 用新鲜 pi 登记+激活当前目录并订阅变化，session_shutdown 解绑。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitize } from "./config.js";
import { getMcpManager, type McpManager, type McpSnapshot } from "./manager.js";

export interface ServerSummary {
  name: string;
  status: string;
  tools: number;
  toolNames: string[];
}

// 与旧 summary() 形状一致：每 server 的 status / 工具数 / 注册全名（权限面板依赖）。
export function summary(snap: McpSnapshot): ServerSummary[] {
  return [...snap.servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.length,
    toolNames: e.tools.map((t) => `mcp__${sanitize(name)}__${sanitize(t.name)}`),
  }));
}

interface ProjectablePi {
  registerTool: ExtensionAPI["registerTool"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
}

// 把当前目录投射进会话：登记已连工具，激活它们，停用已不在连接中的 mcp__ 工具。
export function project(pi: ProjectablePi, snap: McpSnapshot, mgr: Pick<McpManager, "callTool">): void {
  const connected: string[] = [];
  for (const [server, entry] of snap.servers) {
    if (entry.status !== "connected") continue;
    for (const t of entry.tools) {
      const full = `mcp__${sanitize(server)}__${sanitize(t.name)}`;
      connected.push(full);
      pi.registerTool({
        name: full,
        label: `${server}: ${t.name}`,
        description: t.description ?? `MCP tool "${t.name}" from server "${server}".`,
        parameters: Type.Unsafe(t.inputSchema ?? { type: "object" }),
        async execute(_toolCallId, params) {
          const r = await mgr.callTool(server, t.name, (params ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text: r.text }], details: { server, tool: t.name } };
        },
      });
    }
  }
  try {
    const connectedSet = new Set(connected);
    const active = pi.getActiveTools();
    const next = active.filter((n) => !n.startsWith("mcp__") || connectedSet.has(n));
    for (const n of connected) if (!next.includes(n)) next.push(n);
    pi.setActiveTools(next);
  } catch {
    // active-tool plumbing 尚未就绪：工具已登记，稍后可被激活
  }
}

export function bind(pi: ExtensionAPI, mgr: McpManager): void {
  let alive = false;
  let unsub: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    mgr.init();
    alive = true;
    const render = (snap: McpSnapshot): void => {
      if (!alive) return;
      project(pi, snap, mgr);
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus("mcp", JSON.stringify(summary(snap)));
        } catch {
          // 状态推送 best-effort
        }
      }
    };
    render(mgr.snapshot());
    unsub = mgr.subscribe(render);
  });

  pi.on("session_shutdown", () => {
    alive = false;
    unsub?.();
    unsub = undefined;
  });
}

export default function (pi: ExtensionAPI) {
  bind(pi, getMcpManager());
}
```

- [x] **步骤 4：运行测试验证通过**

在 `extensions/` 运行：`bunx vitest run mcp/index.test.ts`
预期：PASS（summary / project x2 / bind 全过）。

- [x] **步骤 5：Commit**

```bash
git add extensions/mcp/index.ts extensions/mcp/index.test.ts
git commit -m "feat(mcp): index 瘦身为每会话薄绑定(重投射) + 单测；根除 stale ctx 守卫错误"
```

---

## 任务 3：全量验证与 sidecar 构建

**文件：** 无新增（仅验证）。

- [x] **步骤 1：跑全部 mcp 测试**

在 `extensions/` 运行：`bunx vitest run mcp/`
预期：`manager.test.ts`、`index.test.ts`、既有 `config.test.ts`、`diff.test.ts`、`probe.test.ts` 全绿。

- [x] **步骤 2：构建 sidecar（确认扩展可打包、无导入/类型错误）**

在 `tauri-agent/` 运行：`node scripts/build-sidecar.mjs`
预期：构建成功，无 `manager.ts`/`index.ts` 相关报错。

- [x] **步骤 3：手动冒烟（启动桌面端）**

启动应用 → 等 MCP 连上（状态 connected）→ 新建会话 / 切换会话 / fork → 确认：
1. 新会话 MCP 工具立即可用，**无重连**（无新的子进程 spawn、连接秒级就绪）；
2. 控制台/日志**不再出现** "extension ctx is stale ..."；
3. 改一次 `MCP_SERVERS` 后仅当前会话目录更新、无守卫错。

- [x] **步骤 4：若步骤 1-2 有修复改动则 Commit**

```bash
git add -A extensions/mcp
git commit -m "test(mcp): 全量绿 + sidecar 构建通过"
```

（若步骤 1-2 无需改动，跳过本步。）

---

## 自检

**1. 规格覆盖度：**
- 进程级单例 + 不引用 pi/ctx → 任务 1（`createManager`/`getMcpManager`）✓
- 每会话薄绑定（登记/激活/订阅/解绑）→ 任务 2（`bind`/`project`）✓
- 切会话零重连 → 连接在管理器、跨会话存活；绑定只重投射 ✓（任务 1 连接态 + 任务 2 render）
- 守卫错误根除 → 绑定 `alive`+`unsub` 于 `session_shutdown`，无跨会话句柄 ✓（任务 2 bind 测试断言 shutdown 后零调用）
- 仅一个 `fs.watch` → `init()` 的 `started` 守卫 + `??=` 单例 ✓（任务 1 幂等测试）
- 连接失败仅真实错误 → `connectServer` catch ✓（任务 1 failed 测试）
- `summary` 含 `toolNames` 兼容权限面板 → 任务 2 summary 测试 ✓
- 进程退出清理 → `getMcpManager` 一次性挂钩 ✓
- 工具移除靠停用 → `project` 用 `mcp__` 前缀过滤 ✓（任务 2 project 测试断言停用 `mcp__old__gone`）

**2. 占位符扫描：** 无 TODO/待定；每步含完整代码与命令。✓

**3. 类型一致性：** `McpSnapshot`/`McpClient`/`McpManager`/`ServerEntry`/`ManagerDeps` 在 `manager.ts` 定义，`index.ts` 与两个测试一致引用；`project` 用 `Pick<McpManager,"callTool">`，`bind` 用完整 `McpManager`；`summary`/`project`/`bind` 签名与测试调用一致。✓

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-15-mcp-connection-manager.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间审查，快速迭代（必需子技能：superpowers:subagent-driven-development）。
2. **内联执行** — 当前会话用 superpowers:executing-plans 批量执行并设检查点。

选哪种方式？
