import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../_shared/runtime-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared/runtime-config.js")>();
  return { ...actual, getConfig: (key: string) => config.values[key] };
});
vi.mock("./embedded-runner.js", () => ({
  openEmbeddedChildSession: vi.fn(),
  runEmbeddedSubagent: vi.fn(),
  startContinuableEmbedded: vi.fn(),
}));
vi.mock("./worker-session.js", () => ({ openWorkerChildSession: vi.fn() }));

import { DELEGATION_SCOPE_STATEMENT, delegationScopeWithApprovals } from "../_shared/delegation-scope.js";
import { __resetApprovalRoutesForTest, registerTopApprovalRoute } from "../_shared/approval-route.js";
import { DIAGNOSTIC_MAX_BYTES } from "./backends.js";
import {
  __resetChildRunsForTest,
  markChildRunning,
  markChildSettled,
  onChildRunEvent,
  runningChildrenOf,
  silenceChild,
  type ChildRunEvent,
} from "./child-runs.js";
import { __resetActiveRunsForTest, activeRuns } from "./active-runs.js";
import { openEmbeddedChildSession, runEmbeddedSubagent, startContinuableEmbedded } from "./embedded-runner.js";
import {
  preferredBackend,
  runSubagent,
  selectSubagentBackend,
  startBackgroundRun,
  startContinuableSubagent,
  type SubagentResult,
} from "./manager.js";
import type { SettlementNotice } from "./settlement-notice.js";
import { openWorkerChildSession } from "./worker-session.js";

type RunResult = Awaited<ReturnType<typeof runEmbeddedSubagent>>;

const done = (over: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  output: "OK",
  exitCode: 0,
  transcript: "",
  sessionPath: "/s/child.jsonl",
  stopReason: "completed",
  ...over,
});

beforeEach(() => {
  config.values = {};
  vi.mocked(runEmbeddedSubagent).mockReset();
  vi.mocked(startContinuableEmbedded).mockReset();
});

describe("selectSubagentBackend", () => {
  it("defaults to in-process; worker only when the setting or the named role asks for it", () => {
    expect(selectSubagentBackend().kind).toBe("in-process");
    expect(selectSubagentBackend("worker").kind).toBe("worker");
    config.values.SUBAGENT_BACKEND = "worker";
    expect(preferredBackend()).toBe("worker");
    expect(selectSubagentBackend().kind).toBe("worker");
    expect(selectSubagentBackend("in-process").kind).toBe("in-process");
    config.values.SUBAGENT_BACKEND = "nonsense";
    expect(selectSubagentBackend().kind).toBe("in-process");
  });

  it("both backends are real sessions with the same capabilities", () => {
    const expected = { continuable: true, fork: true, outputSchema: true, toolFilter: true, modelOverride: true };
    expect(selectSubagentBackend("in-process").capabilities).toEqual(expected);
    expect(selectSubagentBackend("worker").capabilities).toEqual(expected);
  });
});

