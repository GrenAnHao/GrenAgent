import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetGoalAuthForTest, occupiedGoalRound, revokeGoalRound } from "./auth.js";
import { beginCompactionIntent, finishCompactionActivity } from "../_shared/compaction-activity.js";
import { __resetGoalContinueForTest, goalRunUnavailable, onAgentSettled, recordGoalCompactionFailure, recordGoalRunStart, recordRunStopReasons, reportGoalRunFailure, startArmedGoalRound } from "./continue.js";
import { __resetGoalActivationsForTest, getActivation } from "./status.js";
import { createGoal, editGoal, pauseGoal, readSnapshot, restartGoalForControl, resumeGoal } from "./session.js";
import type { GoalEvent } from "./types.js";

afterEach(() => {
  __resetGoalAuthForTest(); __resetGoalContinueForTest(); __resetGoalActivationsForTest();
});

let fixtureNumber = 0;
function setup() {
  const sessionId = `goal-lifecycle-fixture-${++fixtureNumber}`;
  const entries: Array<{ type: "custom"; customType: "goal"; data: GoalEvent }> = [];
  const sent: unknown[] = [];
  const statuses: string[] = [];
  let failAppend = false;
  const pi = {
    appendEntry: (type: string, event: GoalEvent) => {
      if (failAppend) throw new Error("disk unavailable");
      entries.push({ type: "custom", customType: type as "goal", data: event });
    },
    sendMessage: async (value: unknown) => { sent.push(value); },
  };
  const ctx = {
    cwd: "/repo", sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    ui: { setStatus: (_key: string, value: string) => { statuses.push(value); }, notify: vi.fn() },
  };
  return { sessionId, entries, sent, statuses, pi: pi as never, ctx: ctx as never, fail: () => { failAppend = true; } };
}

function stops(f: ReturnType<typeof setup>, ...stopReasons: string[]) {
  recordGoalRunStart(f.sessionId);
  for (const stopReason of stopReasons) recordRunStopReasons(f.sessionId, [{ role: "assistant", stopReason }]);
}
async function settle(f: ReturnType<typeof setup>, aborted = false) {
  await onAgentSettled({ aborted } as never, f.ctx, f.pi);
}

