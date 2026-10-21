import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendMessage = vi.fn();
const appendCustomEntry = vi.fn();
const appendModelChange = vi.fn();
const sessionCreate = vi.fn((..._args: unknown[]) => undefined);
const createAgentSessionFromServices = vi.fn();
const createAgentSessionServicesMock = vi.fn(async () => ({ modelRuntime: { id: "runtime" } }));
const resolveCliModel = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionServices: (...args: unknown[]) => createAgentSessionServicesMock(...args),
  createAgentSessionFromServices: (...args: unknown[]) => createAgentSessionFromServices(...args),
  resolveCliModel: (...args: unknown[]) => resolveCliModel(...args),
  SessionManager: {
    create: (...args: unknown[]) => (sessionCreate(...args), {
      appendMessage,
      appendCustomEntry,
      appendModelChange,
      getSessionFile: () => "/ws/.pi/sessions/sa-child.jsonl",
    }),
  },
  getAgentDir: () => "/agent",
}));

vi.mock("../_shared/workspace-context.js", () => ({
  currentWorkspaceContext: () => ({ workspace: "/ws", cwd: "/ws", config: {} }),
  runInWorkspace: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (key: string) => (key === "PI_SYSTEM_WORKER" ? "1" : undefined),
  withoutSensitiveProcessConfig: (x: Record<string, string>) => x,
}));

vi.mock("./runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner.js")>();
  return {
    ...actual,
    buildSubagentRuntimeConfig: () => ({ path: undefined, env: { SAFETY_DENY_TOOLS: "bash" }, cleanup: () => {} }),
  };
});

import { continuableReturnGuidance } from "./adjacent-tools.js";
import { getActivation, __resetActivationsForTest } from "./activation.js";
import * as activation from "./activation.js";
import * as parentHost from "./parent-host.js";
import { createEmbeddedChildSession, runEmbeddedSubagent, startContinuableEmbedded } from "./embedded-runner.js";
import { reportLeakedError } from "../_shared/leak-owner.js";
import { __resetApprovalRoutesForTest, canRequestApproval, registerTopApprovalRoute, requestApproval } from "../_shared/approval-route.js";

function fakeSession(
  model: { provider: string; id: string },
  behavior?: { prompt?: ReturnType<typeof vi.fn>; waitForIdle?: ReturnType<typeof vi.fn> },
) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" }],
    sessionId: "sa-child",
    model,
    isStreaming: false,
    pendingMessageCount: 0,
    prompt:
      behavior?.prompt ??
      vi.fn(async (_task: string, opts?: { preflightResult?: (disposition: unknown) => void }) => {
        opts?.preflightResult?.("started");
      }),
    waitForIdle: behavior?.waitForIdle ?? vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

