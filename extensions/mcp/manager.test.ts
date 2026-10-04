import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./config";
import { getMcpManager, getMcpManagerFor, reloadMcpServer, disposeMcpManager, __resetMcpManagersForTest, createManager, managedServers, reconcileMcpManager, setLiveWorkspaceMcpConfig, type McpClient, type McpSnapshot } from "./manager";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { refreshConfig, restartRuntimeConfig, __resetForTest as resetRuntimeConfig } from "../_shared/runtime-config.js";

afterEach(() => {
  __resetMcpManagersForTest();
});

describe('managedServers', () => {
  it('uses the Electron effective MCP payload shape', () => {
    expect(managedServers(JSON.stringify([
      { name: 'project', config: { command: 'server', args: ['--stdio'] } },
      { name: 'remote', config: { url: 'https://example.com/sse' } },
    ]))).toEqual([
      { name: 'project', transport: 'stdio', command: 'server', args: ['--stdio'], env: {} },
      { name: 'remote', transport: 'sse', url: 'https://example.com/sse' },
    ]);
  });
});

function fakeClient(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  callResult: unknown = { content: [{ type: "text", text: "ok" }] },
): McpClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async () => callResult as { content?: unknown },
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

  it("routes callTool to the connected client and returns the raw result", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }], {
      content: [{ type: "text", text: "hi" }],
      isError: false,
      structuredContent: { echoed: true },
    });
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    const result = await mgr.callTool("a", "alpha", {});
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ echoed: true });
    await expect(mgr.callTool("nope", "x", {})).rejects.toThrow(/not connected/);
  });

  it("returns the raw result when a tool result omits content", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }], {});
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(await mgr.callTool("a", "alpha", {})).toEqual({});
  });

  it("keeps exposure, description, and auth on the snapshot", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }]);
    const mgr = createManager({
      connect,
      readServers: () => [
        { ...srv("docs"), exposure: "direct", description: "Docs", toolExposure: { alpha: "direct" }, oauth: { clientId: "c" } },
        { ...srv("vendor"), auth: { provider: "openai" } },
      ],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("docs")?.status === "connected" && s.servers.get("vendor")?.status === "connected");
    expect(mgr.snapshot().servers.get("docs")).toMatchObject({
      exposure: "direct",
      description: "Docs",
      toolExposure: { alpha: "direct" },
      auth: "oauth",
    });
    expect(mgr.snapshot().servers.get("vendor")?.auth).toBe("provider");
    expect(mgr.snapshot().autoEnableCodemode).toBe(true);
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

describe("autoEnableCodemode snapshot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("threads project autoEnableCodemode false onto the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-flag-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: { a: { command: "x" } },
    }));
    const mgr = createManager({
      workspace: dir,
      connect: async () => fakeClient([{ name: "t" }]),
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    expect(mgr.snapshot().autoEnableCodemode).toBe(false);
  });
});

describe("getMcpManager 分键", () => {
  it("两个 workspace 拿到两份互不共享的 manager", async () => {
    const a = await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => getMcpManager(),
    );
    const b = await runInWorkspace(
      { origin: "main", workspace: "D:/b", cwd: "D:/b", config: {} },
      async () => getMcpManager(),
    );
    expect(a).not.toBe(b);
    const a2 = await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => getMcpManager(),
    );
    expect(a2).toBe(a);
  });

  it("dispose A 不影响 B", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const a = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    const b = createManager({ connect, readServers: () => [srv("b")], watch: () => () => {}, writeCache: () => {} });
    a.init();
    b.init();
    await waitFor(a.subscribe, a.snapshot, (s) => s.servers.get("a")?.status === "connected");
    await waitFor(b.subscribe, b.snapshot, (s) => s.servers.get("b")?.status === "connected");
    a.closeAll();
    expect(b.snapshot().servers.get("b")?.status).toBe("connected");
  });

  it("watch 回调用闭包 workspace 读服务器，不读 process.cwd()", async () => {
    const seen: string[] = [];
    let fire = () => {};
    const mgr = createManager({
      workspace: "D:/proj-a",
      connect: async () => fakeClient([]),
      readServers: () => {
        seen.push("read");
        return [srv("s")];
      },
      watch: (cb) => {
        fire = cb;
        return () => {};
      },
      writeCache: () => {},
    });
    mgr.init();
    fire();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("closeAll 拆除 watch，不再收到后续变更", async () => {
    let fire = () => {};
    let stopped = false;
    const reads: string[] = [];
    const mgr = createManager({
      connect: async () => fakeClient([]),
      readServers: () => {
        reads.push("read");
        return [srv("s")];
      },
      watch: (cb) => {
        fire = cb;
        return () => {
          stopped = true;
        };
      },
      writeCache: () => {},
    });
    mgr.init();
    expect(reads.length).toBe(1);
    mgr.closeAll();
    expect(stopped).toBe(true);
    fire();
    expect(reads.length).toBe(1);
  });
});

