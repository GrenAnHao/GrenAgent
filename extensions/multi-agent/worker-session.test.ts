import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 假 worker 进程：收到宿主的 RPC 请求就交给 serve 脚本处理，事件用 emitEvent 推回去。 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = Object.assign(new EventEmitter(), { resume: () => {} });
  stderr = new EventEmitter();
  pid = 4242;
  sent: Array<{ t: string; id?: number; method?: string; params?: Record<string, unknown> }> = [];
  serve: (method: string, params: Record<string, unknown>) => unknown = () => null;
  send(message: { t: string; id: number; method: string; params: Record<string, unknown> }, cb?: () => void) {
    this.sent.push(message);
    cb?.();
    if (message.t !== "req") return true;
    queueMicrotask(async () => {
      try {
        const result = await this.serve(message.method, message.params);
        this.emit("message", { t: "res", id: message.id, ok: true, result });
      } catch (error) {
        this.emit("message", { t: "res", id: message.id, ok: false, error: { message: String((error as Error).message) } });
      }
    });
    return true;
  }
  emitEvent(channel: string, payload: unknown) {
    this.emit("message", { t: "evt", channel, payload });
  }
  exit(code: number | null) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
  kill() {
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

const spawned = vi.hoisted(() => ({ children: [] as unknown[], next: undefined as undefined | (() => unknown) }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = spawned.next!();
      spawned.children.push(child);
      return child;
    }),
  };
});
vi.mock("./subagentProcessRegistry.js", () => ({
  registerSubagentProcess: vi.fn(() => () => {}),
  killProcessTree: vi.fn((child: FakeChild) => child.kill()),
}));
const config = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../_shared/runtime-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/runtime-config.js")>();
  return { ...actual, getConfig: (k: string) => config.values[k] };
});
const uiEvents = vi.hoisted(() => [] as unknown[]);
vi.mock("./embedded-events.js", () => ({ emitEmbeddedSubagentEvent: (event: unknown) => uiEvents.push(event) }));

import { spawn } from "node:child_process";
import { openWorkerChildSession, workerSlotsInUse } from "./worker-session.js";
import { onLeakedError } from "../_shared/leak-owner.js";
import { __resetApprovalRoutesForTest, registerTopApprovalRoute } from "../_shared/approval-route.js";

const idle = { isStreaming: false, isIdle: true, pendingMessageCount: 0 };
const busy = { isStreaming: true, isIdle: false, pendingMessageCount: 0 };

function prepared() {
  return {
    childConfig: { PI_RUNTIME_CONFIG: "/tmp/rc.json" },
    parentPath: "/ws/parent.jsonl",
    workspace: "/ws",
    ctx: { origin: "subagent" as const, workspace: "/ws", cwd: "/ws", config: { A: "1" }, sessionId: () => "parent-1" },
    cleanup: () => {},
  };
}

function nextChild(serve?: FakeChild["serve"]): FakeChild {
  const child = new FakeChild();
  child.serve = serve ?? ((method) => {
    if (method === "open") {
      return { sessionId: "sa-1", sessionPath: "/ws/s/sa-1.jsonl", workspace: "/ws", inheritedEventCount: 0, entries: [], state: idle };
    }
    if (method === "waitForIdle") return { ...idle, messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }], transcript: "t", streamingDelta: "" };
    if (method === "prompt" || method === "abort") return idle;
    return null;
  });
  spawned.next = () => {
    queueMicrotask(() => child.emitEvent("ready", { pid: child.pid }));
    return child;
  };
  return child;
}

beforeEach(() => {
  config.values = {};
  uiEvents.length = 0;
  spawned.children.length = 0;
  process.env.PI_WORKER_ENTRY = "C:/app/out/main/pi-worker.js";
  vi.mocked(spawn).mockClear();
});

afterEach(() => {
  for (const child of spawned.children as FakeChild[]) if (child.exitCode === null && child.signalCode === null) child.exit(0);
});

