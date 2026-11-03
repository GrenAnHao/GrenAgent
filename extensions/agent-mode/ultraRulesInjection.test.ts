import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import factory from "./index.js";
import { setAgentMode, __resetAgentModeForTest, type AgentMode } from "./modes.js";
import { ULTRA_RULES_CONTEXT_PATH } from "./ultra-rules.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

const cwd = "D:/ultra-ws";
const sessionId = "s-ultra";

function load() {
  const handlers: Record<string, Handler> = {};
  factory({
    registerCommand: () => {},
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    appendEntry: vi.fn(),
    getActiveTools: () => ["read", "write", "bash", "edit"],
    setActiveTools: vi.fn(),
    registerTool: () => {},
    sendMessage: vi.fn(),
  } as never);
  return handlers;
}

function ctx(entries: unknown[] = []) {
  return {
    cwd,
    isIdle: () => true,
    sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

function event(extra: Record<string, unknown> = {}) {
  return {
    systemPromptOptions: { cwd, contextFiles: [{ path: "/AGENTS.md", content: "a" }] },
    ...extra,
  } as { systemPromptOptions: { cwd: string; contextFiles: Array<{ path: string; content: string }> } } & Record<string, unknown>;
}

const hasUltra = (e: ReturnType<typeof event>) =>
  e.systemPromptOptions.contextFiles.some((file) => file.path === ULTRA_RULES_CONTEXT_PATH);

async function boot(mode: AgentMode, entries: unknown[] = []) {
  const handlers = load();
  setAgentMode(mode, cwd, sessionId);
  const session = ctx(entries);
  await handlers.session_start!({}, session);
  return { handlers, session };
}

beforeEach(() => {
  __resetAgentModeForTest();
  delete process.env.PI_IS_SUBAGENT;
});
afterEach(() => delete process.env.PI_IS_SUBAGENT);

describe("Ultra 内置规则注入", () => {
  it("主会话 mode ultra 时经 systemPromptOptions.contextFiles 追加", async () => {
    const { handlers, session } = await boot("ultra");
    const e = event();
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(true);
    expect(e.systemPromptOptions.contextFiles[0]).toEqual({ path: "/AGENTS.md", content: "a" });
  });

  it("切出 ultra 后同一 event 对象上不残留", async () => {
    const { handlers, session } = await boot("ultra");
    const e = event();
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(true);

    setAgentMode("agent", cwd, sessionId);
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(false);
    expect(e.systemPromptOptions.contextFiles).toEqual([{ path: "/AGENTS.md", content: "a" }]);
  });

  it("非 ultra 模式从不注入", async () => {
    const { handlers, session } = await boot("debug");
    const e = event();
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(false);
  });

  it("custom 触发的回合（后台唤醒 / 子代理回报）仍保留规则", async () => {
    const { handlers, session } = await boot("ultra");
    const e = event({ messageType: "custom" });
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(true);
  });

  it("会话条目里有 subagent_meta 的子代理不注入，避免递归编排主代理", async () => {
    const entries = [{ type: "custom", customType: "subagent_meta", data: { origin: "subagent" } }];
    const { handlers, session } = await boot("ultra", entries);
    const e = event();
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(false);
  });

  it("PI_IS_SUBAGENT=1 的 fork 子进程不注入", async () => {
    const { handlers, session } = await boot("ultra");
    process.env.PI_IS_SUBAGENT = "1";
    const e = event();
    await handlers.before_agent_start!(e, session);
    expect(hasUltra(e)).toBe(false);
  });
});