describe("Goal owner lifecycle", () => {
  it("pauses at the batch cap, preserves lifetime counts and restarts only through the trusted control path", async () => {
    const f = setup();
    createGoal(f.pi, f.ctx, "condition", 2);
    await Promise.all([startArmedGoalRound(f.pi, f.ctx), startArmedGoalRound(f.pi, f.ctx)]);
    expect(readSnapshot(f.ctx)).toMatchObject({ runNumber: 1, roundsStarted: 1, runRoundsStarted: 1 });
    expect(f.sent).toHaveLength(1);
    stops(f, "stop"); await settle(f);
    expect(readSnapshot(f.ctx)).toMatchObject({ runNumber: 1, roundsStarted: 2, runRoundsStarted: 2 });
    stops(f, "stop"); await settle(f);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "paused", pauseReason: { code: "max-rounds" }, roundsStarted: 2 });
    expect(getActivation(f.sessionId)).toBe("disarmed");
    expect(() => resumeGoal(f.pi, f.ctx)).toThrow("GOAL_RESTART_REQUIRES_CONTROL");
    restartGoalForControl(f.pi, f.ctx);
    await Promise.all([startArmedGoalRound(f.pi, f.ctx), startArmedGoalRound(f.pi, f.ctx)]);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "active", runNumber: 2, roundsStarted: 3, runRoundsStarted: 1 });
    expect(f.sent).toHaveLength(3);
    expect(f.entries.filter((e) => e.data.kind === "restart")).toHaveLength(1);
  });

  it("duplicate old settlement after next round starts cannot release or pause that round", async () => {
    const f = setup(); createGoal(f.pi, f.ctx, "work", 3); await startArmedGoalRound(f.pi, f.ctx);
    stops(f, "stop"); await settle(f);
    const next = occupiedGoalRound(f.sessionId)!;
    const sent = f.sent.length;
    await settle(f); // A duplicate has no new agent_end identity.
    expect(occupiedGoalRound(f.sessionId)).toEqual(next);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "active", runRoundsStarted: 2 });
    expect(f.sent).toHaveLength(sent);
  });

  it("ordinary pause and resume retain used budget; edits revoke but keep the old runner slot", async () => {
    const f = setup();
    createGoal(f.pi, f.ctx, "first", 3);
    await startArmedGoalRound(f.pi, f.ctx);
    const old = occupiedGoalRound(f.sessionId)!;
    editGoal(f.pi, f.ctx, "second");
    await startArmedGoalRound(f.pi, f.ctx);
    expect(f.sent).toHaveLength(1);
    expect(occupiedGoalRound(f.sessionId)?.roundId).toBe(old.roundId);
    stops(f, "stop"); await settle(f);
    expect(f.sent).toHaveLength(2);
    const fresh = occupiedGoalRound(f.sessionId)!;
    expect(fresh.conditionRevision).toBe(2);
    expect(fresh.roundId).not.toBe(old.roundId);
    pauseGoal(f.pi, f.ctx);
    stops(f, "stop"); await settle(f);
    expect(readSnapshot(f.ctx)?.status).toBe("paused");
    resumeGoal(f.pi, f.ctx);
    await startArmedGoalRound(f.pi, f.ctx);
    expect(readSnapshot(f.ctx)).toMatchObject({ runNumber: 1, runRoundsStarted: 3 });
  });

  it("only the final SDK result matters: retry success continues and exhaustion pauses exactly once", async () => {
    const f = setup(); createGoal(f.pi, f.ctx, "work", 4);
    await startArmedGoalRound(f.pi, f.ctx);
    stops(f, "error", "stop"); await settle(f);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "active", runRoundsStarted: 2 });
    stops(f, "error", "error"); await settle(f);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "paused", pauseReason: { code: "request-error" } });
    const writes = f.entries.length;
    await settle(f);
    expect(f.entries).toHaveLength(writes);
  });

  it("ignores a host catch captured for an old batch or condition after fresh work starts", async () => {
    const f = setup(); createGoal(f.pi, f.ctx, "before", 2); await startArmedGoalRound(f.pi, f.ctx);
    const old = occupiedGoalRound(f.sessionId)!;
    editGoal(f.pi, f.ctx, "after");
    stops(f, "stop"); await settle(f);
    const fresh = occupiedGoalRound(f.sessionId)!;
    const writes = f.entries.length;
    expect(reportGoalRunFailure(f.pi, f.ctx, { kind: "runtime-error", roundId: old.roundId,
      goalId: old.goalId, runNumber: old.runNumber, conditionRevision: old.conditionRevision })).toMatchObject({ skipped: true, persisted: true });
    expect(reportGoalRunFailure(f.pi, f.ctx, { kind: "runtime-error", goalId: old.goalId,
      runNumber: old.runNumber, conditionRevision: old.conditionRevision })).toMatchObject({ skipped: true, persisted: true });
    expect(f.entries).toHaveLength(writes);
    expect(occupiedGoalRound(f.sessionId)).toEqual(fresh);
    expect(readSnapshot(f.ctx)?.status).toBe("active");
  });

  it("a committed automatic compaction resumes an internal abort exactly once", async () => {
    const f = setup(); createGoal(f.pi, f.ctx, "work"); await startArmedGoalRound(f.pi, f.ctx);
    const activity = beginCompactionIntent({ sessionId: f.sessionId }, "policy-auto");
    stops(f, "aborted"); await settle(f, true);
    expect(f.sent).toHaveLength(1);
    finishCompactionActivity(f.sessionId, activity.operationId, true);
    await vi.waitUntil(() => f.sent.length === 2, { timeout: 1000 });
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "active", runRoundsStarted: 2 });
    await settle(f, true); // Duplicate old settlement must not pause the new runner.
    expect(f.sent).toHaveLength(2);
  });

  it("holds the Goal dispatch behind preparing compaction and closes a final compaction failure", async () => {
    const f = setup(); createGoal(f.pi, f.ctx, "work");
    const activity = beginCompactionIntent({ sessionId: f.sessionId }, "policy-auto");
    await startArmedGoalRound(f.pi, f.ctx);
    expect(f.sent).toHaveLength(0); // No round budget consumed during preparing.
    finishCompactionActivity(f.sessionId, activity.operationId, true);
    await startArmedGoalRound(f.pi, f.ctx);
    expect(readSnapshot(f.ctx)?.runRoundsStarted).toBe(1);
    const running = beginCompactionIntent({ sessionId: f.sessionId }, "sdk-overflow");
    stops(f, "aborted");
    await settle(f);
    recordGoalCompactionFailure(f.sessionId, "Bearer credential raw error");
    finishCompactionActivity(f.sessionId, running.operationId, false);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "paused", pauseReason: { code: "request-error" }, runRoundsStarted: 1 });
    expect(JSON.stringify(f.entries)).not.toContain("credential raw error");
    expect(f.sent).toHaveLength(1);
  });

  it("user stop and host preparation failure freeze and disarm; failed persistence is unavailable", async () => {
    const stopped = setup(); createGoal(stopped.pi, stopped.ctx, "work"); await startArmedGoalRound(stopped.pi, stopped.ctx);
    stops(stopped, "aborted"); await settle(stopped, true);
    expect(readSnapshot(stopped.ctx)).toMatchObject({ status: "paused", pauseReason: { code: "user" } });
    const f = setup(); createGoal(f.pi, f.ctx, "work"); await startArmedGoalRound(f.pi, f.ctx);
    const old = occupiedGoalRound(f.sessionId)!;
    const failure = reportGoalRunFailure(f.pi, f.ctx, { kind: "runtime-error", roundId: old.roundId, message: "Bearer secret https://private.example/?token=leak raw response" });
    expect(failure.persisted).toBe(true);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: "paused", pauseReason: { code: "runtime-error", message: "运行器未能完成本轮，请检查会话状态。" } });
    expect(JSON.stringify(f.entries)).not.toMatch(/secret|private\.example|token=leak|raw response/);
    const failed = setup(); createGoal(failed.pi, failed.ctx, "work"); await startArmedGoalRound(failed.pi, failed.ctx);
    failed.fail();
    expect(reportGoalRunFailure(failed.pi, failed.ctx, { kind: "runtime-error" })).toMatchObject({ persisted: false, error: "GOAL_PAUSE_NOT_PERSISTED" });
    expect(goalRunUnavailable(failed.sessionId)).toBe("GOAL_PAUSE_NOT_PERSISTED");
    expect(JSON.parse(failed.statuses.at(-1)!)).toMatchObject({ unavailable: "GOAL_PAUSE_NOT_PERSISTED", snapshot: { status: "active", activation: "disarmed" } });
    expect(JSON.parse(failed.statuses.at(-1)!).snapshot).not.toHaveProperty("runStartedAt");
    expect(getActivation(failed.sessionId)).toBe("disarmed");
    expect(readSnapshot(failed.ctx)?.status).toBe("active"); // Not falsely persisted.
    await startArmedGoalRound(failed.pi, failed.ctx);
    expect(failed.sent).toHaveLength(1);
    revokeGoalRound(failed.sessionId);
  });
});
