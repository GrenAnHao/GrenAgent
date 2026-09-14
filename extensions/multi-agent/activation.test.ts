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
import {
  registerParentSessionHost,
  lookupParentHost as parentHostLookup,
  __resetParentHostsForTest,
} from "./parent-host.js";
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
    sendCustomMessage: vi.fn(),
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

function install(
  session: ReturnType<typeof mockSession>,
  over: {
    announced?: boolean;
    workspace?: string;
    childId?: string;
    depth?: number;
    parentActivationId?: string;
    sessionPath?: string;
    parentSessionId?: string;
    parentSessionPath?: string;
    sessionManager?: {
      appendCustomEntry: (type: string, data: unknown) => void;
      getEntries: () => unknown[];
    };
  } = {},
) {
  return installActivation({
    childId: over.childId ?? "sa-1",
    sessionPath: over.sessionPath ?? "/ws/child.jsonl",
    parentSessionId: over.parentSessionId ?? "p1",
    parentSessionPath: over.parentSessionPath ?? "/ws/parent.jsonl",
    workspace: over.workspace ?? "A",
    session,
    announced: over.announced,
    sessionManager: over.sessionManager,
    depth: over.depth ?? 1,
    ...(over.parentActivationId ? { parentActivationId: over.parentActivationId } : {}),
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

  it("markAnnounced pokes so idle announce does not settle before first busy", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session);
    expect(getActivation("sa-1")?.announced).toBe(false);
    markAnnounced("sa-1");
    expect(getActivation("sa-1")?.announced).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getActivation("sa-1")).toBeDefined();
    expect(sendMessage).not.toHaveBeenCalled();

    session.isStreaming = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.resolveIdle();
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("installing a grandchild links it into the parent's ownedChildren", () => {
    const parent = install(mockSession(), { childId: "sa-1", announced: false });
    install(mockSession(), { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2 });
    expect([...parent.ownedChildren]).toEqual(["sa-1-1"]);
  });

  it("parent does not settle while a grandchild is resident; settles after it settles", async () => {
    const parentSession = mockSession();
    const sendMessage = registerHost();
    install(parentSession, { childId: "sa-1", announced: true });
    const grand = mockSession();
    grand.isStreaming = true; // 孙级在忙，不会立刻自然结算
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getActivation("sa-1")).toBeDefined();
    grand.resolveIdle(); // 孙级自然结算 → 从父 ownedChildren 摘出 → 父结算
    await vi.waitFor(() => {
      expect(getActivation("sa-1")).toBeUndefined();
    });
    // 孙级的 notice 落在子级（sendCustomMessage），顶层 host 只收到子级自己的一条
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a resident child is a parent host: grandchild settlement lands in the child's session", async () => {
    const child = mockSession();
    install(child, { childId: "sa-1", sessionPath: "/ws/child.jsonl", announced: false });
    const grand = mockSession();
    install(grand, {
      childId: "sa-1-1",
      sessionPath: "/ws/grand.jsonl",
      parentActivationId: "sa-1",
      depth: 2,
      announced: true,
      parentSessionPath: "/ws/child.jsonl",
      parentSessionId: "sa-1",
    });
    await vi.waitFor(() => {
      expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    });
    const [msg, opts] = child.sendCustomMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-settled");
    expect(msg.details.childId).toBe("sa-1-1");
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("busy child host gets the grandchild notice as steer", async () => {
    const child = mockSession();
    child.isStreaming = true;
    install(child, { childId: "sa-1", announced: false });
    const grand = mockSession();
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" });
    await vi.waitFor(() => {
      expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    });
    expect(child.sendCustomMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("cancel disposes grandchildren first, then the child; both leave the table", async () => {
    const order: string[] = [];
    const child = mockSession();
    child.dispose = vi.fn(() => order.push("sa-1"));
    install(child, { childId: "sa-1", announced: true });
    const grand = mockSession();
    grand.isStreaming = true;
    grand.dispose = vi.fn(() => order.push("sa-1-1"));
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" });
    await disposeActivation("sa-1", "cancel");
    expect(order).toEqual(["sa-1-1", "sa-1"]);
    expect(getActivation("sa-1-1")).toBeUndefined();
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("host registration is removed on dispose", async () => {
    install(mockSession(), { childId: "sa-1", announced: false });
    expect(parentHostLookup("/ws/child.jsonl", "A")).toBeDefined();
    await disposeActivation("sa-1", "cancel");
    expect(parentHostLookup("/ws/child.jsonl", "A")).toBeUndefined();
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

  it("does not reread the parent prefix after the parent grows", async () => {
    const seed = [
      { role: "user", content: "old parent turn" },
      { role: "assistant", content: [{ type: "text", text: "old parent reply" }] },
    ];
    const parentNew = { role: "user", content: "parent after fork" };
    const session = mockSession();
    session.messages = [...seed, { role: "user", content: "child task" }];
    Object.assign(session, { bindExtensions: vi.fn(async () => {}) });
    sdk.open.mockImplementation((path: string) => {
      expect(path).toBe("/ws/child.jsonl");
      return {
        getEntries: () =>
          metaEntries({
            mode: "continuable",
            tornDown: false,
            inheritedEventCount: seed.length,
            parentSession: "/ws/parent.jsonl",
            parentSessionPath: "/ws/parent.jsonl",
            workspace: "A",
          }),
        cwd: "/ws",
      };
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({ session });
    registerHost();
    await coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "continue please", "followUp");
    expect(sdk.open).toHaveBeenCalledTimes(1);
    expect(sdk.open).toHaveBeenCalledWith("/ws/child.jsonl");
    expect(sdk.open.mock.calls.some((c) => c[0] === "/ws/parent.jsonl")).toBe(false);
    expect(session.messages.slice(0, seed.length)).toEqual(seed);
    expect(session.messages).not.toContainEqual(parentNew);
  });
});