describe("openWorkerChildSession", () => {
  it("spawns pi-worker --mode subagent with IPC and opens the child session there", async () => {
    const child = nextChild();
    const handle = await openWorkerChildSession({ cwd: "/ws/wt", projectCwd: "/ws", task: "t", agentId: "sa-1", onUpdate: () => {} }, prepared());
    const [cmd, args, options] = vi.mocked(spawn).mock.calls[0]! as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(["C:/app/out/main/pi-worker.js", "--mode", "subagent"]);
    expect(options).toMatchObject({ cwd: "/ws/wt", serialization: "advanced", stdio: ["ignore", "pipe", "pipe", "ipc"] });
    expect((options.env as Record<string, string>).PI_RUNTIME_CONFIG).toBe("/tmp/rc.json");
    const open = child.sent.find((m) => m.method === "open")!;
    expect(open.params).toMatchObject({
      opts: { cwd: "/ws/wt", projectCwd: "/ws", task: "t", agentId: "sa-1", backend: "worker" },
      prepared: { parentSessionId: "parent-1", ctx: { cwd: "/ws", config: { A: "1" } } },
    });
    expect((open.params!.opts as Record<string, unknown>).onUpdate).toBeUndefined();
    expect(handle.sessionPath).toBe("/ws/s/sa-1.jsonl");
    expect(handle.session.sessionId).toBe("sa-1");
  });

  it("mirrors session events and state, forwards them to the UI sink and updates", async () => {
    const child = nextChild();
    const updates: unknown[] = [];
    const handle = await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1", onUpdate: (u) => updates.push(u) }, prepared());
    const seen: unknown[] = [];
    handle.session.subscribe((event) => seen.push(event));
    child.emitEvent("event", { event: { type: "turn_start" }, state: busy });
    child.emitEvent("update", { text: "partial", transcript: "" });
    expect(handle.session.isStreaming).toBe(true);
    expect((handle.session as unknown as { isIdle: boolean }).isIdle).toBe(false);
    expect(seen).toEqual([{ type: "turn_start" }]);
    expect(uiEvents).toEqual([{ type: "turn_start" }]);
    expect(updates).toEqual([{ text: "partial", transcript: "" }]);
    handle.unsub();
    child.emitEvent("event", { event: { type: "agent_end" }, state: idle });
    expect(uiEvents).toHaveLength(1);
  });

  it("prompt relays the preflight disposition before resolving; waitForIdle refreshes messages", async () => {
    const child = nextChild();
    const base = child.serve;
    child.serve = (method, params) => {
      if (method === "prompt") child.emitEvent("preflight", { requestId: params.requestId, disposition: { accepted: true } });
      return base(method, params);
    };
    const handle = await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
    const order: string[] = [];
    await handle.session.prompt("go", { preflightResult: () => order.push("preflight") } as never);
    order.push("resolved");
    expect(order).toEqual(["preflight", "resolved"]);
    await handle.session.waitForIdle();
    expect(handle.session.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "OK" }] }]);
    expect(handle.getTranscript()).toBe("t");
  });

  it("a crashed worker settles the session as an error instead of hanging", async () => {
    const child = nextChild();
    const handle = await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
    const ends: unknown[] = [];
    handle.session.subscribe((event) => ends.push(event));
    child.emitEvent("event", { event: { type: "turn_start" }, state: busy });
    child.serve = () => new Promise(() => {}); // waitForIdle never answers
    const waiting = handle.session.waitForIdle();
    child.exit(3);
    await waiting;
    expect(handle.session.isStreaming).toBe(false);
    const last = handle.session.messages.at(-1) as { stopReason?: string; errorMessage?: string };
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toContain("exited (3)");
    expect(ends.at(-1)).toMatchObject({ type: "agent_end" });
    await expect(handle.session.prompt("again")).rejects.toThrow(/exited/);
  });

  it("an error leaked in the worker is handed to the child it hosts (the worker hosts one child)", async () => {
    const child = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-w" }, prepared());
    const handler = vi.fn();
    const off = onLeakedError("sa-w", handler);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      child.emitEvent("leaked", { kind: "unhandledRejection", message: "boom" });
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as Error).message).toBe("boom");
      expect(log.mock.calls[0]?.[0]).toBe("[multi-agent] sub-agent sa-w (worker): unhandledRejection: boom");
      off();
      child.emitEvent("leaked", { kind: "uncaughtException", message: "late" });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[1]?.[0]).toBe("[multi-agent] sub-agent sa-w (worker): uncaughtException (already settled): late");
    } finally {
      off();
      log.mockRestore();
    }
  });

  it("a worker that is closing only logs its errors; they do not reach a child resumed under the same id", async () => {
    const child = nextChild();
    const handle = await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-w2" }, prepared());
    const handler = vi.fn();
    const off = onLeakedError("sa-w2", handler);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      handle.session.dispose();
      child.emitEvent("leaked", { kind: "unhandledRejection", message: "while closing" });
      expect(handler).not.toHaveBeenCalled();
      expect(log.mock.calls[0]?.[0]).toBe("[multi-agent] sub-agent sa-w2 (worker, closing): unhandledRejection: while closing");
    } finally {
      off();
      log.mockRestore();
    }
  });

  it("queues past SUBAGENT_MAX_WORKERS and starts the next worker once one exits", async () => {
    config.values.SUBAGENT_MAX_WORKERS = "1";
    const first = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "a", agentId: "sa-1" }, prepared());
    expect(workerSlotsInUse()).toBe(1);
    nextChild();
    let opened = false;
    const second = openWorkerChildSession({ cwd: "/ws", task: "b", agentId: "sa-2" }, prepared()).then(() => (opened = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    first.exit(0);
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("dispose asks the worker to close and kills it if it lingers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const child = nextChild();
      const handle = await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
      handle.session.dispose();
      await Promise.resolve();
      expect(child.sent.some((m) => m.method === "dispose")).toBe(true);
      expect(child.signalCode).toBeNull();
      vi.advanceTimersByTime(3000);
      expect(child.signalCode).toBe("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("approvals from a worker child", () => {
  afterEach(() => __resetApprovalRoutesForTest());

  const request = (child: FakeChild, id: number, method: string, params: Record<string, unknown>) =>
    child.emit("message", { t: "req", id, method, params });
  const replyTo = (child: FakeChild, id: number) =>
    vi.waitFor(() => {
      const reply = child.sent.find((m) => m.t === "res" && m.id === id) as { result?: unknown } | undefined;
      expect(reply).toBeDefined();
      return reply!.result;
    });

  it("forwards to the parent's route in the host and answers over RPC", async () => {
    const select = vi.fn<(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>>(async () => "允许本次");
    registerTopApprovalRoute("/ws/parent.jsonl", { select });
    const child = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());

    request(child, 900, "approval", {
      requestId: "r1",
      sessionPath: "/ws/parent.jsonl",
      title: "请求批准：x",
      options: ["允许本次", "拒绝"],
      chain: [{ agentId: "sa-1", label: "t" }],
      timeoutMs: 60_000,
    });
    await expect(replyTo(child, 900)).resolves.toEqual({ outcome: "answered", choice: "允许本次" });
    expect(select.mock.calls[0]?.[0]).toBe("子代理 t（sa-1） 请求批准：x");
  });

  it("approvalCancel withdraws the open question, and a worker exit withdraws whatever is left", async () => {
    const signals: AbortSignal[] = [];
    registerTopApprovalRoute("/ws/parent.jsonl", {
      select: (_t, _o, opts) =>
        new Promise((resolve) => {
          signals.push(opts!.signal!);
          opts?.signal?.addEventListener("abort", () => resolve(undefined));
        }),
    });
    const child = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
    const ask = (id: number, requestId: string) =>
      request(child, id, "approval", { requestId, sessionPath: "/ws/parent.jsonl", title: "x", options: ["拒绝"], chain: [], timeoutMs: 60_000 });

    ask(901, "r1");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    request(child, 902, "approvalCancel", { requestId: "r1" });
    await expect(replyTo(child, 901)).resolves.toEqual({ outcome: "cancelled" });

    ask(903, "r2");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    child.exit(1);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("answers whether the host can reach a person for that parent", async () => {
    registerTopApprovalRoute("/ws/parent.jsonl", { select: async () => undefined });
    const child = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
    request(child, 905, "approvalReachable", { sessionPath: "/ws/parent.jsonl" });
    request(child, 906, "approvalReachable", { sessionPath: "/ws/gone.jsonl" });
    await expect(replyTo(child, 905)).resolves.toBe(true);
    await expect(replyTo(child, 906)).resolves.toBe(false);
  });

  it("a parent with no route in the host is unavailable", async () => {
    const child = nextChild();
    await openWorkerChildSession({ cwd: "/ws", task: "t", agentId: "sa-1" }, prepared());
    request(child, 904, "approval", { requestId: "r3", sessionPath: "/ws/gone.jsonl", title: "x", options: [], chain: [], timeoutMs: 1000 });
    await expect(replyTo(child, 904)).resolves.toEqual({ outcome: "unavailable" });
  });
});
