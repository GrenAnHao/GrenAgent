import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./config";
import { createManager, type McpClient, type McpSnapshot } from "./manager";

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
