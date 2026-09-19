import { describe, expect, it } from "vitest";
import { decideGoalContinuation } from "./continue.js";
import type { GoalSnapshot } from "./types.js";

function snap(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "g1",
    revision: 1,
    condition: "写完",
    status: "active",
    roundsStarted: 1,
    maxRounds: 256,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ranMs: 0,
    ...over,
  };
}

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

  it("treats abort as a stop, not a pause write", () => {
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
      snapshot: snap({ status: "active", roundsStarted: 3, maxRounds: 3 }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: false,
    })).toEqual({ action: "max-rounds" });
  });

  it("returns none when max-rounds was already notified", () => {
    expect(decideGoalContinuation({
      snapshot: snap({ status: "active", roundsStarted: 3, maxRounds: 3 }),
      activation: "armed",
      assistantStops: [{ stopReason: "stop" }],
      alreadyNotifiedMaxRounds: true,
    })).toEqual({ action: "none" });
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