describe("runEmbeddedSubagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  it("inherits provider/id into the child session and writes model_change", async () => {
    const session = fakeSession({ provider: "custom-mtwuh2s5", id: "deepseek-flash" });
    createAgentSessionFromServices.mockImplementation(async (opts: { model?: { provider: string; id: string } }) => {
      if (opts.model) session.model = opts.model;
      return { session };
    });

    const updates: Array<{ sessionPath?: string }> = [];
    const r = await runEmbeddedSubagent({
      cwd: "/ws",
      task: "do work",
      agentId: "sa-child",
      parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
      model: "custom-mtwuh2s5/deepseek-flash",
      onUpdate: (u) => updates.push(u),
    });

    expect(r.ok).toBe(true);
    expect(r.output).toBe("child answer");
    expect(r.sessionPath).toBe("/ws/.pi/sessions/sa-child.jsonl");
    expect(r.stopReason).toBe("completed");
    expect(createAgentSessionFromServices.mock.calls[0][0].model).toEqual({
      provider: "custom-mtwuh2s5",
      id: "deepseek-flash",
    });
    expect(appendModelChange).toHaveBeenCalledWith("custom-mtwuh2s5", "deepseek-flash");
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "subagent_meta",
      expect.objectContaining({
        origin: "subagent",
        parentSession: "/ws/.pi/sessions/parent.jsonl",
        model: "custom-mtwuh2s5/deepseek-flash",
      }),
    );
    expect(updates[0]?.sessionPath).toBe("/ws/.pi/sessions/sa-child.jsonl");
    const excludeTools = createAgentSessionFromServices.mock.calls[0][0].excludeTools as string[];
    expect(excludeTools).toEqual(expect.arrayContaining(["explore_context", "bash"]));
    expect(excludeTools).not.toContain("spawn_agent");
    expect(excludeTools).not.toContain("send_message");
    expect(session.dispose).toHaveBeenCalled();
  });

  it("parent moved into a worktree: child header stays on the original directory, tools use the current one, the move is recorded", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws/.agents/worktrees/x", projectCwd: "/ws", task: "t", agentId: "sa-wt" });
    expect(sessionCreate.mock.calls[0]?.[0]).toBe("/ws");
    expect((createAgentSessionServicesMock.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({ cwd: "/ws/.agents/worktrees/x" });
    expect(appendCustomEntry).toHaveBeenCalledWith("working_directory", { cwd: "/ws/.agents/worktrees/x" });
  });

  it("without a move the child header uses cwd and no working_directory entry is written", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", projectCwd: "/ws", task: "t", agentId: "sa-same" });
    expect(sessionCreate.mock.calls[0]?.[0]).toBe("/ws");
    expect(appendCustomEntry.mock.calls.some((c) => c[0] === "working_directory")).toBe(false);
  });

  it("passes thinkingLevel into createAgentSessionFromServices and records it in subagent_meta", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-x", thinkingLevel: "medium" });
    const arg = createAgentSessionFromServices.mock.calls[0]?.[0] as { thinkingLevel?: string; excludeTools?: string[] };
    expect(arg.thinkingLevel).toBe("medium");
    expect(arg.excludeTools).toContain("list_subagent_models");
    const meta = appendCustomEntry.mock.calls.find((c) => c[0] === "subagent_meta")?.[1] as { thinkingLevel?: string };
    expect(meta.thinkingLevel).toBe("medium");
  });

  it("does not idle-kill while a tool runs, keeps heartbeating, and resumes idle timing after it ends", async () => {
    vi.useFakeTimers();
    try {
      const listeners: Array<(e: unknown) => void> = [];
      let finish!: () => void;
      const session = fakeSession(
        { provider: "a", id: "b" },
        { waitForIdle: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) },
      );
      session.subscribe = vi.fn((fn: (e: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      }) as never;
      createAgentSessionFromServices.mockResolvedValueOnce({ session });
      const updates: unknown[] = [];
      const run = runEmbeddedSubagent({
        cwd: "/ws",
        task: "t",
        agentId: "sa-tool",
        timeoutMs: 30_000,
        onUpdate: (u) => updates.push(u),
      });
      for (let i = 0; i < 50 && listeners.length < 2; i++) await vi.advanceTimersByTimeAsync(1);
      expect(listeners.length).toBeGreaterThanOrEqual(2);
      const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
      await vi.advanceTimersByTimeAsync(1_000);
      const before = updates.length;
      // 工具安静跑 130 秒：远超空闲窗口 30 秒，不能被杀；期间每 60 秒吐一次进度。
      await vi.advanceTimersByTimeAsync(130_000);
      expect(session.abort).not.toHaveBeenCalled();
      expect(updates.length - before).toBeGreaterThanOrEqual(2);

      emit({ type: "tool_execution_end", toolCallId: "c1" });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(session.abort).toHaveBeenCalled();
      finish();
      const r = await run;
      expect(r.ok).toBe(false);
      expect(r.error).toBe("idle timeout: no activity for 30s");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("upstream stall watchdog", () => {
    function stallHarness() {
      const listeners: Array<(e: unknown) => void> = [];
      const emit = (e: unknown) => listeners.forEach((fn) => fn(e));
      let idleResolve: (() => void) | undefined;
      const prompts: string[] = [];
      const session = fakeSession(
        { provider: "a", id: "b" },
        { waitForIdle: vi.fn(() => new Promise<void>((resolve) => { idleResolve = resolve; })) },
      );
      const messages: Array<Record<string, unknown>> = [];
      session.messages = messages as never;
      session.subscribe = vi.fn((fn: (e: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      }) as never;
      session.prompt = vi.fn(async (text: string, o?: { preflightResult?: (d: unknown) => void }) => {
        prompts.push(text);
        o?.preflightResult?.("started");
      }) as never;
      // 中断在途请求：和 pi 一样留下一条 aborted 的 assistant，然后回到空闲。
      session.abort = vi.fn(async () => {
        messages.push({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" });
        emit({ type: "message_end", message: { role: "assistant" } });
        emit({ type: "agent_end" });
        idleResolve?.();
      }) as never;
      const streamThenGoQuiet = async () => {
        emit({ type: "turn_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想…" } });
        await vi.advanceTimersByTimeAsync(125_000);
      };
      const ready = async () => {
        for (let i = 0; i < 50 && listeners.length < 2; i++) await vi.advanceTimersByTimeAsync(1);
      };
      return { session, messages, prompts, emit, ready, streamThenGoQuiet, finishRun: () => idleResolve?.() };
    }

    it("cuts a request that stops streaming and continues the child instead of killing it", async () => {
      vi.useFakeTimers();
      try {
        const h = stallHarness();
        createAgentSessionFromServices.mockResolvedValueOnce({ session: h.session });
        const run = runEmbeddedSubagent({ cwd: "/ws", task: "做事", agentId: "sa-stall", timeoutMs: 300_000 });
        await h.ready();

        await h.streamThenGoQuiet();
        expect(h.session.abort).toHaveBeenCalledTimes(1);
        expect(h.prompts).toHaveLength(2);
        expect(h.prompts[1]).toContain("自动续跑");

        h.messages.push({ role: "assistant", content: [{ type: "text", text: "做完了" }], stopReason: "stop" });
        h.finishRun();
        const r = await run;
        expect(r.ok).toBe(true);
        expect(r.output).toBe("做完了");
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up as an idle timeout after the retry budget", async () => {
      vi.useFakeTimers();
      try {
        const h = stallHarness();
        createAgentSessionFromServices.mockResolvedValueOnce({ session: h.session });
        const run = runEmbeddedSubagent({ cwd: "/ws", task: "做事", agentId: "sa-stall2", timeoutMs: 300_000 });
        await h.ready();

        await h.streamThenGoQuiet();
        await h.streamThenGoQuiet();
        expect(h.prompts).toHaveLength(3);
        await h.streamThenGoQuiet();
        const r = await run;
        expect(h.prompts).toHaveLength(3);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^idle timeout: upstream sent nothing for 12\ds \(after 2 automatic retries\)$/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("reports why the child stopped instead of a bare (no output)", async () => {
    const blocked = fakeSession({ provider: "a", id: "b" });
    blocked.messages = [
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" },
      { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "只读模式：禁止会改动文件系统的命令" }] },
    ] as never;
    createAgentSessionFromServices.mockResolvedValueOnce({ session: blocked });
    const r1 = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-blocked" });
    expect(r1.ok).toBe(false);
    expect(r1.exitCode).toBe(1);
    expect(r1.error).toBe("stopped after bash without a final reply: 只读模式：禁止会改动文件系统的命令");

    const failed = fakeSession({ provider: "a", id: "b" });
    failed.messages = [
      { role: "assistant", content: [{ type: "text", text: "先看入口" }], stopReason: "toolUse" },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "..." }] },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "upstream stream disconnected: unexpected EOF" },
    ] as never;
    createAgentSessionFromServices.mockResolvedValueOnce({ session: failed });
    const r2 = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-failed" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("model error: upstream stream disconnected: unexpected EOF");
    expect(r2.partial).toBe(true);
  });

  it("an error leaked inside one run (found by its async context) ends that run as an error; a run beside it is unaffected", async () => {
    const leaking = fakeSession({ provider: "a", id: "b" });
    let leakIdle!: () => void;
    leaking.waitForIdle = vi.fn(() => new Promise<void>((resolve) => { leakIdle = resolve; }));
    leaking.prompt = vi.fn(async (_t: string, o?: { preflightResult?: (d: unknown) => void }) => {
      o?.preflightResult?.("started");
      // 不被 await 的工作里出错：没有显式的子代理 id，靠这次运行的异步上下文归属。
      setTimeout(() => reportLeakedError(new Error("boom")), 5);
    }) as never;
    leaking.abort = vi.fn(async () => {
      leaking.messages = [{ role: "assistant", content: [{ type: "text", text: "半截" }], stopReason: "aborted" }] as never;
      leakIdle?.();
    });
    const fine = fakeSession({ provider: "a", id: "b" });
    fine.waitForIdle = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));
    createAgentSessionFromServices.mockImplementation(async () => {
      const next = createAgentSessionFromServices.mock.calls.length === 1 ? leaking : fine;
      return { session: next };
    });

    const [bad, good] = await Promise.all([
      runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-leak" }),
      new Promise((resolve) => setTimeout(resolve, 1)).then(() => runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-fine" })),
    ]);
    expect(bad).toMatchObject({ ok: false, stopReason: "error", error: "uncaught error: boom", exitCode: 1, output: "半截", partial: true });
    expect(good).toMatchObject({ ok: true, output: "child answer", stopReason: "completed" });
    // 结束后这个子代理不再登记：之后的漏网错误只记日志。
    expect(reportLeakedError(new Error("late"), "sa-leak")).toEqual({ childId: "sa-leak", handled: false });
  });

  it("an error leaked while the child session is being created ends the run without starting it", async () => {
    const session = fakeSession({ provider: "a", id: "b" });
    createAgentSessionFromServices.mockImplementationOnce(async () => {
      // 扩展初始化时漏出来的：这时还没有会话，靠这次运行的异步上下文归属。
      reportLeakedError(new Error("init boom"));
      return { session };
    });
    const r = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-init" });
    expect(r).toMatchObject({ ok: false, stopReason: "error", error: "uncaught error: init boom" });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(reportLeakedError(new Error("late"), "sa-init")).toEqual({ childId: "sa-init", handled: false });
  });

  it("an error during prompt preflight aborts the run again once it has started", async () => {
    const session = fakeSession({ provider: "a", id: "b" });
    let abortsBeforeWaiting = -1;
    session.prompt = vi.fn(async (_t: string, o?: { preflightResult?: (d: unknown) => void }) => {
      reportLeakedError(new Error("preflight boom"));
      o?.preflightResult?.("started");
    }) as never;
    session.waitForIdle = vi.fn(async () => {
      abortsBeforeWaiting = session.abort.mock.calls.length;
    });
    createAgentSessionFromServices.mockResolvedValueOnce({ session });
    const r = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-preflight" });
    // 一次在 preflight 里（会被起跑重置），一次在起跑之后。
    expect(abortsBeforeWaiting).toBe(2);
    expect(r).toMatchObject({ ok: false, stopReason: "error", error: "uncaught error: preflight boom" });
  });

  it("a throwing dispose does not replace the child's result; the failed step is logged", async () => {
    const session = fakeSession({ provider: "a", id: "b" });
    session.dispose = vi.fn(() => {
      throw new Error("dispose exploded");
    });
    createAgentSessionFromServices.mockResolvedValueOnce({ session });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-dispose" });
      expect(r).toMatchObject({ ok: true, output: "child answer" });
      expect(log).toHaveBeenCalledWith("[multi-agent] sub-agent sa-dispose teardown failed: dispose session: dispose exploded");
    } finally {
      log.mockRestore();
    }
  });

  it("a throwing progress callback neither escapes the child's session listeners nor changes the result", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const session = fakeSession({ provider: "a", id: "b" });
    session.subscribe = vi.fn((fn: (event: unknown) => void) => {
      listeners.push(fn);
      return () => {};
    }) as never;
    const escaped: unknown[] = [];
    session.prompt = vi.fn(async (_t: string, o?: { preflightResult?: (d: unknown) => void }) => {
      o?.preflightResult?.("started");
      // SDK 同步调用监听方：这里抛出去就会让子代理这次工具调用 / 这一轮失败。
      for (const listener of listeners) {
        for (const event of [{ type: "turn_start" }, { type: "tool_execution_update", toolCallId: "c1" }]) {
          try {
            listener(event);
          } catch (error) {
            escaped.push(error);
          }
        }
      }
    }) as never;
    createAgentSessionFromServices.mockResolvedValueOnce({ session });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runEmbeddedSubagent({
        cwd: "/ws",
        task: "t",
        agentId: "sa-progress",
        onUpdate: () => {
          throw new Error("registry write failed");
        },
      });
      expect(escaped).toEqual([]);
      expect(r).toMatchObject({ ok: true, output: "child answer" });
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines[0]).toBe("[session-listener] sub-agent sa-progress progress failed; swallowed so the session keeps going");
      expect(lines.filter((line) => line.includes("sub-agent sa-progress progress failed"))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("omits thinkingLevel when not given", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-y" });
    const arg = createAgentSessionFromServices.mock.calls[0]?.[0] as { thinkingLevel?: string };
    expect(arg).not.toHaveProperty("thinkingLevel");
  });

  it("excludes spawn_agent only when depth reaches the max; records depth in meta", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-d1", depth: 1, env: { SUBAGENT_DEPTH: "1" } });
    const a1 = createAgentSessionFromServices.mock.calls[0]?.[0] as { excludeTools: string[] };
    expect(a1.excludeTools).not.toContain("spawn_agent");
    expect(a1.excludeTools).toContain("explore_context");
    const meta = appendCustomEntry.mock.calls.find((c) => c[0] === "subagent_meta")?.[1] as { depth?: number };
    expect(meta.depth).toBe(1);

    createAgentSessionFromServices.mockClear();
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-d2", depth: 2, env: { SUBAGENT_DEPTH: "2" } });
    const a2 = createAgentSessionFromServices.mock.calls[0]?.[0] as { excludeTools: string[] };
    expect(a2.excludeTools).toContain("spawn_agent");
  });
});

