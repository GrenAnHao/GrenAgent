import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import factory, { persistedMode } from "./index.js";
import {
  agentModeConfigKey,
  getAgentMode,
  setAgentMode,
  __resetAgentModeForTest,
} from "./modes.js";

function load() {
  const commands: string[] = [];
  const commandHandlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  const setActiveTools = vi.fn();
  const appendEntry = vi.fn();
  factory({
    registerCommand: (name: string, spec?: { handler?: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.push(name);
      if (spec?.handler) commandHandlers[name] = spec.handler;
    },
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
    appendEntry,
    getActiveTools: () => ["read", "write", "bash", "edit"],
    setActiveTools,
    registerTool: () => {},
    sendMessage: vi.fn(),
  } as never);
  return { commands, commandHandlers, handlers, setActiveTools, appendEntry };
}

function ctx(cwd = "D:/proj-a", entries: unknown[] = [], sessionId?: string) {
  return {
    cwd,
    sessionManager: { getEntries: () => entries, ...(sessionId ? { getSessionId: () => sessionId } : {}) },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
  vi.mocked(watchConfig).mockReset().mockImplementation(() => () => {});
  __resetAgentModeForTest();
});

describe("agent-mode factory", () => {
  it("does not register /mode, /plan or the old /plan-build; registers the plan panel commands", () => {
    const { commands } = load();
    expect(commands).not.toContain("mode");
    expect(commands).not.toContain("plan");
    expect(commands).not.toContain("plan-build");
    expect(commands).not.toContain("brainstorm-deliver");
    expect(commands).toEqual(
      expect.arrayContaining(["plan-update", "plan-confirm", "plan-cancel", "plan-finish"]),
    );
  });

  it("watchConfig applies desktop AGENT_MODE to tools and setStatus", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const { handlers, setActiveTools } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    const key = agentModeConfigKey("D:/proj-a");
    for (const cb of subscribers) cb({ [key]: "ask" });
    expect(setActiveTools).toHaveBeenCalled();
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "ask");
  });

  it("session_start prefers live AGENT_MODE over a stale session entry", async () => {
    const key = agentModeConfigKey("D:/proj-a");
    vi.mocked(getConfig).mockImplementation((name: string) => (name === key ? "debug" : undefined));
    const { handlers } = load();
    const session = ctx("D:/proj-a", [
      { type: "custom", customType: "agent-mode", data: { mode: "ask" } },
    ]);
    await handlers.session_start?.({}, session);
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "debug");
  });

  it("tool_call 按 live 拦截，即使闭包 currentMode 未刷", async () => {
    const { handlers } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    setAgentMode("ask", "D:/proj-a");
    const result = await handlers.tool_call?.({ toolName: "write", input: { path: "a.ts" } }, session);
    expect(result).toMatchObject({ block: true });
  });

  it("session_start 不覆盖已写入的 live", async () => {
    setAgentMode("plan", "D:/proj-a");
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "ask" : undefined,
    );
    const { handlers } = load();
    const session = ctx("D:/proj-a", [
      { type: "custom", customType: "agent-mode", data: { mode: "ask" } },
    ]);
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a")).toBe("plan");
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "plan");
  });

  it("before_agent_start 按 live 对齐工具集", async () => {
    const { handlers, setActiveTools } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    setActiveTools.mockClear();
    setAgentMode("ask", "D:/proj-a");
    await handlers.before_agent_start?.({});
    expect(setActiveTools).toHaveBeenCalled();
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "ask");
  });

});

describe("removed brainstorm mode compatibility", () => {
  it.each(["agent-mode", "session-controls"])("latest legacy %s entry restores Agent over an earlier Plan", (customType) => {
    expect(persistedMode([
      { type: "custom", customType: "agent-mode", data: { mode: "plan" } },
      { type: "custom", customType, data: { mode: "brainstorm" } },
    ])).toBe("agent");
  });

  it("legacy project default restores Agent over an earlier session Ask", async () => {
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "brainstorm" : undefined,
    );
    const { handlers } = load();
    const session = ctx("D:/proj-a", [
      { type: "custom", customType: "agent-mode", data: { mode: "ask" } },
    ]);
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a")).toBe("agent");
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "agent");
  });

  it("legacy project default hot update restores Agent", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const { handlers } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    const key = agentModeConfigKey("D:/proj-a");
    for (const cb of subscribers) cb({ [key]: "ask" });
    for (const cb of subscribers) cb({ [key]: "brainstorm" });
    expect(getAgentMode("D:/proj-a")).toBe("agent");
  });
});

