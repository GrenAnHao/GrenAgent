import { describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./config";
import { createManager, type McpSnapshot } from "./manager";
import { bind, project, retainDeferredNames, summary } from "./index";
import { installToolRefreshBatching } from "../_shared/tool-refresh-batch.js";

const RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;

function snap(
  servers: Record<string, {
    status: string;
    tools: string[];
    exposure?: string;
    toolExposure?: Record<string, string>;
    description?: string;
    auth?: "none" | "oauth" | "provider";
    loginUrl?: string;
    resources?: boolean;
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
          ...(v.loginUrl ? { loginUrl: v.loginUrl } : {}),
          ...(v.resources !== undefined ? { hasResources: v.resources } : {}),
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

  it("includes loginUrl on the published summary when present", () => {
    const out = summary(snap({
      vendor: { status: "failed", tools: [], auth: "oauth", loginUrl: "https://auth.example/login" },
      plain: { status: "connected", tools: ["x"] },
    }));
    expect(out[0]).toMatchObject({
      name: "vendor",
      exposure: "codemode",
      auth: "oauth",
      loginUrl: "https://auth.example/login",
    });
    expect(out[1]).not.toHaveProperty("loginUrl");
  });
});

describe("retainDeferredNames", () => {
  it("keeps a saved MCP name that the current registry has not registered yet", () => {
    const active = retainDeferredNames(["mcp__a__search"], ["read"]);
    expect(active).toEqual(expect.arrayContaining(["read", "mcp__a__search"]));
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

  it("registers resource tools at the widest exposure when any resource server is direct", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read"]);
    project(pi as never, snap({
      wiki: { status: "connected", tools: ["x"], exposure: "codemode", resources: true },
      docs: { status: "connected", tools: ["y"], exposure: "direct", resources: true },
    }), fakeMgr());
    const resourceTools = pi.tools.filter((tool) => RESOURCE_TOOLS.includes(tool.name as typeof RESOURCE_TOOLS[number]));
    expect(resourceTools.map((tool) => tool.name)).toEqual([...RESOURCE_TOOLS]);
    expect(resourceTools.map((tool) => tool.exposure)).toEqual(["direct", "direct", "direct"]);
    for (const name of RESOURCE_TOOLS) expect(pi.active).toContain(name);
  });

  it("does not register resource tools when every resource server is hidden", () => {
    const pi = fakeProjectPi();
    project(pi as never, snap({
      secret: { status: "connected", tools: ["x"], exposure: "hidden", resources: true },
      plain: { status: "connected", tools: ["y"], exposure: "codemode" },
    }), fakeMgr());
    for (const name of RESOURCE_TOOLS) expect(pi.registered).not.toContain(name);
    expect(pi.registered).toContain("mcp__plain__y");
  });

  it("drops previously active list_mcp_resources when every resource server is hidden", () => {
    const pi = fakeProjectPi();
    pi.setActiveTools(["read", "list_mcp_resources"]);
    project(pi as never, snap({
      secret: { status: "connected", tools: ["x"], exposure: "hidden", resources: true },
    }), fakeMgr());
    expect(pi.active).toEqual(["read"]);
    expect(pi.active).not.toContain("list_mcp_resources");
    expect(pi.registered).not.toContain("list_mcp_resources");
  });

  it("calls listResources, listResourceTemplates, and readResource by tool name and shapes the result", async () => {
    const pi = fakeProjectPi();
    const listResources = vi.fn(async () => ({ content: [{ type: "text", text: "resources" }] }));
    const listResourceTemplates = vi.fn(async () => ({ content: [{ type: "text", text: "templates" }] }));
    const readResource = vi.fn(async () => ({ content: [{ type: "text", text: "body" }] }));
    const definitions: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    pi.registerTool = (tool: any) => {
      pi.registered.push(tool.name);
      pi.tools.push(tool);
      definitions.push(tool);
    };
    project(pi as never, snap({
      docs: { status: "connected", tools: ["x"], exposure: "direct", resources: true },
    }), { callTool: async () => ({ text: "x" }), listResources, listResourceTemplates, readResource } as never);

    const list = definitions.find((tool) => tool.name === "list_mcp_resources");
    const templates = definitions.find((tool) => tool.name === "list_mcp_resource_templates");
    const read = definitions.find((tool) => tool.name === "read_mcp_resource");
    expect(list).toBeDefined();
    const listed = await list!.execute("call", { server: "docs" }, undefined);
    const templated = await templates!.execute("call", {}, undefined);
    const body = await read!.execute("call", { server: "docs", uri: "file://a" }, undefined);

    expect(listResources).toHaveBeenCalledWith({ server: "docs" });
    expect(listResourceTemplates).toHaveBeenCalledWith({});
    expect(readResource).toHaveBeenCalledWith({ server: "docs", uri: "file://a" });
    expect(listed.content[0].text).toContain("resources");
    expect(listed.structuredContent).toMatchObject({ content: [{ type: "text", text: "resources" }] });
    expect(templated.content[0].text).toContain("templates");
    expect(body.content[0].text).toContain("body");
    expect(body.isError).toBe(false);
  });

  it("does not clear an outstanding unregistered MCP name when projecting another server", () => {
    const pi = piWithPendingRule({
      active: ["read", "mcp__a__x"],
      pending: ["mcp__b__search"],
      registered: ["read", "codemode", "tool_search", "mcp__a__x"],
    });

    const kept = project(
      pi as never,
      snap({ a: { status: "connected", tools: ["x"] } }),
      fakeMgr(),
      undefined,
      ["mcp__b__search"],
    );

    expect(pi.pending.has("mcp__b__search")).toBe(true);
    expect(kept).toEqual(["mcp__b__search"]);
    expect(pi.calls[0]).not.toContain("mcp__b__search");
    expect(pi.active).toEqual(expect.arrayContaining(["read", "codemode", "mcp__a__x"]));
    expect(pi.active).not.toContain("mcp__b__search");

    const after = project(
      pi as never,
      snap({
        a: { status: "connected", tools: ["x"] },
        b: { status: "connected", tools: ["search"], exposure: "deferred" },
      }),
      fakeMgr(),
      undefined,
      kept,
    );

    expect(pi.registered).toContain("mcp__b__search");
    expect(after).toEqual([]);
    expect(pi.active).not.toContain("mcp__b__search");
    expect(pi.active).not.toContain("mcp__a__x");
    expect(pi.active).toEqual(expect.arrayContaining(["read", "codemode", "tool_search"]));
  });

  it("drops a failed server name and keeps an unknown or still-connecting name", () => {
    const pi = piWithPendingRule({
      active: ["read", "mcp__a__x"],
      pending: ["mcp__b__search", "mcp__c__gone", "mcp__d__find"],
      registered: ["read", "codemode", "tool_search", "mcp__a__x"],
    });

    const kept = project(
      pi as never,
      snap({
        a: { status: "connected", tools: ["x"] },
        c: { status: "failed", tools: [] },
        d: { status: "connecting", tools: [] },
      }),
      fakeMgr(),
      undefined,
      ["mcp__b__search", "mcp__c__gone", "mcp__d__find"],
    );

    expect(kept).toEqual(["mcp__b__search", "mcp__d__find"]);
    expect(pi.pending.has("mcp__b__search")).toBe(true);
    expect(pi.pending.has("mcp__d__find")).toBe(true);
    expect(pi.active).toContain("mcp__a__x");
    expect(pi.calls.every((names) => !names.includes("mcp__c__gone"))).toBe(true);
  });
});

describe("project 增量注册", () => {
  /** 和真实 pi 一样：每次 registerTool 都同步刷新一次工具表。 */
  function piWithRefreshCount() {
    const base = fakeProjectPi();
    const session = { refreshes: 0, _refreshToolRegistry() { this.refreshes += 1; } };
    installToolRefreshBatching(session);
    let setCalls = 0;
    return {
      session,
      registered: base.registered,
      get active() { return base.active; },
      get setCalls() { return setCalls; },
      registerTool: (t: { name: string }) => { base.registerTool(t); session._refreshToolRegistry(); },
      getActiveTools: () => base.getActiveTools(),
      setActiveTools: (names: string[]) => { setCalls += 1; base.setActiveTools(names); },
    };
  }

  const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it("同一份快照再投影一次，不重新注册任何工具", () => {
    const pi = fakeProjectPi();
    const cache = new Map<string, string>();
    const s = snap({ a: { status: "connected", tools: ["x", "y"] }, r: { status: "connected", tools: [], resources: true } });
    project(pi as never, s, fakeMgr(), undefined, [], cache);
    const first = pi.registered.length;
    project(pi as never, s, fakeMgr(), undefined, [], cache);
    expect(first).toBe(2 + RESOURCE_TOOLS.length);
    expect(pi.registered).toHaveLength(first);
  });

  it("只有定义变了的工具重新注册", () => {
    const pi = fakeProjectPi();
    const cache = new Map<string, string>();
    project(pi as never, snap({ a: { status: "connected", tools: ["x", "y"] } }), fakeMgr(), undefined, [], cache);
    project(pi as never, snap({ a: { status: "connected", tools: ["x", "y"], toolExposure: { y: "direct" } } }), fakeMgr(), undefined, [], cache);
    expect(pi.registered).toEqual(["mcp__a__x", "mcp__a__y", "mcp__a__y"]);
  });

  it("服务器连接中 / 断开再连回同样的工具，都不重新注册", () => {
    const pi = fakeProjectPi();
    const cache = new Map<string, string>();
    project(pi as never, snap({ a: { status: "connected", tools: many(50) } }), fakeMgr(), undefined, [], cache);
    project(pi as never, snap({ a: { status: "connecting", tools: [] } }), fakeMgr(), undefined, [], cache);
    project(pi as never, snap({}), fakeMgr(), undefined, [], cache);
    project(pi as never, snap({ a: { status: "connected", tools: many(50) } }), fakeMgr(), undefined, [], cache);
    expect(pi.registered).toHaveLength(50);
  });

  it("一次投影里注册再多工具，工具表也只刷新一次", () => {
    const pi = piWithRefreshCount();
    project(pi as never, snap({ a: { status: "connected", tools: many(300) }, b: { status: "connected", tools: many(20) } }), fakeMgr(), undefined, [], new Map());
    expect(pi.registered).toHaveLength(320);
    expect(pi.session.refreshes).toBe(1);
  });

  it("活动工具清单没变时不再调用 setActiveTools", () => {
    const pi = piWithRefreshCount();
    const cache = new Map<string, string>();
    const s = snap({ a: { status: "connected", tools: ["x"] } });
    project(pi as never, s, fakeMgr(), undefined, [], cache);
    const afterFirst = pi.setCalls;
    project(pi as never, s, fakeMgr(), undefined, [], cache);
    expect(afterFirst).toBe(1);
    expect(pi.setCalls).toBe(1);
    expect(pi.active).toEqual(["codemode"]);
  });

  it("bind 里连续多次推送同样的快照，只在第一次注册", async () => {
    const pi = fakePiWithOn();
    const s = snap({ a: { status: "connected", tools: ["x", "y"] } });
    const mgr = fakeBindMgr(s);
    bind(pi as never, mgr as never);
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    mgr.emit(s);
    mgr.emit(s);
    expect(pi.registered).toEqual(["mcp__a__x", "mcp__a__y"]);
  });
});

function piWithPendingRule(initial: { active: string[]; pending: string[]; registered: string[] }) {
  const registry = new Set(initial.registered);
  let active = [...initial.active];
  let pending = new Set(initial.pending);
  const registered: string[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const calls: string[][] = [];
  return {
    registered,
    tools,
    calls,
    get active() {
      return active;
    },
    get pending() {
      return pending;
    },
    registerTool: (t: { name: string }) => {
      registry.add(t.name);
      registered.push(t.name);
      tools.push(t);
      if (pending.has(t.name)) {
        pending.delete(t.name);
        if (!active.includes(t.name)) active = [...active, t.name];
      }
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      calls.push([...names]);
      const applied = names.filter((name) => registry.has(name));
      if (active.some((name) => !applied.includes(name))) pending = new Set();
      for (const name of applied) pending.delete(name);
      active = applied;
    },
  };
}

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
    getMcpServers: (): Array<{ name: string; config: { command?: string; url?: string }; extensionPath: string }> => [],
    fire: (ev: string, ...args: unknown[]) => Promise.all((handlers.get(ev) ?? []).map((h) => h(...args))),
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
  it("keeps an unregistered MCP name on reload and drops it once registered as non-direct", async () => {
    const pi = fakePiWithOn();
    pi.setActiveTools(["read", "mcp__a__search"]);
    const mgr = fakeBindMgr(snap({ a: { status: "connecting", tools: [] } }));
    bind(pi as never, mgr as never);

    await pi.fire("session_start", { type: "session_start", reason: "reload" }, { hasUI: false });
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["read", "mcp__a__search"]));

    mgr.emit(snap({ a: { status: "connected", tools: ["search"], exposure: "deferred" } }));
    expect(pi.registered).toContain("mcp__a__search");
    expect(pi.getActiveTools()).not.toContain("mcp__a__search");
  });

  it("keeps an unregistered MCP name when a session is restored", async () => {
    const pi = fakePiWithOn();
    pi.setActiveTools(["read", "mcp__a__search"]);
    const mgr = fakeBindMgr(snap({ a: { status: "connecting", tools: [] } }));
    bind(pi as never, mgr as never);

    await pi.fire("session_start", { type: "session_start", reason: "resume" }, { hasUI: false });
    expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["read", "mcp__a__search"]));
  });

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

  it("reads the provider token from the shared runtime and does not replace that callback", async () => {
    const pi = fakePiWithOn();
    const mgr = fakeBindMgr(snap({ a: { status: "connected", tools: ["x"] } }));
    bind(pi as never, mgr as never);
    const runtime = {
      getAuth: vi.fn(async () => ({ auth: { apiKey: "tok-1" } })),
    };
    pi.fire("session_start", {}, { hasUI: false, modelRegistry: { runtime } });
    const read = mgr.getProviderToken as (provider: string) => Promise<string | undefined>;
    expect(await read("openai")).toBe("tok-1");

    runtime.getAuth.mockResolvedValue({ auth: { apiKey: "tok-2" } });
    pi.fire("session_start", {}, { hasUI: false, modelRegistry: { runtime } });
    expect(mgr.getProviderToken).toBe(read);
    expect(await read("openai")).toBe("tok-2");

    const other = { getAuth: vi.fn(async () => ({ auth: { apiKey: "other" } })) };
    pi.fire("session_start", {}, { hasUI: false, modelRegistry: { runtime: other } });
    expect(mgr.getProviderToken).not.toBe(read);
    expect(await (mgr.getProviderToken as typeof read)("anthropic")).toBe("other");
    expect(other.getAuth).toHaveBeenCalledWith("anthropic");
  });

  it("before_agent_start waits only for direct servers and appends the summary when it changes", async () => {
    let release: () => void = () => {};
    const direct = new Promise<void>((resolve) => { release = resolve; });
    const background = new Promise<void>(() => {});
    const seen: string[] = [];
    const pi = fakePiWithOn();
    const appendMessage = vi.fn();
    const entries: Array<{ type: string; customType: string; content: string; display: boolean }> = [];
    const mgr = {
      ...fakeBindMgr(snap({
        docs: { status: "connecting", tools: [], exposure: "direct", description: "Docs\nsecond" },
        vendor: { status: "connecting", tools: [], exposure: "codemode", description: "Vendor" },
        picked: { status: "connecting", tools: [], exposure: "codemode", toolExposure: { read: "direct" }, description: "Picked" },
      })),
      connectPromise(name: string) {
        seen.push(name);
        if (name === "vendor") return background;
        return direct;
      },
    };
    bind(pi as never, mgr as never);
    const ctx = { sessionManager: { buildContextEntries: () => entries, appendMessage } };
    let finished = false;
    const pending = pi.fire("before_agent_start", {}, ctx).then((results) => {
      finished = true;
      return results;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(seen).toEqual(["docs", "picked"]);
    release();
    const outcome = await Promise.race([
      pending.then((results) => ({ ok: true as const, results })),
      new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 300)),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const message = (outcome.results[0] as { message?: { customType: string; content: string; display: boolean } }).message;
    expect(message).toEqual({
      customType: "mcp-servers",
      content: "docs direct Docs\nvendor codemode Vendor\npicked codemode Picked",
      display: false,
    });
    expect(appendMessage).toHaveBeenCalledWith({
      role: "custom",
      customType: "mcp-servers",
      content: message?.content,
      display: false,
      timestamp: expect.any(Number),
    });
    entries.push({ type: "custom_message", customType: "mcp-servers", content: message?.content ?? "", display: false });
    const again = await pi.fire("before_agent_start", {}, ctx);
    expect(again[0]).toBeUndefined();
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  it("gives mcp_servers_change servers to the manager and does not override a file entry of the same name", async () => {
    const connect = vi.fn(async (server: McpServerConfig) => ({
      listTools: async () => ({ tools: [{ name: "x" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }));
    const mgr = createManager({
      connect,
      readServers: () => [{ name: "docs", transport: "stdio", command: "file-bin", args: [] }],
      watch: () => () => {},
      writeCache: () => {},
    });
    const pi = fakePiWithOn();
    pi.getMcpServers = () => [];
    bind(pi as never, mgr as never);
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    await pi.fire("mcp_servers_change", {
      type: "mcp_servers_change",
      servers: [
        { name: "docs", config: { command: "ext-bin" }, extensionPath: "ext.ts" },
        { name: "extra", config: { command: "extra-bin" }, extensionPath: "ext.ts" },
      ],
    }, {});

    const errors = mgr.snapshot().errors ?? [];
    const visible = `${errors.join("\n")}\n${JSON.stringify(summary(mgr.snapshot()))}`;
    expect(visible).toContain("docs");
    expect(errors.join("\n")).toContain("扩展登记的服务器 docs 被配置文件盖住");
    expect(connect.mock.calls.some((call) => call[0]?.command === "ext-bin")).toBe(false);
    await vi.waitFor(() => {
      expect(connect.mock.calls.some((call) => call[0]?.name === "extra" && call[0]?.source === "extension")).toBe(true);
    });
    expect(connect.mock.calls.some((call) => call[0]?.name === "docs" && call[0]?.command === "file-bin")).toBe(true);
  });

  it("rejects an extension server whose name only differs by dash versus underscore", async () => {
    const connect = vi.fn(async () => ({
      listTools: async () => ({ tools: [{ name: "x" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }));
    const mgr = createManager({
      connect,
      readServers: () => [{ name: "dev-radius", transport: "stdio", command: "file-bin", args: [] }],
      watch: () => () => {},
      writeCache: () => {},
    });
    const pi = fakePiWithOn();
    pi.getMcpServers = () => [{ name: "dev_radius", config: { command: "ext-bin" }, extensionPath: "ext.ts" }];
    bind(pi as never, mgr as never);
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });

    const errors = mgr.snapshot().errors ?? [];
    expect(errors.join("\n")).toContain("dev_radius");
    expect(connect.mock.calls.map((call) => call[0]?.name)).not.toContain("dev_radius");
    await vi.waitFor(() => {
      expect(connect.mock.calls.some((call) => call[0]?.name === "dev-radius")).toBe(true);
    });
    expect(connect.mock.calls.map((call) => call[0]?.name)).not.toContain("dev_radius");
  });

  it("disconnects a removed extension server and projects again", async () => {
    const connect = vi.fn(async () => ({
      listTools: async () => ({ tools: [{ name: "x" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }));
    const mgr = createManager({
      connect,
      readServers: () => [],
      watch: () => () => {},
      writeCache: () => {},
    });
    const pi = fakePiWithOn();
    // 每次投影都会发一条 mcp.state.publish；活动工具没变时不再 setActiveTools，不能拿它计数。
    const published: Array<Array<{ name: string }>> = [];
    const control = {
      request: vi.fn(async (kind: string, params: { servers?: Array<{ name: string }> }) => {
        if (kind === "mcp.state.publish") published.push(params.servers ?? []);
        return null;
      }),
    };
    pi.getMcpServers = () => [{ name: "extra", config: { command: "extra-bin" }, extensionPath: "ext.ts" }];
    bind(pi as never, mgr as never, control as never);
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, { hasUI: false });
    await vi.waitFor(() => {
      expect(mgr.snapshot().servers.get("extra")?.status).toBe("connected");
    });
    const before = published.length;
    await pi.fire("mcp_servers_change", { type: "mcp_servers_change", servers: [] }, {});
    await vi.waitFor(() => {
      expect(mgr.snapshot().servers.has("extra")).toBe(false);
    });
    expect(published.length).toBeGreaterThan(before);
    expect(published.at(-1)?.some((server) => server.name === "extra")).toBe(false);
  });
});
