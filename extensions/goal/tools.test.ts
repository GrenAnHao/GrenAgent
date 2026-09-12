import { afterEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  __resetGoalAuthForTest,
  clearGoalTurnMarks,
  setGoalHumanInput,
  setGoalRoundPending,
} from "./auth.js";
import { readSnapshot, writeEvent } from "./session.js";
import { registerGoalTools } from "./tools.js";

type Def = { name: string; execute: (...args: unknown[]) => Promise<{ details?: unknown }> };

interface GoalEntry {
  type: string;
  customType: string;
  data: {
    kind: string;
    goalId?: string;
    revision?: number;
    at?: string;
    payload?: Record<string, unknown>;
  };
}

const ws = { origin: "main" as const, workspace: "/repo", cwd: "/repo", config: {} };

function setup() {
  const entries: GoalEntry[] = [];
  const defs: Def[] = [];
  const pi = {
    appendEntry: (t: string, d: unknown) => {
      entries.push({ type: "custom", customType: t, data: d as GoalEntry["data"] });
    },
    registerTool: (d: Def) => {
      defs.push(d);
    },
  };
  registerGoalTools(pi as never);
  const ctx = {
    cwd: "/repo",
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "session-a",
    },
  };
  const byName = Object.fromEntries(defs.map((d) => [d.name, d])) as Record<string, Def>;
  return { defs, ctx, entries, pi, byName };
}

function exec(def: Def, ctx: unknown, params: Record<string, unknown> = {}) {
  return def.execute("id", params, undefined, undefined, ctx);
}

afterEach(() => {
  __resetGoalAuthForTest();
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_IS_SUBAGENT;
});

