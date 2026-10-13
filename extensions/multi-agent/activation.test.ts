import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

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

const jobsMock = vi.hoisted(() => {
  const m: {
    hasLive: ReturnType<typeof vi.fn>;
    onJobDone: ReturnType<typeof vi.fn>;
    listener?: (s: { owner: string }) => void;
  } = {
    hasLive: vi.fn(() => false),
    onJobDone: vi.fn((l: (s: { owner: string }) => void) => {
      m.listener = l;
      return () => {};
    }),
  };
  return m;
});
vi.mock("../jobs/service.js", () => ({ jobs: jobsMock }));

import { SubagentError } from "./inbox.js";
import {
  __resetApprovalRoutesForTest,
  canRequestApproval,
  registerTopApprovalRoute,
  requestApproval,
} from "../_shared/approval-route.js";
import {
  registerParentSessionHost,
  lookupParentHost as parentHostLookup,
  __resetParentHostsForTest,
} from "./parent-host.js";
import {
  ChildLock,
  authorizeParent,
  coldResumeAndDeliver,
  activationHasLiveWork,
  agentMessage,
  deliverToChild,
  deliverWithoutWaking,
  disposeActivation,
  getActivation,
  installActivation,
  interruptChild,
  markAnnounced,
  residentChildIds,
  writeTornDown,
  drainByParent,
  __resetActivationsForTest,
  type ActivationSettledInfo,
} from "./activation.js";
import { currentChild, reportLeakedError, runAsChild } from "../_shared/leak-owner.js";
import {
  markChildRunning,
  markChildSettled,
  onChildRunEvent,
  runningChildrenOf,
  type ChildRunEvent,
} from "./child-runs.js";

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
    keepResident?: boolean;
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
    ...(over.keepResident ? { keepResident: true } : {}),
  });
}

