import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendMessage = vi.fn();
const appendCustomEntry = vi.fn();
const appendModelChange = vi.fn();
const createAgentSessionFromServices = vi.fn();
const createAgentSessionServicesMock = vi.fn(async () => ({ modelRuntime: { id: "runtime" } }));
const resolveCliModel = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionServices: (...args: unknown[]) => createAgentSessionServicesMock(...args),
  createAgentSessionFromServices: (...args: unknown[]) => createAgentSessionFromServices(...args),
  resolveCliModel: (...args: unknown[]) => resolveCliModel(...args),
  SessionManager: {
    create: () => ({
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

  it("passes thinkingLevel into createAgentSessionFromServices and records it in subagent_meta", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-x", thinkingLevel: "medium" });
    const arg = createAgentSessionFromServices.mock.calls[0]?.[0] as { thinkingLevel?: string; excludeTools?: string[] };
    expect(arg.thinkingLevel).toBe("medium");
    expect(arg.excludeTools).toContain("list_subagent_models");
    const meta = appendCustomEntry.mock.calls.find((c) => c[0] === "subagent_meta")?.[1] as { thinkingLevel?: string };
    expect(meta.thinkingLevel).toBe("medium");
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
    expect(setActiveTools).toHaveBeenCalledWith(["read", "grep", "ask_user"]);
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
