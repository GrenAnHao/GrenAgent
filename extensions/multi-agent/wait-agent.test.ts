import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetChildRunsForTest,
  markChildGone,
  markChildRunning,
  markChildSettled,
} from "./child-runs.js";
import { formatWaitResult, registerWaitAgent, waitForChildren, WAIT_DEFAULT_MS, WAIT_MAX_MS, WAIT_MIN_MS } from "./wait-agent.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;

function loadTool(): { execute: Execute; tool: Record<string, unknown> } {
  let tool: Record<string, unknown> = {};
  const pi = { registerTool: (t: Record<string, unknown>) => (tool = t) };
  registerWaitAgent(pi as never, {
    parentKey: (ctx) => ctx.sessionManager?.getSessionId?.() ?? "",
    labelOf: (_cwd, id) => (id === "sa-1" ? "review parser" : undefined),
  });
  return { execute: tool.execute as Execute, tool };
}

const ctx = (pending = () => false) => ({
  cwd: "/ws",
  sessionManager: { getSessionId: () => "p1" },
  hasPendingMessages: pending,
});

beforeEach(() => {
  __resetChildRunsForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForChildren", () => {
  it("returns none at once when the caller has no running child", async () => {
    markChildRunning("sa-x", "other-parent");
    expect(await waitForChildren("p1", { timeoutMs: 30_000 })).toEqual({ outcome: "none", settled: [], running: [] });
  });

  it("returns on the first settlement and batches siblings that settle in the same tick", async () => {
    markChildRunning("sa-1", "p1");
    markChildRunning("sa-2", "p1");
    markChildRunning("sa-3", "p1");
    const p = waitForChildren("p1", { timeoutMs: 30_000 });
    markChildSettled({ childId: "sa-1", parentSessionId: "p1", stopReason: "completed" });
    markChildSettled({ childId: "sa-2", parentSessionId: "p1", stopReason: "error" });
    const r = await p;
    expect(r.outcome).toBe("settled");
    expect(r.settled.map((s) => `${s.childId}:${s.stopReason}`)).toEqual(["sa-1:completed", "sa-2:error"]);
    expect(r.running).toEqual(["sa-3"]);
  });

  it("ignores other parents' children", async () => {
    markChildRunning("sa-1", "p1");
    markChildRunning("sa-9", "p2");
    const p = waitForChildren("p1", { timeoutMs: 1_000 });
    markChildSettled({ childId: "sa-9", parentSessionId: "p2", stopReason: "completed" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).outcome).toBe("timeout");
  });

  it("times out and leaves the children running", async () => {
    markChildRunning("sa-1", "p1");
    const p = waitForChildren("p1", { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ outcome: "timeout", settled: [], running: ["sa-1"] });
  });

  it("ends early when new input is queued, and on abort", async () => {
    markChildRunning("sa-1", "p1");
    let pending = false;
    const steered = waitForChildren("p1", { timeoutMs: 30_000, hasPendingInput: () => pending });
    await vi.advanceTimersByTimeAsync(500);
    pending = true;
    await vi.advanceTimersByTimeAsync(300);
    expect((await steered).outcome).toBe("steered");

    const controller = new AbortController();
    const aborted = waitForChildren("p1", { timeoutMs: 30_000, signal: controller.signal });
    controller.abort();
    expect((await aborted).outcome).toBe("aborted");
  });

  it("a child that leaves without settling ends the wait as none once nothing runs", async () => {
    markChildRunning("sa-1", "p1");
    const p = waitForChildren("p1", { timeoutMs: 30_000 });
    markChildGone("sa-1");
    expect((await p).outcome).toBe("none");
  });
});

describe("wait_agent tool", () => {
  it("is described for Available tools and its guidelines name the tool", () => {
    const { tool } = loadTool();
    expect(tool.name).toBe("wait_agent");
    expect(typeof tool.promptSnippet).toBe("string");
    for (const g of tool.promptGuidelines as string[]) expect(g).toContain("wait_agent");
  });

  it("returns a summary, not the output, with labels", async () => {
    markChildRunning("sa-1", "p1");
    const { execute } = loadTool();
    const p = execute("w", {}, null, null, ctx());
    markChildSettled({ childId: "sa-1", parentSessionId: "p1", stopReason: "completed" });
    const r = await p;
    expect(r.content[0].text).toContain("- sa-1 (review parser): completed");
    expect(r.content[0].text).toContain("separate subagent-settled notice");
    expect(r.details).toMatchObject({ outcome: "settled", timeoutMs: WAIT_DEFAULT_MS, running: [] });
  });

  it("clamps a short timeout up to the minimum and says so; rejects one above the maximum", async () => {
    markChildRunning("sa-2", "p1");
    const { execute } = loadTool();
    const p = execute("w", { timeout_ms: 5 }, null, null, ctx());
    await vi.advanceTimersByTimeAsync(WAIT_MIN_MS);
    const r = await p;
    expect(r.details).toMatchObject({ outcome: "timeout", timeoutMs: WAIT_MIN_MS, running: ["sa-2"] });
    expect(r.content[0].text).toContain(`clamped to the minimum of ${WAIT_MIN_MS}ms`);

    const tooLong = await execute("w", { timeout_ms: WAIT_MAX_MS + 1 }, null, null, ctx());
    expect(tooLong.isError).toBe(true);
  });

  it("returns at once with no running children", async () => {
    const { execute } = loadTool();
    const r = await execute("w", {}, null, null, ctx());
    expect(r.details.outcome).toBe("none");
    expect(r.content[0].text).toContain("nothing to wait for");
  });
});

describe("formatWaitResult", () => {
  it("names still-running children on timeout", () => {
    expect(formatWaitResult({ outcome: "timeout", settled: [], running: ["sa-1", "sa-2"] }, 30_000, (id) => (id === "sa-1" ? "x" : undefined)))
      .toBe("Wait timed out after 30000ms. Still running: sa-1 (x), sa-2.");
  });
});
