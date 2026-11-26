import { afterEach, describe, expect, it, vi } from "vitest";
import { commitPendingGoalPause, decideGoalContinuation, goalRunUnavailable, reportGoalRunFailure, __resetGoalContinueForTest } from "./continue.js";
import { __resetGoalActivationsForTest, beginGoalOwner, getGoalOwnerStoppedAt } from "./status.js";
import { createGoal, readSnapshot } from "./session.js";
import type { GoalEvent, GoalSnapshot } from "./types.js";

afterEach(() => { __resetGoalContinueForTest(); __resetGoalActivationsForTest(); });

function snap(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "g1",
    revision: 1,
    condition: "写完",
    status: "active",
    roundsStarted: 1,
    runNumber: 1,
    runRoundsStarted: 1,
    conditionRevision: 1,
    maxRounds: 256,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ranMs: 0,
    ...over,
  };
}

describe("trusted failure-pause repair", () => {
  it("keeps the original failure kind, stop instant and crash fence without lifting unavailable", () => {
    const sessionId = "continue-repair";
    const entries: Array<{ type: "custom"; customType: "goal"; data: GoalEvent }> = [];
    let failAppend = false;
    const pi = { appendEntry: (_type: string, data: GoalEvent) => {
      if (failAppend) throw new Error("disk unavailable");
      entries.push({ type: "custom", customType: "goal", data });
    } };
    const ctx = { sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
      ui: { notify: vi.fn(), setStatus: vi.fn() } };
    beginGoalOwner(sessionId);
    createGoal(pi as never, ctx as never, "finish");
    failAppend = true;
    const fence = { ownerEpoch: "dead-owner", roundId: "dead-round", sequence: 3 };
    expect(reportGoalRunFailure(pi as never, ctx as never, { kind: "request-error", confirmedLoss: fence }))
      .toMatchObject({ persisted: false, error: "GOAL_PAUSE_NOT_PERSISTED" });
    const stoppedAt = getGoalOwnerStoppedAt(sessionId);
    expect(stoppedAt).toBeTruthy();
    failAppend = false;

    expect(commitPendingGoalPause(pi as never, ctx as never)).toBe(true);
    const pause = entries.at(-1)!.data;
    expect(pause).toMatchObject({ kind: "pause", revision: 2, at: stoppedAt,
      payload: { pauseReason: { code: "request-error" }, confirmedLoss: fence } });
    expect(readSnapshot(ctx as never)?.status).toBe("paused");
    expect(goalRunUnavailable(sessionId)).toBe("GOAL_PAUSE_NOT_PERSISTED");
    // Persisted pause or another Goal end cannot be appended twice.
    expect(commitPendingGoalPause(pi as never, ctx as never)).toBe(true);
    expect(entries).toHaveLength(2);
  });
});

describe("decideGoalContinuation", () => {
  it("does nothing without a snapshot", () => {
    expect(decideGoalContinuation({
      snapshot: undefined,
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "none" });
  });

  it.each(["paused", "blocked", "complete"] as const)("does nothing when status is %s", (status) => {
    expect(decideGoalContinuation({
      snapshot: snap({ status }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "none" });
  });

  it("does nothing when active but disarmed", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active" }),
      activation: "disarmed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "none" });
  });

  it("does nothing when any assistant stopReason is aborted", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active" }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }, { stopReason: "aborted" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "none" });
  });

  it("does nothing when any assistant stopReason is error", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active" }),
      activation: "armed",
      assistantStops: [{ stopReason: "error" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "none" });
  });

  it("keeps decision pure; terminal abort is persisted by onAgentSettled", () => {
    const result = decideGoalContinuation({
      snapshot: snap({ status: "active" }),
      activation: "armed",
      assistantStops: [{ stopReason: "aborted" }],
      alreadyNotifiedMaxRounds: false,
    });
    expect(result).toEqual({ action: "none" });
    expect(result).not.toHaveProperty("pause");
    expect(JSON.stringify(result)).not.toMatch(/pause/i);
  });

  it("signals max-rounds when roundsStarted has reached the cap", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active", roundsStarted: 3, runRoundsStarted: 3, maxRounds: 3 }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "max-rounds" });
  });

  it("does not treat an earlier notification as persisted pause", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active", roundsStarted: 3, runRoundsStarted: 3, maxRounds: 3 }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: true,
    })).toEqual({ action: "max-rounds" });
  });

  it("reenters on a normal stop with the next round", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active", roundsStarted: 4 }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "reenter", nextRound: 5 });
  });
});
