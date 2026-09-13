import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  open: vi.fn(),
  createAgentSessionServices: vi.fn(async () => ({ modelRuntime: { id: "runtime" } })),
  createAgentSessionFromServices: vi.fn(),
  getAgentDir: vi.fn(() => "/agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    open: (...args: unknown[]) => sdk.open(...args),
  },
  createAgentSessionServices: (...args: unknown[]) => sdk.createAgentSessionServices(...args),
  createAgentSessionFromServices: (...args: unknown[]) => sdk.createAgentSessionFromServices(...args),
  getAgentDir: () => sdk.getAgentDir(),
}));

import { SubagentError } from "./inbox.js";
import { registerParentSessionHost, __resetParentHostsForTest } from "./parent-host.js";
import {
  ChildLock,
  authorizeParent,
  coldResumeAndDeliver,
  deliverToChild,
  disposeActivation,
  getActivation,
  installActivation,
  interruptChild,
  markAnnounced,
  __resetActivationsForTest,
} from "./activation.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockSession() {
  let idle = deferred();
  const state = { isStreaming: false, isCompacting: false };
  return {
    get isStreaming() {
      return state.isStreaming;
    },
    set isStreaming(value: boolean) {
      state.isStreaming = value;
    },
    get isIdle() {
      return !state.isStreaming && !state.isCompacting;
    },
    pendingMessageCount: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "child done" }] }],
    prompt: vi.fn(async () => {
      state.isStreaming = true;
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    waitForIdle: () => {
      if (!state.isStreaming && !state.isCompacting) return Promise.resolve();
      return idle.promise;
    },
    resolveIdle: () => {
      state.isStreaming = false;
      idle.resolve();
      idle = deferred();
    },
  };
}

function registerHost(over: {
  sessionPath?: string;
  workspace?: string;
  sendMessage?: ReturnType<typeof vi.fn>;
} = {}) {
  const sendMessage = over.sendMessage ?? vi.fn();
  registerParentSessionHost({
    sessionId: "p1",
    sessionPath: over.sessionPath ?? "/ws/parent.jsonl",
    workspace: over.workspace ?? "A",
    isBusy: () => false,
    isDraining: () => false,
    sendMessage,
    prompt: vi.fn(),
  });
  return sendMessage;
}

function install(session: ReturnType<typeof mockSession>, over: { announced?: boolean; workspace?: string; childId?: string } = {}) {
  return installActivation({
    childId: over.childId ?? "sa-1",
    sessionPath: "/ws/child.jsonl",
    parentSessionId: "p1",
    parentSessionPath: "/ws/parent.jsonl",
    workspace: over.workspace ?? "A",
    session,
    announced: over.announced,
  });
}