describe("runSubagent", () => {
  it("in-process: runs the shared runner with the local opener and the delegation scope", async () => {
    vi.mocked(runEmbeddedSubagent).mockResolvedValue(done());
    const r = await runSubagent("/ws", "say OK", "sa-1", { systemPrompt: "named", depth: 1, projectCwd: "/ws" });
    const [opts, open] = vi.mocked(runEmbeddedSubagent).mock.calls[0]!;
    expect(opts).toMatchObject({ cwd: "/ws", projectCwd: "/ws", task: "say OK", agentId: "sa-1", depth: 1 });
    expect(opts.systemPrompt).toBe(`named\n\n${DELEGATION_SCOPE_STATEMENT}`);
    expect(open).toBe(openEmbeddedChildSession);
    expect(r).toMatchObject({ backend: "in-process", output: "OK", stopReason: "completed" });
    expect(r.diagnostic).toBeUndefined();
  });

  it("when the parent can ask a person, the delegation scope says approvals go to the user with the wait", async () => {
    vi.mocked(runEmbeddedSubagent).mockResolvedValue(done());
    registerTopApprovalRoute("/s/parent.jsonl", { select: vi.fn(async () => undefined) });
    try {
      config.values.SUBAGENT_APPROVAL_TIMEOUT_MS = "45000";
      await runSubagent("/ws", "t", "sa-1", { parentSessionPath: "/s/parent.jsonl" });
      expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]![0].systemPrompt).toBe(delegationScopeWithApprovals(45));

      config.values.SUBAGENT_APPROVAL_TIMEOUT_MS = "0";
      await runSubagent("/ws", "t", "sa-2", { parentSessionPath: "/s/parent.jsonl" });
      expect(vi.mocked(runEmbeddedSubagent).mock.calls[1]![0].systemPrompt).toBe(DELEGATION_SCOPE_STATEMENT);
    } finally {
      __resetApprovalRoutesForTest();
    }
  });

  it("worker: the same runner with the worker opener", async () => {
    vi.mocked(runEmbeddedSubagent).mockResolvedValue(done());
    const r = await runSubagent("/ws", "t", "sa-2", { backend: "worker" });
    expect(vi.mocked(runEmbeddedSubagent).mock.calls[0]![1]).toBe(openWorkerChildSession);
    expect(r.backend).toBe("worker");
  });

  it("puts the error into a capped diagnostic when the child did not complete", async () => {
    const error = "错".repeat(2000); // 6000 bytes
    vi.mocked(runEmbeddedSubagent).mockResolvedValue(done({ ok: false, output: "", exitCode: -1, error, stopReason: "error" }));
    const r = await runSubagent("/ws", "t", "sa-3", {});
    expect(r.stopReason).toBe("error");
    expect(Buffer.byteLength(r.diagnostic ?? "", "utf8")).toBeLessThanOrEqual(DIAGNOSTIC_MAX_BYTES);
    expect(r.diagnostic).toBe("错".repeat(Math.floor(DIAGNOSTIC_MAX_BYTES / 3)));
    expect(r.error).toBe(error);
  });
});

describe("startBackgroundRun", () => {
  const settledEvents: ChildRunEvent[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    __resetChildRunsForTest();
    settledEvents.length = 0;
    off = onChildRunEvent((e) => settledEvents.push(e));
  });
  afterEach(() => off());

  it("returns at once, books the result, then delivers a non-continuable settlement notice", async () => {
    let finish!: (r: RunResult) => void;
    vi.mocked(runEmbeddedSubagent).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const order: string[] = [];
    const deliver = vi.fn((_notice: SettlementNotice) => order.push("deliver"));
    const onSettled = vi.fn((_result: SubagentResult) => order.push("onSettled"));
    startBackgroundRun("/ws", "t", "sa-b1", { parentSessionId: "p1", deliver, onSettled });
    expect(runningChildrenOf("p1")).toEqual(["sa-b1"]);
    await vi.waitFor(() => expect(runEmbeddedSubagent).toHaveBeenCalled());
    finish(done());
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["onSettled", "deliver"]);
    expect(onSettled.mock.calls[0]![0]).toMatchObject({ backend: "in-process", stopReason: "completed", output: "OK" });
    const notice = deliver.mock.calls[0]![0];
    expect(notice.stopReason).toBe("completed");
    expect(notice.content).toContain("cannot receive further messages");
    expect(settledEvents.at(-1)?.settled).toEqual({ childId: "sa-b1", parentSessionId: "p1", stopReason: "completed" });
    expect(runningChildrenOf("p1")).toEqual([]);
  });

  it("a rejected run settles as error with its diagnostic; a throwing onSettled does not block the notice", async () => {
    vi.mocked(runEmbeddedSubagent).mockRejectedValue(new Error("spawn failed"));
    const deliver = vi.fn((_notice: SettlementNotice) => {});
    startBackgroundRun("/ws", "t", "sa-b2", {
      parentSessionId: "p1",
      deliver,
      onSettled: () => {
        throw new Error("registry closed");
      },
    });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const notice = deliver.mock.calls[0]![0];
    expect(notice.stopReason).toBe("error");
    expect(notice.content).toContain("Diagnostic: spawn failed");
  });

  it("a silenced run (parent being deleted) leaves without a notice or a settlement", async () => {
    let finish!: (r: RunResult) => void;
    vi.mocked(runEmbeddedSubagent).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const deliver = vi.fn((_notice: SettlementNotice) => {});
    const onSettled = vi.fn();
    startBackgroundRun("/ws", "t", "sa-b3", { parentSessionId: "p1", deliver, onSettled });
    silenceChild("sa-b3");
    await vi.waitFor(() => expect(runEmbeddedSubagent).toHaveBeenCalled());
    finish(done());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(deliver).not.toHaveBeenCalled();
    expect(settledEvents).toEqual([{ childId: "sa-b3", parentSessionId: "p1" }]);
  });
});