describe("activation", () => {
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
    jobsMock.hasLive.mockReturnValue(false);
  });

  it("routes the child's approvals to its parent while the activation lives, labelled from its meta", async () => {
    __resetApprovalRoutesForTest();
    const select = vi.fn<(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>>(async () => "允许本次");
    registerTopApprovalRoute("/ws/parent.jsonl", { select });
    install(mockSession(), {
      sessionManager: {
        appendCustomEntry: vi.fn(),
        getEntries: () => [{ type: "custom", customType: "subagent_meta", data: { label: "fix the parser" } }],
      },
    });
    expect(await canRequestApproval("/ws/child.jsonl")).toBe(true);
    await expect(requestApproval("/ws/child.jsonl", { title: "x", options: ["允许本次"] })).resolves.toEqual({
      outcome: "answered",
      choice: "允许本次",
    });
    expect(select.mock.calls[0]?.[0]).toBe("子代理 fix the parser（sa-1） x");

    await disposeActivation("sa-1", "cancel");
    expect(await canRequestApproval("/ws/child.jsonl")).toBe(false);
    __resetApprovalRoutesForTest();
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

  it("parent still settles if the grandchild unlinks while the wait waker is being armed", async () => {
    const parentSession = mockSession();
    const sendMessage = registerHost();
    install(parentSession, { childId: "sa-1", announced: true });
    const grand = mockSession();
    grand.isStreaming = true;
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" });
    grand.resolveIdle(); // 不先等 20ms，让 unlink 与父 wait 交接重叠
    await vi.waitFor(() => {
      expect(getActivation("sa-1")).toBeUndefined();
    });
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

  it("does not settle while the child owns a live job; settles after the job is gone", async () => {
    jobsMock.hasLive.mockReturnValue(true);
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    jobsMock.hasLive.mockReturnValue(false);
    jobsMock.listener?.({ owner: "sa-1" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it("does not settle while a worker background grandchild runs; settles once it settles", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    markChildRunning("sa-grand", "sa-1");
    install(session, { announced: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    markChildSettled({ childId: "sa-grand", parentSessionId: "sa-1", stopReason: "completed" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it("reports running on announce and settled after the notice, for wait_agent", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    const events: ChildRunEvent[] = [];
    const off = onChildRunEvent((e) => events.push(e));
    try {
      install(session, { announced: false });
      expect(runningChildrenOf("p1")).toEqual([]);
      markAnnounced("sa-1");
      expect(runningChildrenOf("p1")).toEqual(["sa-1"]);
      session.isStreaming = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      session.resolveIdle();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(events[0]).toEqual({
        childId: "sa-1",
        parentSessionId: "p1",
        settled: { childId: "sa-1", parentSessionId: "p1", stopReason: "completed" },
      });
      expect(runningChildrenOf("p1")).toEqual([]);
    } finally {
      off();
    }
  });

  it("cancel of an announced child settles as aborted; rollback leaves without a settlement", async () => {
    const events: ChildRunEvent[] = [];
    const off = onChildRunEvent((e) => events.push(e));
    try {
      registerHost();
      const a = mockSession();
      a.isStreaming = true;
      install(a, { announced: false, childId: "sa-a" });
      markAnnounced("sa-a");
      await disposeActivation("sa-a", "cancel");
      expect(events.at(-1)?.settled).toMatchObject({ childId: "sa-a", stopReason: "aborted" });

      const b = mockSession();
      install(b, { announced: false, childId: "sa-b" });
      await disposeActivation("sa-b", "rollback");
      expect(events.some((e) => e.childId === "sa-b")).toBe(false);
      expect(runningChildrenOf("p1")).toEqual([]);
    } finally {
      off();
    }
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

  it("links the resumed child into the sender's ownedChildren when given", async () => {
    const sender = install(mockSession(), { childId: "sa-1", announced: false });
    sdk.open.mockReturnValue({
      getEntries: () => [
        {
          type: "custom",
          customType: "subagent_meta",
          data: { mode: "continuable", parentSessionId: "sa-1", parentSession: "/ws/child.jsonl", depth: 2 },
        },
      ],
      appendCustomEntry: vi.fn(),
      cwd: "/ws",
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({
      session: { ...mockSession(), bindExtensions: vi.fn(async () => {}) },
    });
    await coldResumeAndDeliver("sa-1-1", "/ws/grand.jsonl", "hi", "followUp", { senderActivationId: "sa-1" });
    expect([...sender.ownedChildren]).toEqual(["sa-1-1"]);
    expect(getActivation("sa-1-1")?.depth).toBe(2);
  });
});

describe("idle residency (settled in-process children stay warm)", () => {
  const origMax = process.env.SUBAGENT_MAX_RESIDENT;
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
    jobsMock.hasLive.mockReturnValue(false);
    delete process.env.SUBAGENT_MAX_RESIDENT;
  });
  afterEach(() => {
    if (origMax === undefined) delete process.env.SUBAGENT_MAX_RESIDENT;
    else process.env.SUBAGENT_MAX_RESIDENT = origMax;
  });

  function entriesManager(meta: Record<string, unknown> = { mode: "continuable" }) {
    const entries: unknown[] = [{ type: "custom", customType: "subagent_meta", data: meta }];
    return {
      entries,
      sm: {
        appendCustomEntry: vi.fn((type: string, data: unknown) => entries.push({ type: "custom", customType: type, data })),
        getEntries: () => entries,
      },
    };
  }

  it("keeps the session after settlement and reuses it on the next message without reopening the log", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    const { sm } = entriesManager();
    install(session, { announced: true, keepResident: true, sessionManager: sm });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(session.dispose).not.toHaveBeenCalled();
    expect(getActivation("sa-1")).toBeUndefined();
    expect(residentChildIds()).toEqual(["sa-1"]);

    await coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "one more thing", "followUp");
    expect(sdk.open).not.toHaveBeenCalled();
    expect(getActivation("sa-1")?.session).toBe(session);
    expect(residentChildIds()).toEqual([]);
    expect(session.prompt).toHaveBeenCalledWith("one more thing", expect.anything());
  });

  it("without keepResident (worker sessions) the session is disposed on settlement", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(residentChildIds()).toEqual([]);
  });

  it("evicts the least recently used resident beyond SUBAGENT_MAX_RESIDENT", async () => {
    process.env.SUBAGENT_MAX_RESIDENT = "1";
    const sendMessage = registerHost();
    const first = mockSession();
    install(first, { announced: true, keepResident: true, childId: "sa-a", sessionPath: "/ws/a.jsonl" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    const second = mockSession();
    install(second, { announced: true, keepResident: true, childId: "sa-b", sessionPath: "/ws/b.jsonl" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(residentChildIds()).toEqual(["sa-b"]);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("SUBAGENT_MAX_RESIDENT=0 turns residency off", async () => {
    process.env.SUBAGENT_MAX_RESIDENT = "0";
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true, keepResident: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("draining the parent disposes its residents; tearing down writes through the resident's own log handle", async () => {
    const sendMessage = registerHost();
    const a = mockSession();
    const { sm, entries } = entriesManager();
    install(a, { announced: true, keepResident: true, childId: "sa-a", sessionManager: sm });
    const b = mockSession();
    install(b, { announced: true, keepResident: true, childId: "sa-b", parentSessionPath: "/ws/other.jsonl" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(residentChildIds().sort()).toEqual(["sa-a", "sa-b"]));

    writeTornDown("sa-a", "/ws/a.jsonl");
    expect(entries.at(-1)).toMatchObject({ customType: "subagent_meta", data: { tornDown: true } });
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(sdk.open).not.toHaveBeenCalled();

    await drainByParent("/ws/other.jsonl");
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(residentChildIds()).toEqual([]);
  });
});

describe("deliverWithoutWaking (send_message wake: false)", () => {
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
    jobsMock.hasLive.mockReturnValue(false);
  });

  const message = agentMessage("p1", "remember BANANA");
  const continuableMeta = [
    {
      type: "custom",
      customType: "subagent_meta",
      data: { mode: "continuable", tornDown: false, parentSessionId: "p1", parentSessionPath: "/ws/parent.jsonl", workspace: "A" },
    },
  ];

  it("a running child gets it before its next step without starting anything: the SDK queues it to the turn boundary", async () => {
    const session = mockSession();
    install(session);
    session.isStreaming = true;
    await expect(deliverWithoutWaking("sa-1", { message })).resolves.toBe("next-step");
    // 不先查 isStreaming 再 steer：交给持有会话的一侧 triggerTurn: false，它在跑就排到 turn_end，不会在这一轮刚好结束时变成新开一轮。
    expect(session.sendCustomMessage).toHaveBeenCalledWith(message, { triggerTurn: false });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("an idle child with a live activation gets it appended to its context without a turn", async () => {
    const session = mockSession();
    install(session);
    await expect(deliverWithoutWaking("sa-1", { message })).resolves.toBe("appended");
    expect(session.sendCustomMessage).toHaveBeenCalledWith(message, { triggerTurn: false });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(message.content).toBe("Agent p1 sent a message without waking you:\nremember BANANA");
  });

  it("a resident child stays resident and is not woken", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true, keepResident: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(residentChildIds()).toEqual(["sa-1"]);
    const prompts = session.prompt.mock.calls.length;

    await expect(deliverWithoutWaking("sa-1", { message })).resolves.toBe("appended");
    expect(session.sendCustomMessage).toHaveBeenCalledWith(message, { triggerTurn: false });
    expect(session.prompt.mock.calls.length).toBe(prompts);
    expect(residentChildIds()).toEqual(["sa-1"]);
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("an unloaded child gets one entry appended to its JSONL; no session is loaded", async () => {
    const appendCustomMessageEntry = vi.fn();
    sdk.open.mockReturnValue({ getEntries: () => continuableMeta, appendCustomMessageEntry });
    await expect(deliverWithoutWaking("sa-1", { sessionPath: "/ws/child.jsonl", message })).resolves.toBe("appended");
    expect(sdk.open).toHaveBeenCalledWith("/ws/child.jsonl");
    expect(appendCustomMessageEntry).toHaveBeenCalledWith("agent-message", message.content, true, { from: "p1" });
    expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("a resident session without a message channel is refused, never written behind its back", async () => {
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true, keepResident: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    delete (session as { sendCustomMessage?: unknown }).sendCustomMessage;
    const appendCustomMessageEntry = vi.fn();
    sdk.open.mockReturnValue({ getEntries: () => continuableMeta, appendCustomMessageEntry });
    await expect(deliverWithoutWaking("sa-1", { sessionPath: "/ws/child.jsonl", message })).rejects.toMatchObject({
      code: "NO_ACTIVATION",
    });
    expect(appendCustomMessageEntry).not.toHaveBeenCalled();
  });

  it("knows whether a child still has work that keeps it from settling", async () => {
    install(mockSession());
    expect(activationHasLiveWork("sa-1")).toBe(false);
    jobsMock.hasLive.mockReturnValue(true);
    expect(activationHasLiveWork("sa-1")).toBe(true);
    expect(activationHasLiveWork("nobody")).toBe(false);
  });

  it("refuses a child that cannot be resumed and writes nothing", async () => {
    const appendCustomMessageEntry = vi.fn();
    sdk.open.mockReturnValue({
      getEntries: () => [{ type: "custom", customType: "subagent_meta", data: { mode: "continuable", tornDown: true } }],
      appendCustomMessageEntry,
    });
    await expect(deliverWithoutWaking("sa-1", { sessionPath: "/ws/child.jsonl", message })).rejects.toMatchObject({
      code: "NOT_RESUMABLE",
    });
    await expect(deliverWithoutWaking("sa-1", { message })).rejects.toMatchObject({ code: "NOT_RESUMABLE" });
    expect(appendCustomMessageEntry).not.toHaveBeenCalled();
  });

  it("waits for a cold resume in flight instead of writing the log behind the live session's back", async () => {
    const session = mockSession();
    Object.assign(session, { bindExtensions: vi.fn(async () => {}) });
    const appendCustomMessageEntry = vi.fn();
    sdk.open.mockReturnValue({ getEntries: () => continuableMeta, appendCustomMessageEntry, cwd: "/ws" });
    let releaseServices!: () => void;
    sdk.createAgentSessionServices.mockImplementationOnce(
      () => new Promise((resolve) => { releaseServices = () => resolve({ modelRuntime: { id: "runtime" } }); }),
    );
    sdk.createAgentSessionFromServices.mockResolvedValue({ session });
    registerHost();

    const resuming = coldResumeAndDeliver("sa-1", "/ws/child.jsonl", "wake up", "followUp");
    const quiet = deliverWithoutWaking("sa-1", { sessionPath: "/ws/child.jsonl", message });
    await vi.waitFor(() => expect(sdk.createAgentSessionServices).toHaveBeenCalled());
    releaseServices();
    await resuming;
    // 等冷恢复装好会话之后才轮到这条：经活着的会话写，没有绕过它直接追加 JSONL。
    await quiet;
    expect(session.sendCustomMessage).toHaveBeenCalledWith(message, { triggerTurn: false });
    expect(appendCustomMessageEntry).not.toHaveBeenCalled();
  });
});

describe("leaked errors and teardown boundaries", () => {
  let log: MockInstance<typeof console.error>;
  beforeEach(() => {
    __resetActivationsForTest();
    __resetParentHostsForTest();
    vi.clearAllMocks();
    jobsMock.hasLive.mockReturnValue(false);
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });
  const logged = () => log.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");

  function installWith(session: ReturnType<typeof mockSession>, over: { onSettled?: (info: ActivationSettledInfo) => void; announced?: boolean; childId?: string; parentActivationId?: string; sessionPath?: string } = {}) {
    return installActivation({
      childId: over.childId ?? "sa-1",
      sessionPath: over.sessionPath ?? "/ws/child.jsonl",
      parentSessionId: "p1",
      parentSessionPath: "/ws/parent.jsonl",
      workspace: "A",
      session,
      announced: over.announced,
      ...(over.parentActivationId ? { parentActivationId: over.parentActivationId } : {}),
      ...(over.onSettled ? { onSettled: over.onSettled } : {}),
    });
  }

  it("a leaked error while the child runs aborts its turn and settles it as an error with the reason; later ones are only reported", async () => {
    const session = mockSession();
    session.abort.mockImplementation(async () => session.resolveIdle());
    const sendMessage = registerHost();
    const onSettled = vi.fn<(info: ActivationSettledInfo) => void>();
    session.isStreaming = true;
    installWith(session, { announced: true, onSettled });

    expect(reportLeakedError(new Error("boom"), "sa-1")).toEqual({ childId: "sa-1", handled: true });
    expect(session.abort).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.details.stopReason).toBe("error");
    expect(msg.content).toContain("Diagnostic: uncaught error: boom");
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "error", diagnostic: "uncaught error: boom" }));
    expect(reportLeakedError(new Error("late"), "sa-1")).toEqual({ childId: "sa-1", handled: false });
  });

  it("a turn started by someone else (send_message, the main process) still belongs to the child", async () => {
    const session = mockSession();
    let owner: string | undefined = "unset";
    session.prompt.mockImplementation(async () => {
      owner = currentChild();
      session.isStreaming = true;
    });
    installWith(session);
    runAsChild("sa-parent", () => deliverToChild("sa-1", "go", "followUp"));
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    expect(owner).toBe("sa-1");
  });

  it("waking a parent leaves the waking child: a child parent runs as itself, the main session as nobody", () => {
    const parentSession = mockSession();
    let parentOwner: string | undefined = "unset";
    parentSession.sendCustomMessage.mockImplementation(() => {
      parentOwner = currentChild();
    });
    installWith(parentSession, { childId: "sa-parent", sessionPath: "/ws/sa-parent.jsonl" });
    let mainOwner: string | undefined = "unset";
    registerHost({ sendMessage: vi.fn(() => { mainOwner = currentChild(); }) });

    const msg = { customType: "subagent-settled", content: "x", display: true, details: {} };
    runAsChild("sa-child", () => parentHostLookup("/ws/sa-parent.jsonl", "A")!.sendMessage(msg, { triggerTurn: true }));
    runAsChild("sa-child", () => parentHostLookup("/ws/parent.jsonl", "A")!.sendMessage(msg, { triggerTurn: true }));
    expect(parentOwner).toBe("sa-parent");
    expect(mainOwner).toBeUndefined();
  });

  it("a message that could not be delivered settles the child as an error instead of leaving it running", async () => {
    const session = mockSession();
    session.prompt.mockRejectedValue(new Error("worker exited"));
    const sendMessage = registerHost();
    installWith(session);
    deliverToChild("sa-1", "go", "followUp");
    markAnnounced("sa-1");
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.details.stopReason).toBe("error");
    expect(msg.content).toContain("Diagnostic: message delivery failed: worker exited");
    expect(logged()).toContain("sa-1: message delivery failed");
  });

  it("dispose throwing during settlement still notifies the parent, marks the child settled and records the result", async () => {
    const session = mockSession();
    session.dispose.mockImplementation(() => {
      throw new Error("dispose exploded");
    });
    const sendMessage = registerHost();
    const onSettled = vi.fn<(info: ActivationSettledInfo) => void>();
    const events: ChildRunEvent[] = [];
    const off = onChildRunEvent((event) => events.push(event));
    installWith(session, { announced: true, onSettled });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    off();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].details.stopReason).toBe("completed");
    expect(events.some((event) => event.settled?.childId === "sa-1")).toBe(true);
    expect(getActivation("sa-1")).toBeUndefined();
    expect(logged()).toContain("sub-agent sa-1 teardown failed: release session: dispose exploded");
  });

  it("disposeActivation keeps releasing the other children and the parent when one child fails", async () => {
    const parent = mockSession();
    const broken = mockSession();
    broken.dispose.mockImplementation(() => {
      throw new Error("child dispose exploded");
    });
    const fine = mockSession();
    installWith(parent, { childId: "sa-p", sessionPath: "/ws/sa-p.jsonl" });
    installWith(broken, { childId: "sa-c1", sessionPath: "/ws/sa-c1.jsonl", parentActivationId: "sa-p" });
    installWith(fine, { childId: "sa-c2", sessionPath: "/ws/sa-c2.jsonl", parentActivationId: "sa-p" });

    await expect(disposeActivation("sa-p", "cancel")).resolves.toBeUndefined();
    expect(fine.dispose).toHaveBeenCalledTimes(1);
    expect(parent.dispose).toHaveBeenCalledTimes(1);
    expect(getActivation("sa-c1")).toBeUndefined();
    expect(getActivation("sa-c2")).toBeUndefined();
    expect(getActivation("sa-p")).toBeUndefined();
    expect(logged()).toContain("sub-agent sa-c1 teardown failed: release session: child dispose exploded");
  });

  it("after a failure the child takes no more messages; queued ones are dropped and counted in the diagnostic", async () => {
    const session = Object.assign(mockSession(), {
      clearQueue: vi.fn(() => ({ steering: ["queued steer"], followUp: ["queued follow-up"] })),
    });
    session.abort.mockImplementation(async () => session.resolveIdle());
    const sendMessage = registerHost();
    session.isStreaming = true;
    installWith(session, { announced: true });
    reportLeakedError(new Error("boom"), "sa-1");
    expect(() => deliverToChild("sa-1", "one more", "followUp")).toThrow(
      expect.objectContaining({ code: "ACTIVATION_FAILED" }),
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("Diagnostic: uncaught error: boom; 2 queued message(s) were dropped");
  });

  it("a message still in preflight when the child fails: the watch waits for it to start, aborts it, then settles", async () => {
    const session = mockSession();
    session.prompt.mockImplementation(() => new Promise(() => {}));
    session.abort.mockImplementation(async () => session.resolveIdle());
    const sendMessage = registerHost();
    installWith(session);
    deliverToChild("sa-1", "go", "followUp");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    reportLeakedError(new Error("boom"), "sa-1");
    // 会话看着空闲（还在 preflight）：这时中断会被起跑重置，所以先不中断，也不结算。
    expect(session.abort).not.toHaveBeenCalled();
    markAnnounced("sa-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    session.isStreaming = true;
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0][0].details.stopReason).toBe("error");
  });

  it("a failing settlement watch force-settles the child as an error", async () => {
    const session = mockSession();
    session.waitForIdle = () => Promise.reject(new Error("idle wait broke"));
    const sendMessage = registerHost();
    installWith(session, { announced: true });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const [msg] = sendMessage.mock.calls[0];
    expect(msg.details.stopReason).toBe("error");
    expect(msg.content).toContain("Diagnostic: settlement failed: idle wait broke");
    expect(getActivation("sa-1")).toBeUndefined();
  });
});
