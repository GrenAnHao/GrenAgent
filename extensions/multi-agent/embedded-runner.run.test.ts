import { beforeEach, describe, expect, it, vi } from "vitest";

const appendCustomEntry = vi.fn();
const appendModelChange = vi.fn();
const createAgentSessionFromServices = vi.fn();
const resolveCliModel = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionServices: vi.fn(async () => ({ modelRuntime: { id: "runtime" } })),
  createAgentSessionFromServices: (...args: unknown[]) => createAgentSessionFromServices(...args),
  resolveCliModel: (...args: unknown[]) => resolveCliModel(...args),
  SessionManager: {
    create: () => ({
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
  behavior?: { prompt?: ReturnType<typeof vi.fn> },
) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" }],
    sessionId: "sa-child",
    model,
    isStreaming: false,
    pendingMessageCount: 0,
    prompt:
      behavior?.prompt ??
      vi.fn(async (_task: string, opts?: { preflightResult?: (ok: boolean) => void }) => {
        opts?.preflightResult?.(true);
      }),
    waitForIdle: vi.fn(async () => {}),
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
    expect(excludeTools).toEqual(expect.arrayContaining(["spawn_agent", "explore_context", "bash"]));
    expect(excludeTools).not.toContain("send_message");
    expect(session.dispose).toHaveBeenCalled();
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
    expect(excludeTools).toEqual(expect.arrayContaining(["spawn_agent", "explore_context"]));
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
    expect(session.prompt).toHaveBeenCalledWith(
      `do work\n\n${continuableReturnGuidance("p1")}`,
      expect.objectContaining({ source: "rpc" }),
    );
    expect(appendCustomEntry).toHaveBeenCalledWith(
      "subagent_meta",
      expect.objectContaining({ mode: "continuable", parentSessionId: "p1" }),
    );
    announce.mockRestore();
    install.mockRestore();
    __resetActivationsForTest();
  });
});