describe("createEmbeddedChildSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  it("does not dispose the child session", async () => {
    const session = fakeSession({ provider: "custom-mtwuh2s5", id: "deepseek-flash" });
    createAgentSessionFromServices.mockResolvedValue({ session });

    const child = await createEmbeddedChildSession({
      cwd: "/ws",
      task: "do work",
      agentId: "sa-child",
      parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
      parentSessionId: "p1",
      model: "custom-mtwuh2s5/deepseek-flash",
    });

    expect(child.session).toBe(session);
    expect(child.sessionPath).toBe("/ws/.pi/sessions/sa-child.jsonl");
    expect(child.workspace).toBe("/ws");
    expect(typeof child.unsub).toBe("function");
    expect(session.dispose).not.toHaveBeenCalled();
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "subagent_meta",
      expect.objectContaining({
        origin: "subagent",
        parentSession: "/ws/.pi/sessions/parent.jsonl",
        parentSessionId: "p1",
        mode: "one-shot",
        inheritedEventCount: 0,
      }),
    );
    const excludeTools = createAgentSessionFromServices.mock.calls[0][0].excludeTools as string[];
    expect(excludeTools).toEqual(expect.arrayContaining(["explore_context"]));
    expect(excludeTools).not.toContain("spawn_agent");
    expect(excludeTools).not.toContain("send_message");
  });
});

