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
    const paused = transition(snapshot("active"), { type: "pause", reason: "user_pause", revision: 4 });
    expect(paused.status).toBe("paused");
    expect(paused.stopReason?.kind).toBe("user_pause");
    expect(paused.stopReason?.summary).toBe("user_pause");
    expect(transition(snapshot("judging"), { type: "judge_pass", revision: 4 }).status).toBe("complete");
    const failed = transition(snapshot("judging"), { type: "judge_fail", revision: 4, reason: "missing tests" });
    expect(failed.status).toBe("paused");
    expect(failed.stopReason?.kind).toBe("judge_failed");
    expect(failed.stopReason?.summary).toBe("missing tests");
  });
  it("defaults max rounds and rejects unsafe values", () => {
    expect(validateMaxRounds(undefined)).toBe(256);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateMaxRounds(value)).toThrow("INVALID_MAX_ROUNDS");
    }
  });
  it("keeps disarmed and cleared read-only", () => {
    expect(() => transition(snapshot("disarmed"), { type: "pause", revision: 4 })).toThrow("INVALID_TRANSITION");
    expect(() => transition(snapshot("cleared"), { type: "resume", revision: 4 })).toThrow("INVALID_TRANSITION");
  });
  it("resets consecutive blockage rounds when resumed", () => {
    const paused = { ...snapshot("paused"), blockage: { fingerprint: "x", count: 3, summary: "blocked", at: "now" } };
    expect(transition(paused, { type: "resume", revision: 4 }).blockage?.count).toBe(0);
  });
  it("rejects completed writes with a stable error code", () => {
    expect(() => transition(snapshot("complete"), { type: "resume", revision: 4 })).toThrow("INVALID_TRANSITION");
  });
  it("rejects stale transition revisions", () => {
    expect(() => transition(snapshot("active"), { type: "pause", revision: 3 })).toThrow("VERSION_CONFLICT");
    expect(() => transition(snapshot("active"), { type: "pause" } as never)).toThrow("VERSION_CONFLICT");
  });
  it("covers the lifecycle transition matrix", () => {
    expect(transition(snapshot("active"), { type: "begin_judging", revision: 4 }).status).toBe("judging");
    const blocked = transition(snapshot("active"), { type: "block", revision: 4, reason: "blocked", fingerprint: "fp" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockage).toMatchObject({ fingerprint: "fp", count: 1, summary: "blocked" });
    expect(transition(snapshot("active"), { type: "disarm", revision: 4 }).status).toBe("disarmed");
    expect(transition(snapshot("paused"), { type: "disarm", revision: 4 }).status).toBe("disarmed");
    expect(transition(snapshot("active"), { type: "clear", revision: 4 }).status).toBe("cleared");
    const cleared = transition(snapshot("active"), { type: "clear", revision: 4 });
    expect(cleared.clearedAt).toEqual(expect.any(String));
    expect(cleared.stopReason?.kind).toBe("cleared");
    expect(transition(snapshot("blocked"), { type: "resume", revision: 4 }).status).toBe("active");
    expect(transition(snapshot("disarmed"), { type: "resume", revision: 4 }).status).toBe("active");
    expect(transition(snapshot("error"), { type: "resume", revision: 4 }).status).toBe("active");
    expect(() => transition(snapshot("complete"), { type: "pause", revision: 4 })).toThrow("INVALID_TRANSITION");
    expect(() => transition(snapshot("judging"), { type: "clear", revision: 4 })).toThrow("INVALID_TRANSITION");
    expect(() => transition(snapshot("complete"), { type: "clear", revision: 4 })).toThrow("INVALID_TRANSITION");
    expect(() => transition(snapshot("cleared"), { type: "clear", revision: 4 })).toThrow("INVALID_TRANSITION");
  });
  it("checks goal id and revision for compare-and-swap", () => {
    expect(() => assertRevision({ goalId: "g", revision: 4 }, { goalId: "g", revision: 3 })).toThrow("VERSION_CONFLICT");
    expect(() => assertRevision({ goalId: "g", revision: 4 }, { goalId: "other", revision: 4 })).toThrow("VERSION_CONFLICT");
  });
});