describe("已启动会话中途添加 MCP", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetRuntimeConfig();
    delete process.env.PI_RUNTIME_CONFIG;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("ALS 里冻住的 PI_MCP_CONFIG 不挡住 watch 读到后来写入的 MCP_SERVERS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hot-"));
    dirs.push(dir);
    const runtime = join(dir, "runtime-settings.json");
    writeFileSync(runtime, JSON.stringify({
      MCP_SERVERS: JSON.stringify({ mcpServers: { frozen: { command: "frozen-cmd" } } }),
    }));
    process.env.PI_RUNTIME_CONFIG = runtime;
    restartRuntimeConfig();

    let fire = (): void => {};
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = await runInWorkspace(
      {
        origin: "main",
        workspace: dir,
        cwd: dir,
        config: {
          PI_MCP_CONFIG: JSON.stringify([{ name: "frozen", config: { command: "frozen-cmd" } }]),
        },
      },
      async () => {
        const created = createManager({
          workspace: dir,
          connect,
          watch: (cb) => {
            fire = cb;
            return () => {};
          },
          writeCache: () => {},
        });
        created.init();
        return created;
      },
    );

    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("frozen")?.status === "connected");

    writeFileSync(runtime, JSON.stringify({
      MCP_SERVERS: JSON.stringify({
        mcpServers: {
          frozen: { command: "frozen-cmd" },
          added: { command: "added-cmd" },
        },
      }),
    }));
    refreshConfig();
    fire();

    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("added")?.status === "connected");
    expect(mgr.snapshot().servers.has("frozen")).toBe(true);
  });

  it("回合未结束（仍在 ALS）时写入 MCP_SERVERS 也能补连", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hot-als-"));
    dirs.push(dir);
    const runtime = join(dir, "runtime-settings.json");
    writeFileSync(runtime, JSON.stringify({
      MCP_SERVERS: JSON.stringify({ mcpServers: { frozen: { command: "frozen-cmd" } } }),
    }));
    process.env.PI_RUNTIME_CONFIG = runtime;
    restartRuntimeConfig();

    await runInWorkspace(
      {
        origin: "main",
        workspace: dir,
        cwd: dir,
        config: {
          PI_MCP_CONFIG: JSON.stringify([{ name: "frozen", config: { command: "frozen-cmd" } }]),
        },
      },
      async () => {
        let fire = (): void => {};
        const mgr = createManager({
          workspace: dir,
          connect: async () => fakeClient([{ name: "t" }]),
          watch: (cb) => {
            fire = cb;
            return () => {};
          },
          writeCache: () => {},
        });
        mgr.init();
        await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("frozen")?.status === "connected");
        writeFileSync(runtime, JSON.stringify({
          MCP_SERVERS: JSON.stringify({
            mcpServers: {
              frozen: { command: "frozen-cmd" },
              added: { command: "added-cmd" },
            },
          }),
        }));
        refreshConfig();
        fire();
        await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("added")?.status === "connected");
      },
    );
  });

  it("setLiveWorkspaceMcpConfig 覆盖回合内陈旧 ALS 快照", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-hot-live-"));
    dirs.push(dir);
    await runInWorkspace(
      {
        origin: "main",
        workspace: dir,
        cwd: dir,
        config: {
          PI_MCP_CONFIG: JSON.stringify([{ name: "frozen", config: { command: "frozen-cmd" } }]),
        },
      },
      async () => {
        const mgr = createManager({
          workspace: dir,
          connect: async () => fakeClient([{ name: "t" }]),
          watch: () => () => {},
          writeCache: () => {},
        });
        mgr.init();
        await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("frozen")?.status === "connected");
        setLiveWorkspaceMcpConfig(dir, JSON.stringify([
          { name: "frozen", config: { command: "frozen-cmd" } },
          { name: "added", config: { command: "added-cmd" } },
        ]));
        mgr.reconcile();
        await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("added")?.status === "connected");
      },
    );
  });
});

