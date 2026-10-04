import { describe, expect, it, vi } from "vitest";
import type { McpSnapshot } from "./manager";
import { bind, project, summary } from "./index";

function snap(
  servers: Record<string, {
    status: string;
    tools: string[];
    exposure?: string;
    toolExposure?: Record<string, string>;
    description?: string;
    auth?: "none" | "oauth" | "provider";
  }>,
  options?: { autoEnableCodemode?: boolean },
): McpSnapshot {
  return {
    ...(options?.autoEnableCodemode !== undefined ? { autoEnableCodemode: options.autoEnableCodemode } : {}),
    servers: new Map(
      Object.entries(servers).map(([name, v]) => [
        name,
        {
          status: v.status as never,
          tools: v.tools.map((t) => ({ name: t })),
          ...(v.exposure !== undefined ? { exposure: v.exposure } : {}),
          ...(v.toolExposure ? { toolExposure: v.toolExposure } : {}),
          ...(v.description !== undefined ? { description: v.description } : {}),
          ...(v.auth ? { auth: v.auth } : {}),
        },
      ]),
    ),
  };
}

function fakeProjectPi() {
  const registered: string[] = [];
  const tools: Array<Record<string, unknown>> = [];
  let active: string[] = [];
  return {
    registered,
    tools,
    get active() {
      return active;
    },
    registerTool: (t: { name: string }) => {
      registered.push(t.name);
      tools.push(t);
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
      { name: "a", status: "connected", tools: 2, toolNames: ["mcp__a__x", "mcp__a__y"], exposure: "codemode", auth: "none" },
      { name: "b", status: "failed", tools: 0, toolNames: [], exposure: "codemode", auth: "none" },
    ]);
  });

  it("reports exposure and auth", () => {
    const out = summary(snap({
      direct: { status: "connected", tools: ["x"], exposure: "direct", auth: "oauth" },
      vendor: { status: "failed", tools: [], auth: "provider" },
    }));
    expect(out).toEqual([
      { name: "direct", status: "connected", tools: 1, toolNames: ["mcp__direct__x"], exposure: "direct", auth: "oauth" },
      { name: "vendor", status: "failed", tools: 0, toolNames: [], exposure: "codemode", auth: "provider" },
    ]);
  });
});

describe("project", () => {
  it("registers connected tools and activates them, deactivating stale mcp tools", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read", "codemode", "mcp__old__gone"]);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), fakeMgr());
    expect(pi.registered).toEqual(["mcp__a__x"]);
    expect(pi.tools[0]?.originalToolName).toBe("x");
    expect(pi.tools[0]?.exposure).toBe("codemode");
    expect(pi.active).toEqual(["read", "codemode"]);
    expect(pi.active).not.toContain("mcp__a__x");
    expect(pi.active).not.toContain("mcp__old__gone");
  });

  it("drops already-active non-direct MCP tools", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["mcp__a__x", "read"]);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), fakeMgr());
    expect(pi.active).toEqual(["read", "codemode"]);
    expect(pi.active).not.toContain("mcp__a__x");
  });

  it("activates a direct tool without adding codemode because of it", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read"]);
    project(pi as never, snap({
      "my.server": { status: "connected", tools: ["read-file"], exposure: "direct", description: "Docs" },
    }), fakeMgr());
    expect(pi.registered).toEqual(["mcp__my_server__read_file"]);
    expect(pi.tools[0]).toMatchObject({
      originalToolName: "read-file",
      exposure: "direct",
      namespace: { name: "mcp__my.server", description: "Docs" },
    });
    expect((pi.tools[0]?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties).toEqual(
      expect.objectContaining({
        content: expect.anything(),
        isError: expect.anything(),
        structuredContent: expect.anything(),
      }),
    );
    expect(pi.active).toEqual(["read", "mcp__my_server__read_file"]);
    expect(pi.active).not.toContain("codemode");
  });

  it("activates tool_search for a deferred server and leaves that MCP tool inactive", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read"]);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"], exposure: "deferred" } }), fakeMgr());
    expect(pi.registered).toEqual(["mcp__a__x"]);
    expect(pi.active).toEqual(["read", "tool_search"]);
    expect(pi.active).not.toContain("mcp__a__x");
    expect(pi.active).not.toContain("codemode");
  });

  it("activates tool_search when a tool resolves to deferred", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read"]);
    project(pi as never, snap({
      a: { status: "connected", tools: ["x"], exposure: "codemode", toolExposure: { x: "deferred" } },
    }), fakeMgr());
    expect(pi.active).toContain("tool_search");
    expect(pi.active).toContain("codemode");
    expect(pi.active).not.toContain("mcp__a__x");
  });

  it("does not activate codemode when autoEnableCodemode is false and the only servers are codemode", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read"]);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }, { autoEnableCodemode: false }), fakeMgr());
    expect(pi.active).toEqual(["read"]);
    expect(pi.active).not.toContain("codemode");
    expect(pi.active).not.toContain("mcp__a__x");
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
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'MCP 调用已被 Electron 权限策略拒绝' }]);
  });

  it("forwards isError from the manager result", async () => {
    const pi = fakeProjectPi();
    const manager = {
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "bad" }], isError: true })),
    };
    const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    pi.registerTool = (tool: any) => definitions.push(tool);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), manager as never);

    const result = await definitions[0].execute("call", { q: 1 }, undefined);

    expect(manager.callTool).toHaveBeenCalledWith("a", "x", { q: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "bad" }],
    });
    expect(result.content[0].text).toContain("bad");
  });

  it("authorize 上报 ctx.cwd 而不是 process.cwd()", async () => {
    const pi = fakeProjectPi();
    const manager = { callTool: vi.fn(async () => ({ text: "x" })) };
    const control = { request: vi.fn(async () => ({ status: "allowed" })) };
    const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    pi.registerTool = (tool: any) => definitions.push(tool);
    project(pi as never, snap({ a: { status: "connected", tools: ["x"] } }), manager as never, control as never);

    await definitions[0].execute("call", {}, undefined, undefined, { cwd: "D:/proj-a" });

    expect(control.request).toHaveBeenCalledWith(
      "permission.authorize",
      expect.objectContaining({ operation: expect.objectContaining({ workspace: "D:/proj-a" }) }),
    );
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

    expect(control.request).toHaveBeenCalledWith('mcp.state.publish', { workspace: 'C:/work', servers: [{ name: 'a', status: 'connected', tools: 1, toolNames: ['mcp__a__x'], exposure: 'codemode', auth: 'none' }] });
  });
});