describe("activation", () => {
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
  });

  it("ChildLock serializes run on the same childId", async () => {
    const lock = new ChildLock();
    const first = deferred();
    const order: string[] = [];
    const p1 = lock.run("sa-1", async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
      return 1;
    });
    let secondStarted = false;
    const p2 = lock.run("sa-1", async () => {
      secondStarted = true;
      order.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    first.resolve();
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("failed ChildLock section does not reject a later unrelated run", async () => {
    const lock = new ChildLock();
    const first = deferred();
    const p1 = lock.run("sa-1", async () => {
      await first.promise;
      throw new Error("section failed");
    });
    const p2 = lock.run("sa-1", async () => "ok");
    first.resolve();
    await expect(p1).rejects.toThrow("section failed");
    await expect(p2).resolves.toBe("ok");
  });

  it("deliverToChild after disposeActivation or inbox.close does not prompt", async () => {
    const session = mockSession();
    const act = install(session);
    await act.inbox.close(async () => {});
    try {
      deliverToChild("sa-1", "hi", "followUp");
      expect.unreachable("deliverToChild should throw after inbox.close");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).toBe("ACTIVATION_CLOSING");
    }
    expect(session.prompt).not.toHaveBeenCalled();

    const session2 = mockSession();
    install(session2, { childId: "sa-2" });
    await disposeActivation("sa-2", "rollback");
    try {
      deliverToChild("sa-2", "hi", "followUp");
      expect.unreachable("deliverToChild should throw after dispose");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).not.toBe("NOT_RESUMABLE");
    }
    expect(session2.prompt).not.toHaveBeenCalled();
  });

  it("idle with pendingMessageCount 0 sends settlement once and disposes", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("deliver during first idle cancels that settlement until the next idle", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    session.isStreaming = true;
    install(session, { announced: true });
    session.resolveIdle();
    deliverToChild("sa-1", "more work", "followUp");
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(sendMessage).toHaveBeenCalledTimes(0);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(getActivation("sa-1")).toBeDefined();
    session.resolveIdle();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposeActivation when unannounced does not send settlement", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: false });
    await disposeActivation("sa-1", "cancel");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("announced completed settlement includes childId and subagent-settled", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-settled");
    expect(msg.details.childId).toBe("sa-1");
    expect(msg.details.stopReason).toBe("completed");
  });

  it("does not deliver settlement across workspaces and authorizeParent throws PARENT_UNAVAILABLE", async () => {
    const session = mockSession();
    const sendMessage = registerHost({ workspace: "B" });
    const act = install(session, { announced: true, workspace: "A" });
    await vi.waitFor(() => {
      expect(session.dispose).toHaveBeenCalledTimes(1);
    });
    expect(sendMessage).not.toHaveBeenCalled();
    try {
      authorizeParent(act, "B");
      expect.unreachable("authorizeParent should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).toBe("PARENT_UNAVAILABLE");
      expect((error as SubagentError).message.toLowerCase()).toMatch(/parent|unavailable|workspace/);
    }
  });

  it("interruptChild aborts without closing inbox or sending notice", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    session.isStreaming = true;
    const act = install(session, { announced: true });
    interruptChild("sa-1");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(act.inbox.closing).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    interruptChild("missing");
  });

  it("steer while busy settles on the current turn idle without hanging", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    session.isStreaming = true;
    install(session, { announced: true });
    deliverToChild("sa-1", "steer now", "steer");
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(sendMessage).toHaveBeenCalledTimes(0);
    session.resolveIdle();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("interrupt idle does not naturally settle until a later deliver", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    session.isStreaming = true;
    const act = install(session, { announced: true });
    interruptChild("sa-1");
    session.resolveIdle();
    await vi.waitFor(() => {
      expect(session.abort).toHaveBeenCalled();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getActivation("sa-1")).toBeDefined();
    expect(sendMessage).toHaveBeenCalledTimes(0);
    expect(act.inbox.closing).toBeUndefined();
    expect(session.dispose).not.toHaveBeenCalled();
    deliverToChild("sa-1", "continue", "followUp");
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(sendMessage).toHaveBeenCalledTimes(0);
    expect(getActivation("sa-1")).toBeDefined();
    session.resolveIdle();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("markAnnounced starts settlement watch", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    const act = install(session);
    expect(act.announced).toBe(false);
    markAnnounced("sa-1");
    expect(getActivation("sa-1")?.announced).toBe(true);
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("coldResumeAndDeliver", () => {
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
  });

  function metaEntries(...data: Array<Record<string, unknown>>) {
    return data.map((item) => ({ type: "custom", customType: "subagent_meta", data: item }));
  }

  async function expectNotResumable(entries: unknown[]) {
    sdk.open.mockReturnValue({
      getEntries: () => entries,
      cwd: "/ws",
    });
    try {
      await coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "hi", "followUp");
      expect.unreachable("coldResumeAndDeliver should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentError);
      expect((error as SubagentError).code).toBe("NOT_RESUMABLE");
    }
    expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
  }

  it("throws NOT_RESUMABLE when there is no subagent_meta", async () => {
    await expectNotResumable([{ type: "message", role: "assistant" }]);
  });

  it("throws NOT_RESUMABLE when mode is not continuable", async () => {
    await expectNotResumable(metaEntries({ mode: "one-shot", tornDown: false }));
  });

  it("throws NOT_RESUMABLE when tornDown is true", async () => {
    await expectNotResumable(metaEntries({ mode: "continuable", tornDown: true }));
  });

  it("opens session, rebuilds services, binds extensions, then delivers", async () => {
    const session = mockSession();
    const bindExtensions = vi.fn(async () => {});
    Object.assign(session, { bindExtensions });
    sdk.open.mockReturnValue({
      getEntries: () =>
        metaEntries(
          { mode: "one-shot" },
          {
            mode: "continuable",
            tornDown: false,
            parentSessionId: "p1",
            parentSessionPath: "/ws/parent.jsonl",
            workspace: "A",
          },
        ),
      cwd: "/ws",
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({ session });

    const sendMessage = registerHost();
    await coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "continue please", "followUp");

    expect(sdk.open).toHaveBeenCalledWith("/ws/child.jsonl");
    expect(sdk.createAgentSessionServices).toHaveBeenCalled();
    expect(sdk.createAgentSessionFromServices).toHaveBeenCalled();
    expect(sdk.createAgentSessionServices.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.createAgentSessionFromServices.mock.invocationCallOrder[0],
    );
    expect(bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "rpc",
        shutdownHandler: expect.any(Function),
        commandContextActions: expect.objectContaining({
          waitForIdle: expect.any(Function),
        }),
      }),
    );
    expect(session.prompt).toHaveBeenCalled();
    expect(getActivation("sa-1")?.announced).toBe(true);
    expect(getActivation("sa-1")).toBeDefined();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  it("does not settle immediately after cold resume", async () => {
    const session = mockSession();
    Object.assign(session, { bindExtensions: vi.fn(async () => {}) });
    sdk.open.mockReturnValue({
      getEntries: () =>
        metaEntries({
          mode: "continuable",
          tornDown: false,
          parentSessionId: "p1",
          parentSessionPath: "/ws/parent.jsonl",
          workspace: "A",
        }),
      cwd: "/ws",
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({ session });
    const sendMessage = registerHost();
    await coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "continue please", "followUp");
    await Promise.resolve();
    await Promise.resolve();
    expect(getActivation("sa-1")).toBeDefined();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });
});