describe("agent-mode per session", () => {
  it("切会话各回各的模式，项目默认变化不改已打开会话", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const { handlers } = load();
    const a = ctx("D:/proj-a", [{ type: "custom", customType: "session-controls", data: { mode: "ask" } }], "sa");
    await handlers.session_start?.({}, a);
    expect(getAgentMode("D:/proj-a", "sa")).toBe("ask");
    expect(a.ui.setStatus).toHaveBeenCalledWith("agent-mode", "ask");

    const b = ctx("D:/proj-a", [], "sb");
    await handlers.session_start?.({}, b);
    expect(getAgentMode("D:/proj-a", "sb")).toBe("agent");
    expect(b.ui.setStatus).toHaveBeenCalledWith("agent-mode", "agent");

    for (const cb of subscribers) cb({ [agentModeConfigKey("D:/proj-a")]: "debug" });
    expect(getAgentMode("D:/proj-a", "sb")).toBe("agent");
    expect(getAgentMode("D:/proj-a", "sa")).toBe("ask");
  });

  it("tool_call 按本会话模式拦截", async () => {
    const { handlers } = load();
    const session = ctx("D:/proj-a", [], "sa");
    await handlers.session_start?.({}, session);
    setAgentMode("ask", "D:/proj-a", "other");
    expect(await handlers.tool_call?.({ toolName: "write", input: { path: "a.ts" } }, session)).toBeUndefined();
    setAgentMode("ask", "D:/proj-a", "sa");
    expect(await handlers.tool_call?.({ toolName: "write", input: { path: "a.ts" } }, session)).toMatchObject({ block: true });
  });
});

describe("agent-mode 初值固化", () => {
  it("缺模式的旧会话首次继承项目默认时写回 canonical 条目（不再只钉内存）", async () => {
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "debug" : undefined,
    );
    const { handlers, appendEntry } = load();
    const session = ctx("D:/proj-a", [], "sa");
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a", "sa")).toBe("debug");
    expect(appendEntry).toHaveBeenCalledWith("session-preferences", expect.objectContaining({ mode: "debug" }));
  });

  it("会话已有模式条目时不重复固化", async () => {
    const { handlers, appendEntry } = load();
    const session = ctx(
      "D:/proj-a",
      [{ type: "custom", customType: "session-controls", data: { mode: "plan" } }],
      "sa",
    );
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a", "sa")).toBe("plan");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("固化失败不抹掉钉住的模式，也不抛错（下轮仍按会话运行）", async () => {
    const { handlers } = load();
    let entry: unknown;
    // 直接构造一个 appendEntry 抛错的扩展实例
    const throwing: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (ev: string, h: (event: unknown, ctx?: unknown) => unknown) => { throwing[ev] = h; },
      appendEntry: (type: string, data: unknown) => { entry = { type, data }; throw new Error("disk full"); },
      getActiveTools: () => ["read"],
      setActiveTools: () => {},
      registerTool: () => {},
      sendMessage: () => {},
    } as never);
    const session = ctx("D:/proj-a", [], "sa");
    await expect(throwing.session_start?.({}, session)).resolves.toBeUndefined();
    expect(getAgentMode("D:/proj-a", "sa")).toBe("agent");
    expect(entry).toMatchObject({ type: "session-preferences" });
    void handlers;
  });

  it("已有 canonical mode 时仍读扩展自动写的更新模式（Plan 确认不锁死）", async () => {
    const { handlers } = load();
    // canonical 里 mode=plan，之后扩展自动切 agent，条目排在后面
    const session = ctx(
      "D:/proj-a",
      [
        { type: "custom", customType: "session-preferences", data: { mode: "plan", revision: 1 } },
        { type: "custom", customType: "agent-mode", data: { mode: "agent" } },
      ],
      "sa",
    );
    // live 表没有该会话的模式：走 session_start 的会话条目恢复
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a", "sa")).toBe("agent");
  });
});
