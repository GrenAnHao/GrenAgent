import { afterEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  __resetGoalAuthForTest,
  assertToolCaller,
  clearGoalTurnMarks,
  captureGoalToolCall,
  assertGoalToolRound,
  releaseGoalRound,
  revokeGoalRound,
  occupiedGoalRound,
  hasHumanInput,
  setGoalHumanInput,
  occupyGoalRound,
} from "./auth.js";

afterEach(() => {
  __resetGoalAuthForTest();
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_IS_SUBAGENT;
});

const ws = { origin: "main" as const, workspace: "/repo", cwd: "/repo", config: {} };
const sessionA = "session-a";
const sessionB = "session-b";
const pendingA = { goalId: "g", runNumber: 1, conditionRevision: 1, round: 3 };

describe("goal tool auth", () => {
  it("rejects subagent origin", () => {
    process.env.PI_IS_SUBAGENT = "1";
    expect(() => assertToolCaller()).toThrow("GOAL_TOOL_ORIGIN");
  });

  it("does not treat PI_GOAL_WORKER as authority", () => {
    process.env.PI_GOAL_WORKER = "1";
    runInWorkspace(ws, () => {
      expect(hasHumanInput(sessionA)).toBe(false);
      expect(occupiedGoalRound(sessionA)).toBeUndefined();
    });
  });

  it("human mark lives until agent_settled", () => {
    runInWorkspace(ws, () => {
      setGoalHumanInput(sessionA);
      expect(hasHumanInput(sessionA)).toBe(true);
      clearGoalTurnMarks(sessionA);
      expect(hasHumanInput(sessionA)).toBe(false);
    });
  });

  it("pending round matches exactly and dies after settle", () => {
    runInWorkspace(ws, () => {
      const ref = occupyGoalRound(sessionA, pendingA);
      expect(occupiedGoalRound(sessionA)).toEqual(ref);
      expect(occupyGoalRound(sessionA, { ...pendingA, round: 2 })).toBeUndefined();
      clearGoalTurnMarks(sessionA, ref?.roundId);
      expect(occupiedGoalRound(sessionA)).toBeUndefined();
    });
  });

  it("does not let session B see session A's human mark", () => {
    setGoalHumanInput(sessionA);
    expect(hasHumanInput(sessionA)).toBe(true);
    expect(hasHumanInput(sessionB)).toBe(false);
  });

  it("keeps an invalidated runner occupied; old settlement cannot release a newer slot", () => {
    const old = occupyGoalRound(sessionA, pendingA)!;
    captureGoalToolCall(sessionA, "old-call");
    revokeGoalRound(sessionA);
    expect(occupyGoalRound(sessionA, { ...pendingA, conditionRevision: 2 })).toBeUndefined();
    expect(() => assertGoalToolRound(sessionA, "old-call", {
      goalId: "g", runNumber: 1, conditionRevision: 2, status: "active",
    })).toThrow("GOAL_TOOL_ROUND_STALE");
    expect(releaseGoalRound(sessionA, old.roundId)).toBe(true);
    const fresh = occupyGoalRound(sessionA, { ...pendingA, conditionRevision: 2 })!;
    expect(releaseGoalRound(sessionA, old.roundId)).toBe(false);
    expect(occupiedGoalRound(sessionA)).toEqual(fresh);
    expect(() => assertGoalToolRound(sessionA, "old-call", {
      goalId: "g", runNumber: 1, conditionRevision: 2, status: "active",
    })).toThrow("GOAL_TOOL_ROUND_STALE");
  });

  it("inherits the captured parent for codemode nested calls, never the current grant", () => {
    const old = occupyGoalRound(sessionA, pendingA)!;
    captureGoalToolCall(sessionA, "codemode-root");
    revokeGoalRound(sessionA);
    releaseGoalRound(sessionA, old.roundId);
    occupyGoalRound(sessionA, { ...pendingA, runNumber: 2 });
    captureGoalToolCall(sessionA, "codemode-root/1", "codemode-root");
    expect(() => assertGoalToolRound(sessionA, "codemode-root/1", {
      goalId: "g", runNumber: 2, conditionRevision: 1, status: "active",
    })).toThrow("GOAL_TOOL_ROUND_STALE");
    captureGoalToolCall(sessionB, "foreign/1", "codemode-root");
    expect(() => assertGoalToolRound(sessionB, "foreign/1", {
      goalId: "g", runNumber: 2, conditionRevision: 1, status: "active",
    })).toThrow("GOAL_TOOL_ROUND_STALE");
  });

  it("does not let session B clear session A's pending round", () => {
    const a = occupyGoalRound(sessionA, pendingA);
    const b = occupyGoalRound(sessionB, { goalId: "other", runNumber: 1, conditionRevision: 1, round: 1 });
    clearGoalTurnMarks(sessionB, b?.roundId);
    expect(occupiedGoalRound(sessionA)).toEqual(a);
    expect(occupiedGoalRound(sessionB)).toBeUndefined();
  });
});
