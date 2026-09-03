import { describe, expect, it, vi } from "vitest";
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

  it("authorizes MCP calls through Electron before invoking a server", async () => {
    const pi = fakeProjectPi();
    const manager = { callTool: vi.fn(async () => ({ text: 'x' })) };
    const control = { request: vi.fn(async () => ({ status: 'denied' })) };
    const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    pi.registerTool = (tool: any) => definitions.push(tool);
    project(pi as never, snap({ a: { status: 'connected', tools: ['x'] } }), manager as never, control as never);

    const result = await definitions[0].execute('call', {}, undefined);

    expect(control.request).toHaveBeenCalledWith('permission.authorize', expect.objectContaining({ operation: expect.objectContaining({ kind: 'mcp.call', server: 'a', toolName: 'x' }) }));
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(result.details.error).toBe('denied');
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

  it("publishes MCP status through the Electron control plane", () => {
    const pi = fakePiWithOn();
    const mgr = fakeBindMgr(snap({ a: { status: 'connected', tools: ['x'] } }));
    const control = { request: vi.fn(async () => null) };
    bind(pi as never, mgr as never, control as never);

    pi.fire('session_start', {}, { cwd: 'C:/work', hasUI: true, ui: { setStatus: vi.fn() } });

    expect(control.request).toHaveBeenCalledWith('mcp.state.publish', { workspace: 'C:/work', servers: [{ name: 'a', status: 'connected', tools: 1, toolNames: ['mcp__a__x'] }] });
  });
});