describe("createEmbeddedChildSession · approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    __resetApprovalRoutesForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  it("the child's approvals go to its parent session until it is unsubscribed", async () => {
    const select = vi.fn<(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>>(async () => "拒绝");
    registerTopApprovalRoute("/ws/.pi/sessions/parent.jsonl", { select });
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "p", id: "m" }) });
    const child = await createEmbeddedChildSession({
      cwd: "/ws",
      task: "check the build\nthen report",
      agentId: "sa-child",
      parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
      model: "p/m",
    });

    expect(await canRequestApproval(child.sessionPath)).toBe(true);
    await requestApproval(child.sessionPath, { title: "x", options: ["拒绝"] });
    expect(select.mock.calls[0]?.[0]).toBe("子代理 check the build（sa-child） x");
    child.unsub();
    expect(await canRequestApproval(child.sessionPath)).toBe(false);
    __resetApprovalRoutesForTest();
  });
});

describe("startContinuableEmbedded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  it("rolls back Activation when prompt rejects, with no notice", async () => {
    const session = fakeSession(
      { provider: "custom-mtwuh2s5", id: "deepseek-flash" },
      { prompt: vi.fn(async () => { throw new Error("prompt failed"); }) },
    );
    createAgentSessionFromServices.mockResolvedValue({ session });
    const send = vi.spyOn(parentHost, "sendSettlementToParent");

    await expect(
      startContinuableEmbedded({
        cwd: "/ws",
        task: "do work",
        agentId: "sa-child",
        parentSessionId: "p1",
        parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
      }),
    ).rejects.toThrow("prompt failed");

    expect(getActivation("sa-child")).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("installs Activation and markAnnounced after prompt preflight ok", async () => {
    const session = fakeSession({ provider: "custom-mtwuh2s5", id: "deepseek-flash" });
    createAgentSessionFromServices.mockResolvedValue({ session });
    const install = vi.spyOn(activation, "installActivation");
    const announce = vi.spyOn(activation, "markAnnounced");
    const send = vi.spyOn(parentHost, "sendSettlementToParent");

    const started = await startContinuableEmbedded({
      cwd: "/ws",
      task: "do work",
      agentId: "sa-child",
      parentSessionId: "p1",
      parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
      mode: "continuable",
    });

    expect(started).toEqual({ agentId: "sa-child", sessionPath: "/ws/.pi/sessions/sa-child.jsonl" });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        childId: "sa-child",
        sessionPath: "/ws/.pi/sessions/sa-child.jsonl",
        parentSessionId: "p1",
        parentSessionPath: "/ws/.pi/sessions/parent.jsonl",
        announced: false,
      }),
    );
    expect(announce).toHaveBeenCalledWith("sa-child");
    expect(getActivation("sa-child")).toBeDefined();
    expect(send).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith(
      `do work\n\n${continuableReturnGuidance("p1")}`,
      expect.objectContaining({ source: "rpc" }),
    );
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "subagent_meta",
      expect.objectContaining({ mode: "continuable", parentSessionId: "p1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getActivation("sa-child")).toBeDefined();
    expect(send).not.toHaveBeenCalled();
    announce.mockRestore();
    install.mockRestore();
    send.mockRestore();
    __resetActivationsForTest();
  });
});

