import { describe, expect, it } from "vitest";
import { restoreFromEntries, assertRevision, transition, validateMaxRounds } from "./state.js";
import type { GoalSnapshot } from "./contracts.js";

describe("restoreFromEntries", () => {
  it("returns undefined when no goal entry", () => {
    expect(restoreFromEntries([])).toBeUndefined();
    expect(restoreFromEntries([{ type: "custom", customType: "plan-mode", data: {} }])).toBeUndefined();
  });
  it("restores the latest goal entry (defaults paused=false for legacy data)", () => {
    expect(
      restoreFromEntries([{ type: "custom", customType: "goal", data: { condition: "c", react: 2 } }]),
    ).toEqual({ condition: "c", react: 2, paused: false });
  });
  it("restores the paused flag", () => {
    expect(
      restoreFromEntries([
        { type: "custom", customType: "goal", data: { condition: "c", react: 1, paused: true } },
      ]),
    ).toEqual({ condition: "c", react: 1, paused: true });
  });
  it("treats a cleared (null) latest goal entry as no goal", () => {
    expect(
      restoreFromEntries([
        { type: "custom", customType: "goal", data: { condition: "a", react: 1 } },
        { type: "custom", customType: "goal", data: null },
      ]),
    ).toBeUndefined();
  });
});

const snapshot = (status: GoalSnapshot["status"]): GoalSnapshot => ({
  goalId: "g", sessionId: "s", workspace: "/w", revision: 4, condition: "c", status,
  roundsUsed: 0, maxRounds: 256, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("goal state contract", () => {
  it("allows only the specified transitions", () => {
    const paused = transition(snapshot("active"), { type: "pause", reason: "user_pause" });
    expect(paused.status).toBe("paused");
    expect(paused.stopReason).toEqual({ reason: "user_pause" });
    expect(transition(snapshot("judging"), { type: "judge_pass", revision: 4 }).status).toBe("complete");
    expect(transition(snapshot("judging"), { type: "judge_fail", revision: 4 }).status).toBe("paused");
  });
  it("defaults max rounds and rejects unsafe values", () => {
    expect(validateMaxRounds(undefined)).toBe(256);
    expect(() => validateMaxRounds(0)).toThrow("INVALID_MAX_ROUNDS");
    expect(() => validateMaxRounds(Number.MAX_SAFE_INTEGER + 1)).toThrow("INVALID_MAX_ROUNDS");
  });
  it("keeps disarmed and cleared read-only", () => {
    expect(() => transition(snapshot("disarmed"), { type: "pause" })).toThrow("INVALID_TRANSITION");
    expect(() => transition(snapshot("cleared"), { type: "resume" })).toThrow("INVALID_TRANSITION");
  });
  it("resets consecutive blockage rounds when resumed", () => {
    const paused = { ...snapshot("paused"), blockage: { reason: "blocked", consecutiveRounds: 3 } };
    expect(transition(paused, { type: "resume", revision: 4 }).blockage?.consecutiveRounds).toBe(0);
  });
  it("rejects completed writes with a stable error code", () => {
    expect(() => transition(snapshot("complete"), { type: "resume", revision: 4 })).toThrow("INVALID_TRANSITION");
  });
  it("checks goal id and revision for compare-and-swap", () => {
    expect(() => assertRevision({ goalId: "g", revision: 4 }, { goalId: "g", revision: 3 })).toThrow("VERSION_CONFLICT");
    expect(() => assertRevision({ goalId: "g", revision: 4 }, { goalId: "other", revision: 4 })).toThrow("VERSION_CONFLICT");
  });
});
