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

describe("goal tool auth", () => {
  it("rejects subagent origin", () => {
    process.env.PI_IS_SUBAGENT = "1";
    expect(() => assertToolCaller()).toThrow("GOAL_TOOL_ORIGIN");
  });

  it("does not treat PI_GOAL_WORKER as authority", () => {
    process.env.PI_GOAL_WORKER = "1";
    runInWorkspace(ws, () => {
      expect(hasHumanInput()).toBe(false);
      expect(hasGoalRound({ goalId: "g", revision: 1, round: 1 })).toBe(false);
    });
  });

  it("human mark lives until agent_settled", () => {
    runInWorkspace(ws, () => {
      setGoalHumanInput();
      expect(hasHumanInput()).toBe(true);
      clearGoalTurnMarks();
      expect(hasHumanInput()).toBe(false);
    });
  });

  it("pending round matches exactly and dies after settle", () => {
    runInWorkspace(ws, () => {
      setGoalRoundPending({ goalId: "g", revision: 2, round: 3 });
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 3 })).toBe(true);
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 2 })).toBe(false);
      clearGoalTurnMarks();
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 3 })).toBe(false);
    });
  });
});
