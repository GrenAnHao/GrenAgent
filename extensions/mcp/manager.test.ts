import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./config";
import { getMcpManager, disposeMcpManager, __resetMcpManagersForTest, createManager, managedServers, type McpClient, type McpSnapshot } from "./manager";
import { runInWorkspace } from "../_shared/workspace-context.js";

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

  it("routes callTool to the connected client and extracts text", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }], { content: [{ type: "text", text: "hi" }] });
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(await mgr.callTool("a", "alpha", {})).toEqual({ text: "hi" });
    await expect(mgr.callTool("nope", "x", {})).rejects.toThrow(/not connected/);
  });

  it("returns the fallback text when a tool result omits content", async () => {
    const connect = async () => fakeClient([{ name: "alpha" }], {});
    const mgr = createManager({ connect, readServers: () => [srv("a")], watch: () => () => {}, writeCache: () => {} });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(await mgr.callTool("a", "alpha", {})).toEqual({ text: "(no output)" });
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
});
