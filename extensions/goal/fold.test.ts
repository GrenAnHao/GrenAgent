import { describe, expect, it } from "vitest";
import { foldGoal, isGoalEventKind } from "./fold.js";
import type { GoalEvent } from "./types.js";

const at = "2026-09-13T00:00:00.000Z";

function ev(event: GoalEvent) {
  return { type: "custom", customType: "goal", data: event, timestamp: event.at };
}

describe("isGoalEventKind", () => {
  it("accepts the eight kinds and rejects others", () => {
    for (const kind of ["create", "edit", "pause", "resume", "complete", "blocked", "clear", "round"] as const) {
      expect(isGoalEventKind(kind)).toBe(true);
    }
    expect(isGoalEventKind("begin_judging")).toBe(false);
    expect(isGoalEventKind(undefined)).toBe(false);
  });
});

describe("foldGoal", () => {
  it("folds create → edit → pause → resume → round → complete", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "g1", revision: 1, at, payload: { condition: "  写完  ", maxRounds: 8 } }),
      ev({ kind: "edit", goalId: "g1", revision: 2, at, payload: { condition: "写完并通过测试" } }),
      ev({ kind: "pause", goalId: "g1", revision: 3, at, payload: { reason: "user" } }),
      ev({ kind: "resume", goalId: "g1", revision: 4, at, payload: {} }),
      ev({ kind: "round", goalId: "g1", revision: 5, at, payload: { round: 1 } }),
      ev({ kind: "complete", goalId: "g1", revision: 6, at, payload: { summary: "done" } }),
    ]);
    expect(snapshot).toMatchObject({
      goalId: "g1",
      revision: 6,
      condition: "写完并通过测试",
      status: "complete",
      roundsStarted: 1,
      maxRounds: 8,
    });
    expect(snapshot?.activation).toBeUndefined();
  });

  it("clears the projection but keeps later create on a new goalId at revision 1", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "old", revision: 1, at, payload: { condition: "旧" } }),
      ev({ kind: "clear", goalId: "old", revision: 2, at, payload: {} }),
      ev({ kind: "create", goalId: "new", revision: 1, at, payload: { condition: "新" } }),
    ]);
    expect(snapshot).toMatchObject({ goalId: "new", revision: 1, condition: "新", status: "active", roundsStarted: 0, maxRounds: 256 });
  });

  it("returns undefined after clear with no later create", () => {
    expect(foldGoal([
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "x" } }),
      ev({ kind: "clear", goalId: "g", revision: 2, at, payload: {} }),
    ])).toBeUndefined();
  });

  it("sorts by revision and ignores goal-round bodies and kind-less goal entries", () => {
    const snapshot = foldGoal([
      { type: "custom", customType: "goal-round", data: { kind: "create", goalId: "x", revision: 9, payload: { condition: "假" } } },
      { type: "custom", customType: "goal", data: { condition: "legacy", react: 2 } },
      ev({ kind: "edit", goalId: "g", revision: 2, at, payload: { condition: "后写先出现" } }),
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "先" } }),
      { type: "message", customType: "goal-round", content: "续跑", details: { goalId: "g", revision: 2, round: 1 } },
    ]);
    expect(snapshot).toMatchObject({ goalId: "g", revision: 2, condition: "后写先出现", status: "active", roundsStarted: 0 });
  });

  it("rejects illegal transitions by skipping the event", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "c" } }),
      ev({ kind: "complete", goalId: "g", revision: 2, at, payload: {} }),
      ev({ kind: "resume", goalId: "g", revision: 3, at, payload: {} }),
    ]);
    expect(snapshot).toMatchObject({ status: "complete", revision: 2 });
  });
});
