import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import { getConfig, watchConfig } from "../_shared/runtime-config.js";
import factory from "./index.js";
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
    expect(commands).toEqual(
      expect.arrayContaining(["plan-update", "plan-confirm", "plan-cancel", "plan-finish", "brainstorm-deliver"]),
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