describe("startContinuableSubagent", () => {
  it("starts an Activation with the delegation scope on the chosen backend", async () => {
    vi.mocked(startContinuableEmbedded).mockResolvedValue({ agentId: "sa-7", sessionPath: "/s/7.jsonl" });
    const started = await startContinuableSubagent({ cwd: "/ws", task: "t", agentId: "sa-7" });
    expect(started).toEqual({ agentId: "sa-7", sessionPath: "/s/7.jsonl" });
    const [opts, open] = vi.mocked(startContinuableEmbedded).mock.calls[0]!;
    expect(opts.systemPrompt).toBe(DELEGATION_SCOPE_STATEMENT);
    expect(open).toBe(openEmbeddedChildSession);
  });

  it("continuable children can run in a worker too", async () => {
    vi.mocked(startContinuableEmbedded).mockResolvedValue({ agentId: "sa-8", sessionPath: "/s/8.jsonl" });
    await startContinuableSubagent({ cwd: "/ws", task: "t", agentId: "sa-8", backend: "worker" });
    expect(vi.mocked(startContinuableEmbedded).mock.calls[0]![1]).toBe(openWorkerChildSession);
  });
});

describe("active slots around runs", () => {
  beforeEach(() => {
    __resetActiveRunsForTest();
    __resetChildRunsForTest();
  });

  it("a foreground run holds a slot only while it runs", async () => {
    let finish!: (r: RunResult) => void;
    vi.mocked(runEmbeddedSubagent).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const running = runSubagent("/ws", "t", "sa-slot", { depth: 1 });
    await vi.waitFor(() => expect(activeRuns().map((r) => r.childId)).toEqual(["sa-slot"]));
    finish(done());
    await running;
    expect(activeRuns()).toEqual([]);
  });

  it("a continuable child keeps its slot until it settles", async () => {
    vi.mocked(startContinuableEmbedded).mockResolvedValue({ agentId: "sa-c", sessionPath: "/s/c.jsonl" });
    await startContinuableSubagent({ cwd: "/ws", task: "t", agentId: "sa-c", depth: 1 });
    expect(activeRuns().map((r) => r.childId)).toEqual(["sa-c"]);
    markChildRunning("sa-c", "p1");
    markChildSettled({ childId: "sa-c", parentSessionId: "p1", stopReason: "completed" });
    expect(activeRuns()).toEqual([]);
  });

  it("a failed continuable start gives the slot back", async () => {
    vi.mocked(startContinuableEmbedded).mockRejectedValue(new Error("prompt not accepted"));
    await expect(startContinuableSubagent({ cwd: "/ws", task: "t", agentId: "sa-x", depth: 1 })).rejects.toThrow();
    expect(activeRuns()).toEqual([]);
  });
});