describe("fork seed write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  it("writes seed then catalog_base then one meta", async () => {
    const seed = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "parent said" }] },
    ];
    const session = fakeSession({ provider: "p", id: "m" });
    session.messages = [
      ...seed,
      { role: "assistant", content: [{ type: "text", text: "child said" }], stopReason: "stop" },
    ];
    createAgentSessionFromServices.mockResolvedValue({ session });

    const r = await runEmbeddedSubagent({
      cwd: "/ws",
      task: "child task",
      agentId: "sa-child",
      seedMessages: seed,
    });

    expect(appendMessage.mock.calls.map((c) => c[0])).toEqual(seed);
    const types = appendCustomEntry.mock.calls.map((c) => c[0]);
    expect(types).toEqual(["subagent_catalog_base", "subagent_meta"]);
    expect(appendCustomEntry.mock.calls[0][1]).toEqual({ version: 0, reason: "subagent-seed" });
    expect(appendCustomEntry.mock.calls[1][1]).toEqual(
      expect.objectContaining({ inheritedEventCount: 2 }),
    );
    expect(r.output).toBe("child said");
  });

  it("does not treat seeded parent assistant as output", async () => {
    const seed = [{ role: "assistant", content: [{ type: "text", text: "parent said" }] }];
    const session = fakeSession({ provider: "p", id: "m" });
    session.messages = [...seed, { role: "user", content: "child task" }];
    createAgentSessionFromServices.mockResolvedValue({ session });

    const r = await runEmbeddedSubagent({
      cwd: "/ws",
      task: "child task",
      agentId: "sa-child",
      seedMessages: seed,
    });

    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).toBe("(no output)");
  });

  it("does not write catalog_base or meta when seed write fails", async () => {
    appendMessage.mockImplementation(() => {
      throw new Error("seed write failed");
    });
    await expect(
      createEmbeddedChildSession({
        cwd: "/ws",
        task: "child task",
        agentId: "sa-child",
        seedMessages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("seed write failed");
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });
});

describe("outputSchema", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

  beforeEach(() => {
    vi.clearAllMocks();
    appendMessage.mockReset();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  function captureFactories() {
    const factories: Array<(pi: unknown) => void> = [];
    let lastAppend: string[] = [];
    createAgentSessionServicesMock.mockImplementation(async (opts: { resourceLoaderOptions: { extensionFactories: Array<(pi: unknown) => void>; appendSystemPrompt?: string[] } }) => {
      factories.push(...opts.resourceLoaderOptions.extensionFactories);
      lastAppend = opts.resourceLoaderOptions.appendSystemPrompt ?? [];
      return { modelRuntime: { id: "runtime" } };
    });
    return { factories, getAppend: () => lastAppend };
  }

  it("keeps structured_output on a named-agent tools allowlist", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({
      cwd: "/ws",
      task: "t",
      agentId: "sa-tools",
      outputSchema: schema as never,
      tools: ["read"],
    });
    expect(createAgentSessionFromServices.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining(["read", "structured_output"]),
    );
  });

  it("hides extension tools via setActiveTools when the child has a named-agent allowlist", async () => {
    const session = fakeSession({ provider: "a", id: "b" });
    const setActiveTools = vi.fn();
    (session as unknown as { setActiveTools: ReturnType<typeof vi.fn> }).setActiveTools = setActiveTools;
    createAgentSessionFromServices.mockResolvedValue({ session });
    await runEmbeddedSubagent({
      cwd: "/ws",
      task: "t",
      agentId: "sa-allow",
      tools: ["read", "grep", "ask_user"],
    });
    expect(setActiveTools).toHaveBeenCalledWith(["read", "grep", "ask_user", "send_message"]);
  });

  it("keeps send_message (and structured_output) on any named-agent allowlist so the child can reach its parent", async () => {
    const session = fakeSession({ provider: "a", id: "b" });
    const setActiveTools = vi.fn();
    (session as unknown as { setActiveTools: ReturnType<typeof vi.fn> }).setActiveTools = setActiveTools;
    createAgentSessionFromServices.mockResolvedValue({ session });
    await runEmbeddedSubagent({
      cwd: "/ws",
      task: "t",
      agentId: "sa-scout",
      outputSchema: schema as never,
      tools: ["read", "grep", "find", "ls", "bash", "code_explore"],
    });
    expect(createAgentSessionFromServices.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining(["read", "send_message", "structured_output"]),
    );
    expect(setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["send_message", "structured_output"]));
  });

  it("does not restrict tools when the child has no allowlist", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-free" });
    expect(createAgentSessionFromServices.mock.calls[0][0].tools).toBeUndefined();
  });

  it("adds a per-child factory registering structured_output with the schema, and appends the instruction", async () => {
    const { factories, getAppend } = captureFactories();
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s1", outputSchema: schema as never, systemPrompt: "P" });
    const registered: Array<{ name: string; parameters: unknown }> = [];
    for (const f of factories) f({ registerTool: (t: { name: string; parameters: unknown }) => registered.push(t), on: () => {} });
    expect(registered.some((t) => t.name === "structured_output" && t.parameters === schema)).toBe(true);
    expect(getAppend()[0]).toMatch(/^P[\s\S]*structured_output/);
  });

  it("returns structured when the child called the tool; last call wins; omitted when not called", async () => {
    const { factories } = captureFactories();
    let releaseIdle!: () => void;
    const idle = new Promise<void>((r) => (releaseIdle = r));
    createAgentSessionFromServices.mockResolvedValue({
      session: fakeSession({ provider: "a", id: "b" }, { waitForIdle: vi.fn(() => idle) }),
    });
    const p = runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s2", outputSchema: schema as never });
    await vi.waitFor(() => expect(factories.length).toBeGreaterThan(0));
    let exec: ((id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    for (const f of factories) f({ registerTool: (t: { name: string; execute: typeof exec }) => { if (t.name === "structured_output") exec = t.execute; }, on: () => {} });
    expect(await exec!("c1", { answer: "one" })).toMatchObject({ content: [{ text: "结果已记录" }] });
    expect(await exec!("c2", { answer: "two" })).toMatchObject({ content: [{ text: "结果已替换先前记录" }] });
    releaseIdle();
    const r = await p;
    expect(r.structured).toEqual({ answer: "two" });

    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    const r2 = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s3", outputSchema: schema as never });
    expect(r2).not.toHaveProperty("structured");
    expect(r2.stopReason).toBe("completed");
  });
});

describe("idle timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetActivationsForTest();
    resolveCliModel.mockImplementation(({ cliModel }: { cliModel: string }) => {
      const [provider, id] = cliModel.split("/");
      return { model: { provider, id }, error: undefined };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function hangingSession() {
    const listeners: Array<(event: unknown) => void> = [];
    let release!: () => void;
    const idle = new Promise<void>((r) => (release = r));
    const session = fakeSession({ provider: "a", id: "b" }, { waitForIdle: vi.fn(() => idle) });
    session.subscribe = vi.fn((fn: (event: unknown) => void) => {
      listeners.push(fn);
      return () => {};
    }) as typeof session.subscribe;
    session.abort = vi.fn(async () => release());
    const emit = (type: string) => {
      for (const fn of listeners) fn({ type });
    };
    return { session, emit };
  }

  it("keeps a child that keeps producing events alive past the idle window", async () => {
    vi.useFakeTimers();
    const { session, emit } = hangingSession();
    createAgentSessionFromServices.mockResolvedValue({ session });
    const p = runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-busy", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    emit("message_update");
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(600);
      emit(i % 2 ? "message_update" : "tool_execution_update");
    }
    expect(session.abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1100);
    expect(session.abort).toHaveBeenCalled();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(-1);
    expect(r.error).toBe("idle timeout: no activity for 1s");
  });

  it("caps a child that never goes quiet at idle x10", async () => {
    vi.useFakeTimers();
    const { session, emit } = hangingSession();
    createAgentSessionFromServices.mockResolvedValue({ session });
    const p = runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-chatty", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 25 && !session.abort.mock.calls.length; i += 1) {
      emit("message_update");
      await vi.advanceTimersByTimeAsync(500);
    }
    const r = await p;
    expect(r.error).toBe("hard timeout after 10s");
  });
});
