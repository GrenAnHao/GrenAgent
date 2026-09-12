import { afterEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  __resetGoalAuthForTest,
  assertToolCaller,
  clearGoalTurnMarks,
  hasGoalRound,
  hasHumanInput,
  setGoalHumanInput,
  setGoalRoundPending,
} from "./auth.js";

afterEach(() => {
  __resetGoalAuthForTest();
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_IS_SUBAGENT;
});

const ws = { origin: "main" as const, workspace: "/repo", cwd: "/repo", config: {} };
const sessionA = "session-a";
const sessionB = "session-b";
const pendingA = { goalId: "g", revision: 2, round: 3 };

describe("goal tool auth", () => {
  it("rejects subagent origin", () => {
    process.env.PI_IS_SUBAGENT = "1";
    expect(() => assertToolCaller()).toThrow("GOAL_TOOL_ORIGIN");
  });

  it("does not treat PI_GOAL_WORKER as authority", () => {
    process.env.PI_GOAL_WORKER = "1";
    runInWorkspace(ws, () => {
      expect(hasHumanInput(sessionA)).toBe(false);
      expect(hasGoalRound(sessionA, { goalId: "g", revision: 1, round: 1 })).toBe(false);
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
      setGoalRoundPending(sessionA, pendingA);
      expect(hasGoalRound(sessionA, pendingA)).toBe(true);
      expect(hasGoalRound(sessionA, { goalId: "g", revision: 2, round: 2 })).toBe(false);
      clearGoalTurnMarks(sessionA);
      expect(hasGoalRound(sessionA, pendingA)).toBe(false);
    });
  });

  it("does not let session B see session A's human mark", () => {
    setGoalHumanInput(sessionA);
    expect(hasHumanInput(sessionA)).toBe(true);
    expect(hasHumanInput(sessionB)).toBe(false);
  });

  it("does not let session B clear session A's pending round", () => {
    setGoalRoundPending(sessionA, pendingA);
    setGoalRoundPending(sessionB, { goalId: "other", revision: 1, round: 1 });
    clearGoalTurnMarks(sessionB);
    expect(hasGoalRound(sessionA, pendingA)).toBe(true);
    expect(hasGoalRound(sessionB, { goalId: "other", revision: 1, round: 1 })).toBe(false);
  });
});
