import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import factory from "./index.js";
import { __resetAgentModeForTest, getAgentMode, setAgentMode } from "./modes.js";
import type { Plan, PlanStatusPayload } from "./plan.js";
import { __resetPlanStateForTest, getSessionPlan, planBlocksModeSwitch } from "./planState.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Tool = { name: string; promptSnippet?: string; defaultActive?: boolean; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

const LONG_STEP =
  "在 src/middleware/auth.ts 新建 requireAuth，统一 401/403 错误体；所有 /api 路由改经它校验 session，并删掉各路由里的内联校验，避免双重校验";

let cwd: string;

function load() {
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  let active = ["read", "write", "bash", "edit"];
  const setActiveTools = vi.fn((next: string[]) => {
    active = next;
  });
  factory({
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = spec.handler;
    },
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    appendEntry,
    getActiveTools: () => active,
    setActiveTools,
    registerTool: (tool: Tool) => {
      tools[tool.name] = tool;
    },
    sendMessage,
  } as never);
  return { commands, handlers, tools, sendMessage, appendEntry, setActiveTools, active: () => active };
}

function ctx(entries: unknown[] = [], idle = true) {
  return {
    cwd,
    isIdle: () => idle,
    sessionManager: { getEntries: () => entries, getSessionId: () => "s1" },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

function lastPlan(session: ReturnType<typeof ctx>): Plan | null {
  const calls = session.ui.setStatus.mock.calls.filter((c) => c[0] === "agent-plan");
  return (JSON.parse(calls.at(-1)![1]) as PlanStatusPayload).plan;
}

async function startInPlan() {
  const api = load();
  const session = ctx();
  setAgentMode("plan", cwd, "s1");
  await api.handlers.session_start?.({}, session);
  return { ...api, session };
}

async function upsert(api: Awaited<ReturnType<typeof startInPlan>>, params: Record<string, unknown>) {
  return api.tools.upsert_plan.execute("call", params, undefined, undefined, api.session);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "plan-flow-"));
  __resetAgentModeForTest();
  __resetPlanStateForTest();
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("upsert_plan", () => {
  it("registers with a promptSnippet and stays inactive by default; plan mode activates it", async () => {
    const api = await startInPlan();
    expect(api.tools.upsert_plan.promptSnippet).toBeTruthy();
    expect(api.tools.upsert_plan.defaultActive).toBe(false);
    expect(api.active()).toContain("upsert_plan");
    expect(api.active()).not.toContain("write");
  });

  it("creates a ready plan, posts one summary card, writes the projection, and binds the session", async () => {
    const api = await startInPlan();
    const res = await upsert(api, { title: "重构鉴权层", goal: "统一错误处理", steps: ["抽出中间件", LONG_STEP] });
    const plan = lastPlan(api.session)!;
    expect(plan).toMatchObject({ rev: 1, status: "ready", file: `.pi/plans/${plan.id}.md` });
    expect(plan.steps[1].text).toBe(LONG_STEP);
    expect(res.content[0].text).toContain(plan.id);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toMatchObject({ customType: "agent-plan", content: expect.stringMatching(/^\[plan:/) });
    expect(readFileSync(join(cwd, ".pi", "plans", `${plan.id}.md`), "utf8")).toContain(LONG_STEP);
    expect(getSessionPlan("s1")?.id).toBe(plan.id);

    // 修订：同 id、rev+1、不再发卡
    await upsert(api, { planId: plan.id, title: "重构鉴权层 v2", goal: "", steps: ["只剩一步"] });
    expect(lastPlan(api.session)).toMatchObject({ id: plan.id, rev: 2, title: "重构鉴权层 v2" });
    // 省略 planId 也修订当前未确认的计划
    await upsert(api, { title: "v3", goal: "", steps: ["a"] });
    expect(lastPlan(api.session)).toMatchObject({ id: plan.id, rev: 3 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid params and unknown planId with explicit errors", async () => {
    const api = await startInPlan();
    await expect(upsert(api, { title: "", goal: "", steps: ["a"] })).rejects.toThrow(/title/);
    await expect(upsert(api, { planId: "plan-nope", title: "t", goal: "", steps: ["a"] })).rejects.toThrow(/不存在/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("is refused outside plan mode", async () => {
    const api = load();
    const session = ctx();
    await api.handlers.session_start?.({}, session);
    await expect(api.tools.upsert_plan.execute("c", { title: "t", goal: "", steps: ["a"] }, undefined, undefined, session)).rejects.toThrow(/规划/);
    expect(await api.handlers.tool_call?.({ toolName: "upsert_plan", input: {} }, session)).toMatchObject({ block: true });
  });
});

describe("plan state machine", () => {
  it("blocks execution tools and the manual switch while unconfirmed", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: ["a"] });
    expect(await api.handlers.tool_call?.({ toolName: "write", input: { path: "a" } }, api.session)).toMatchObject({ block: true });
    expect(planBlocksModeSwitch("s1", "agent")).toBe(true);
    expect(planBlocksModeSwitch("s1", "debug")).toBe(true);
    expect(planBlocksModeSwitch("s1", "ask")).toBe(false);
  });

  it("before_agent_start pulls a sneaked-in agent mode back to plan while unconfirmed", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: ["a"] });
    setAgentMode("agent", cwd, "s1");
    await api.handlers.before_agent_start?.({});
    expect(getAgentMode(cwd, "s1")).toBe("plan");
    expect(api.session.ui.notify).toHaveBeenCalledWith(expect.stringContaining("确认执行"), "warning");
  });

  it("panel save revises the same id; stale rev is refused; the model hears about the edit next turn", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: ["a", "b"] });
    const id = lastPlan(api.session)!.id;
    await api.commands["plan-update"](JSON.stringify({ planId: id, rev: 1, title: "t", goal: "g", steps: [{ text: LONG_STEP, done: false }] }), api.session);
    expect(lastPlan(api.session)).toMatchObject({ id, rev: 2, updatedBy: "user", steps: [{ text: LONG_STEP, done: false }] });
    await api.commands["plan-update"](JSON.stringify({ planId: id, rev: 1, title: "x", goal: "", steps: ["c"] }), api.session);
    expect(lastPlan(api.session)!.rev).toBe(2);
    expect(api.session.ui.notify).toHaveBeenCalledWith(expect.stringContaining("第 2 版"), "warning");
    const injected = await api.handlers.before_agent_start?.({});
    expect(injected).toMatchObject({ message: { customType: "plan-edited-context", content: expect.stringContaining(LONG_STEP) } });
    expect(await api.handlers.before_agent_start?.({})).toBeUndefined();
  });

  it("confirm switches to agent, starts the run with full steps, then tracks [DONE:n] to done", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "g", steps: ["a", LONG_STEP] });
    const id = lastPlan(api.session)!.id;
    api.sendMessage.mockClear();

    await api.commands["plan-confirm"](`${id} 1`, api.session);
    expect(getAgentMode(cwd, "s1")).toBe("agent");
    expect(api.active()).toEqual(["read", "write", "bash", "edit"]);
    expect(lastPlan(api.session)!.status).toBe("executing");
    expect(planBlocksModeSwitch("s1", "agent")).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "plan-execute", content: expect.stringContaining(`2. ${LONG_STEP}`) }),
      { triggerTurn: true },
    );
    // 开跑那一轮不重复注入剩余步骤，之后每轮注入
    expect(await api.handlers.before_agent_start?.({})).toBeUndefined();
    expect(await api.handlers.before_agent_start?.({})).toMatchObject({ message: { customType: "plan-execution-context" } });

    const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    await api.handlers.turn_end?.({ message: assistant("第一步好了 [DONE:1]") }, api.session);
    expect(lastPlan(api.session)!.steps.map((s) => s.done)).toEqual([true, false]);
    await api.handlers.turn_end?.({ message: assistant("[DONE:2]") }, api.session);
    await api.handlers.agent_end?.({ messages: [] }, api.session);
    expect(lastPlan(api.session)!.status).toBe("done");
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "plan-complete" }), { triggerTurn: false });
  });

  it("confirm is refused when not ready, rev is stale, or the session is busy", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: [] });
    const id = lastPlan(api.session)!.id;
    await api.commands["plan-confirm"](`${id} 1`, api.session);
    expect(lastPlan(api.session)!.status).toBe("drafting");
    await upsert(api, { title: "t", goal: "", steps: ["a"] });
    await api.commands["plan-confirm"](`${id} 1`, api.session);
    expect(lastPlan(api.session)!.status).toBe("ready");
    const busy = { ...api.session, isIdle: () => false };
    await api.commands["plan-confirm"](`${id} 2`, busy);
    expect(lastPlan(api.session)!.status).toBe("ready");
    expect(getAgentMode(cwd, "s1")).toBe("plan");
  });

  it("cancel frees the manual switch", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: ["a"] });
    await api.commands["plan-cancel"](lastPlan(api.session)!.id, api.session);
    expect(lastPlan(api.session)!.status).toBe("cancelled");
    expect(planBlocksModeSwitch("s1", "agent")).toBe(false);
  });

  it("a planning turn that ends without upsert_plan reports an explicit failure", async () => {
    const api = await startInPlan();
    await api.handlers.before_agent_start?.({});
    await api.handlers.agent_end?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. 做点事情" }], stopReason: "stop" }] }, api.session);
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "agent-plan-missing" }), { triggerTurn: false });
    expect(lastPlan(api.session)).toBeNull();
  });

  it("restores the plan from the session entry and ignores old card data", async () => {
    const api = await startInPlan();
    await upsert(api, { title: "t", goal: "", steps: ["a"] });
    const entry = api.appendEntry.mock.calls.at(-1)!;
    __resetPlanStateForTest();

    const again = load();
    const session = ctx([{ type: "custom", customType: entry[0], data: entry[1] }]);
    await again.handlers.session_start?.({}, session);
    expect(lastPlan(session)).toMatchObject({ title: "t", status: "ready" });
    expect(planBlocksModeSwitch("s1", "agent")).toBe(true);

    const old = load();
    const oldSession = ctx([{ type: "custom", customType: "agent-mode", data: { mode: "plan", todos: [{ step: 1, text: "x", completed: false }], executing: true } }]);
    __resetPlanStateForTest();
    await old.handlers.session_start?.({}, oldSession);
    expect(lastPlan(oldSession)).toBeNull();
  });
});