describe("goal tools", () => {
  it("registers exactly get_goal, create_goal, and update_goal", () => {
    const { defs } = setup();
    expect(defs.map((d) => d.name)).toEqual(["get_goal", "create_goal", "update_goal"]);
  });

  it("rejects create and human-gated updates without a human mark", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      await expect(exec(byName.create_goal, ctx, { condition: "x" })).rejects.toThrow("GOAL_TOOL_HUMAN");
      await expect(exec(byName.update_goal, ctx, { goalId: "g", revision: 1, action: "edit", condition: "y" })).rejects.toThrow(
        "GOAL_TOOL_HUMAN",
      );
      await expect(exec(byName.update_goal, ctx, { goalId: "g", revision: 1, action: "pause" })).rejects.toThrow("GOAL_TOOL_HUMAN");
      await expect(exec(byName.update_goal, ctx, { goalId: "g", revision: 1, action: "resume" })).rejects.toThrow("GOAL_TOOL_HUMAN");
    });
  });

  it("creates a goal after setGoalHumanInput and returns goalId, revision, activation", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const result = await exec(byName.create_goal, ctx, { condition: "x" });
      expect(result.details).toMatchObject({
        goalId: expect.any(String),
        revision: 1,
        activation: "armed",
      });
    });
  });

  it("rejects model resume on a paused goal even with a human mark", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const details = created.details as { goalId: string; revision: number };
      const paused = await exec(byName.update_goal, ctx, { goalId: details.goalId, revision: details.revision, action: "pause" });
      const pausedDetails = paused.details as { goalId: string; revision: number };
      await expect(
        exec(byName.update_goal, ctx, { goalId: pausedDetails.goalId, revision: pausedDetails.revision, action: "resume" }),
      ).rejects.toThrow("GOAL_TOOL_RESUME_PAUSED");
    });
  });

  it("allows complete only when a matching Goal Round is pending", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const createdDetails = created.details as { goalId: string; revision: number };
      clearGoalTurnMarks();

      await expect(
        exec(byName.update_goal, ctx, { goalId: createdDetails.goalId, revision: createdDetails.revision, action: "complete" }),
      ).rejects.toThrow("GOAL_TOOL_ROUND");

      writeEvent(pi as never, ctx as never, {
        kind: "round",
        goalId: createdDetails.goalId,
        revision: createdDetails.revision + 1,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: 1 },
      });
      const snapshot = readSnapshot(ctx as never);
      expect(snapshot?.roundsStarted).toBe(1);
      setGoalRoundPending({ goalId: snapshot!.goalId, revision: snapshot!.revision, round: snapshot!.roundsStarted });
      const completed = await exec(byName.update_goal, ctx, {
        goalId: snapshot!.goalId,
        revision: snapshot!.revision,
        action: "complete",
      });
      expect(completed.details).toMatchObject({ status: "complete", revision: snapshot!.revision + 1 });
    });
  });

  it("rejects complete and blocked after clearGoalTurnMarks drops the old round", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const createdDetails = created.details as { goalId: string; revision: number };
      writeEvent(pi as never, ctx as never, {
        kind: "round",
        goalId: createdDetails.goalId,
        revision: createdDetails.revision + 1,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: 3 },
      });
      const snapshot = readSnapshot(ctx as never);
      setGoalRoundPending({ goalId: snapshot!.goalId, revision: snapshot!.revision, round: snapshot!.roundsStarted });
      clearGoalTurnMarks();
      await expect(
        exec(byName.update_goal, ctx, { goalId: snapshot!.goalId, revision: snapshot!.revision, action: "complete" }),
      ).rejects.toThrow("GOAL_TOOL_ROUND");
      await expect(
        exec(byName.update_goal, ctx, {
          goalId: snapshot!.goalId,
          revision: snapshot!.revision,
          action: "blocked",
          blockedReason: { message: "缺密钥" },
        }),
      ).rejects.toThrow("GOAL_TOOL_ROUND");
    });
  });

  it("rejects blocked below the round threshold and accepts a nonempty blockedReason at or above it", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const createdDetails = created.details as { goalId: string; revision: number };
      await expect(
        exec(byName.update_goal, ctx, {
          goalId: createdDetails.goalId,
          revision: createdDetails.revision,
          action: "blocked",
          blockedReason: { message: "太早" },
        }),
      ).rejects.toThrow("GOAL_TOOL_BLOCKED");

      writeEvent(pi as never, ctx as never, {
        kind: "round",
        goalId: createdDetails.goalId,
        revision: createdDetails.revision + 1,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: 3 },
      });
      const snapshot = readSnapshot(ctx as never);
      expect(snapshot?.roundsStarted).toBe(3);
      setGoalRoundPending({ goalId: snapshot!.goalId, revision: snapshot!.revision, round: snapshot!.roundsStarted });
      await expect(
        exec(byName.update_goal, ctx, {
          goalId: snapshot!.goalId,
          revision: snapshot!.revision,
          action: "blocked",
          blockedReason: { message: "" },
        }),
      ).rejects.toThrow("GOAL_TOOL_BLOCKED");
      const blocked = await exec(byName.update_goal, ctx, {
        goalId: snapshot!.goalId,
        revision: snapshot!.revision,
        action: "blocked",
        blockedReason: { message: "缺密钥" },
      });
      expect(blocked.details).toMatchObject({
        status: "blocked",
        blockedReason: { code: "model-reported", message: "缺密钥" },
      });
    });
  });

  it("returns null details from get_goal when no goal exists", async () => {
    const { byName, ctx } = setup();
    const result = await exec(byName.get_goal, ctx);
    expect(result.details).toBeNull();
  });

  it("does not let PI_GOAL_WORKER authorize create", async () => {
    process.env.PI_GOAL_WORKER = "1";
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      await expect(exec(byName.create_goal, ctx, { condition: "x" })).rejects.toThrow("GOAL_TOOL_HUMAN");
    });
  });

  it("rejects update_goal when revision does not match the current snapshot", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput();
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const details = created.details as { goalId: string };
      await expect(
        exec(byName.update_goal, ctx, { goalId: details.goalId, revision: 99, action: "edit", condition: "y" }),
      ).rejects.toThrow("VERSION_CONFLICT");
    });
  });
});