describe("reconcile", () => {
  it("显式 reconcile 与 watch 一样应用新增 server", async () => {
    let servers = [srv("a")];
    const mgr = createManager({
      connect: async () => fakeClient([{ name: "t" }]),
      readServers: () => servers,
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    servers = [srv("a"), srv("b")];
    mgr.reconcile();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("b")?.status === "connected");
  });

  it("reconcileMcpManager 在无 manager 时是空操作", () => {
    expect(() => reconcileMcpManager("D:/missing-ws")).not.toThrow();
  });
});

describe("reloadServer", () => {
  it("已连接时关旧 client 再连，中间 catalog 仍在且为 connecting", async () => {
    let releaseSecond = () => {};
    let connectCount = 0;
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => {
      connectCount += 1;
      if (connectCount === 1) {
        return { ...fakeClient([{ name: "t1" }]), close };
      }
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      return fakeClient([{ name: "t2" }]);
    });
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");

    const reloading = mgr.reloadServer("a");
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connecting");
    expect(mgr.snapshot().servers.has("a")).toBe(true);
    expect(close).toHaveBeenCalled();

    releaseSecond();
    await reloading;
    expect(mgr.snapshot().servers.get("a")?.status).toBe("connected");
    expect(mgr.snapshot().servers.get("a")?.tools.map((t) => t.name)).toEqual(["t2"]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("配置未变也会重连", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(connect).toHaveBeenCalledTimes(1);
    await mgr.reloadServer("a");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("名称不在已启用列表时 reject，且文案含 server 名", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    await expect(mgr.reloadServer("ghost")).rejects.toThrow(/ghost/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("未 init 时触发 init，目标 connect 恰好一次，resolve 时已是终态", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a"), srv("b")],
      watch: () => () => {},
      writeCache: () => {},
    });
    await mgr.reloadServer("a");
    expect(connect.mock.calls.filter(([s]) => s.name === "a")).toHaveLength(1);
    expect(mgr.snapshot().servers.get("a")?.status).toBe("connected");
    expect(mgr.snapshot().servers.get("b")?.status).toBe("connected");
  });

  it("重叠 reloadServer 时先发起的也等到最新终态，过期 connect 不得写回工具列表", async () => {
    let releaseFirstReloadConnect = () => {};
    let releaseSecondReloadConnect = () => {};
    let resolveEnteredFirstReload = () => {};
    let resolveEnteredSecondReload = () => {};
    const enteredFirstReloadConnect = new Promise<void>((resolve) => {
      resolveEnteredFirstReload = resolve;
    });
    const enteredSecondReloadConnect = new Promise<void>((resolve) => {
      resolveEnteredSecondReload = resolve;
    });
    let connectCount = 0;
    const connect = vi.fn(async () => {
      connectCount += 1;
      if (connectCount === 1) {
        return fakeClient([{ name: "init" }]);
      }
      if (connectCount === 2) {
        resolveEnteredFirstReload();
        await new Promise<void>((resolve) => {
          releaseFirstReloadConnect = resolve;
        });
        return fakeClient([{ name: "first" }]);
      }
      resolveEnteredSecondReload();
      await new Promise<void>((resolve) => {
        releaseSecondReloadConnect = resolve;
      });
      return fakeClient([{ name: "second" }]);
    });
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");

    const first = mgr.reloadServer("a");
    await enteredFirstReloadConnect;
    const second = mgr.reloadServer("a");
    await enteredSecondReloadConnect;

    let statusWhenFirstSettled: string | undefined;
    const trackedFirst = first.then(() => {
      statusWhenFirstSettled = mgr.snapshot().servers.get("a")?.status;
    });

    releaseFirstReloadConnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusWhenFirstSettled).toBeUndefined();
    expect(mgr.snapshot().servers.get("a")?.status).toBe("connecting");
    expect(mgr.snapshot().servers.get("a")?.tools.map((t) => t.name) ?? []).not.toEqual(["first"]);

    releaseSecondReloadConnect();
    await trackedFirst;
    await second;
    const entry = mgr.snapshot().servers.get("a");
    expect(statusWhenFirstSettled).not.toBe("connecting");
    expect(["connected", "failed"]).toContain(entry?.status);
    expect(entry?.tools.map((t) => t.name)).toEqual(["second"]);
  });

  it("waits while that server is connecting and returns a failed server error without calling the transport", async () => {
    const transport = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    let release: () => void = () => {};
    const connect = (server: McpServerConfig) => {
      if (server.name === "bad") return Promise.reject(new Error("boom"));
      return new Promise<McpClient>((resolve) => {
        release = () => resolve({
          listTools: async () => ({ tools: [{ name: "alpha" }] }),
          callTool: transport,
          close: async () => {},
        });
      });
    };
    const mgr = createManager({
      connect,
      readServers: () => [srv("slow"), srv("bad")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("bad")?.status === "failed");
    await expect(mgr.callTool("bad", "alpha", {})).resolves.toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    expect(transport).not.toHaveBeenCalled();

    let done = false;
    const pending = mgr.callTool("slow", "alpha", {}).then((value) => {
      done = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(mgr.snapshot().servers.get("slow")?.status).toBe("connecting");
    release();
    await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("a second progress notification clears a timer that would already have fired", async () => {
    let onProgress: (() => void) | undefined;
    let resolveCall: (value: { content: Array<{ type: string; text: string }> }) => void = () => {};
    const connect = async () => ({
      listTools: async () => ({ tools: [{ name: "alpha" }] }),
      callTool: (args: { onProgress?: () => void }) => {
        onProgress = args.onProgress;
        return new Promise<{ content: Array<{ type: string; text: string }> }>((resolve) => {
          resolveCall = resolve;
        });
      },
      close: async () => {},
    });
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = mgr.callTool("a", "alpha", {});
      expect(onProgress).toBeTypeOf("function");
      onProgress!();
      await vi.advanceTimersByTimeAsync(59_000);
      onProgress!();
      await vi.advanceTimersByTimeAsync(59_000);
      resolveCall({ content: [{ type: "text", text: "late" }] });
      await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "late" }] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getMcpManagerFor", () => {
  it("按 workspace 分键，同键返回同一实例", () => {
    const a = getMcpManagerFor("D:/a");
    const b = getMcpManagerFor("D:/b");
    expect(a).not.toBe(b);
    expect(getMcpManagerFor("D:/a")).toBe(a);
  });
});
