import { afterEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  __resetGoalAuthForTest,
  clearGoalTurnMarks,
  captureGoalToolCall,
  occupiedGoalRound,
  setGoalHumanInput,
  occupyGoalRound,
} from "./auth.js";
import { readSnapshot, writeEvent } from "./session.js";
import { __resetGoalContinueForTest, recordGoalRunStart } from "./continue.js";
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

function setup(sessionId = "session-a") {
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
      getSessionId: () => sessionId,
    },
  };
  const byName = Object.fromEntries(defs.map((d) => [d.name, d])) as Record<string, Def>;
  return { defs, ctx, entries, pi, byName, sessionId };
}

function exec(def: Def, ctx: unknown, params: Record<string, unknown> = {}) {
  const sessionId = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  captureGoalToolCall(sessionId, "id");
  return def.execute("id", params, undefined, undefined, ctx);
}
function arm(sessionId: string, snapshot: NonNullable<ReturnType<typeof readSnapshot>>) {
  return occupyGoalRound(sessionId, {
    goalId: snapshot.goalId, runNumber: snapshot.runNumber,
    conditionRevision: snapshot.conditionRevision, round: snapshot.roundsStarted,
  });
}

afterEach(() => {
  __resetGoalAuthForTest();
  __resetGoalContinueForTest();
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
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const result = await exec(byName.create_goal, ctx, { condition: "x" });
      expect(result.details).toMatchObject({
        goalId: expect.any(String),
        revision: 1,
        activation: "armed",
      });
    });
  });

  it("registers the initial condition when a human-authorized model creates a goal mid-run", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      recordGoalRunStart(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "new condition" });
      const snapshot = created.details as { goalId: string; revision: number };
      expect(occupiedGoalRound(ctx.sessionManager.getSessionId())).toMatchObject({ goalId: snapshot.goalId, conditionRevision: 1, round: 0 });
      const completed = await exec(byName.update_goal, ctx, { goalId: snapshot.goalId, revision: snapshot.revision, action: "complete" });
      expect(completed.details).toMatchObject({ status: "complete" });
    });
  });

  it("rejects model resume on a paused goal even with a human mark", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const details = created.details as { goalId: string; revision: number };
      const paused = await exec(byName.update_goal, ctx, { goalId: details.goalId, revision: details.revision, action: "pause" });
      const pausedDetails = paused.details as { goalId: string; revision: number };
      await expect(
        exec(byName.update_goal, ctx, { goalId: pausedDetails.goalId, revision: pausedDetails.revision, action: "resume" }),
      ).rejects.toThrow("GOAL_TOOL_RESUME_PAUSED");
    });
  });

  it("never lets a model restart exhausted budget with a human mark", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "work", maxRounds: 1 });
      const first = created.details as { goalId: string; revision: number };
      writeEvent(pi as never, ctx as never, { kind: "round", goalId: first.goalId,
        revision: first.revision + 1, at: "2026-09-13T00:00:00.000Z", payload: { round: 1, runNumber: 1, runRound: 1 } });
      const current = readSnapshot(ctx as never)!;
      await expect(exec(byName.update_goal, ctx, { goalId: current.goalId, revision: current.revision, action: "resume" }))
        .rejects.toThrow("GOAL_TOOL_RESUME_PAUSED");
      expect(readSnapshot(ctx as never)).toMatchObject({ runNumber: 1, runRoundsStarted: 1 });
    });
  });

  it("allows complete only when a matching Goal Round is pending", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const createdDetails = created.details as { goalId: string; revision: number };
      clearGoalTurnMarks(ctx.sessionManager.getSessionId());

      await expect(
        exec(byName.update_goal, ctx, { goalId: createdDetails.goalId, revision: createdDetails.revision, action: "complete" }),
      ).rejects.toThrow("GOAL_TOOL_ROUND_STALE");

      writeEvent(pi as never, ctx as never, {
        kind: "round",
        goalId: createdDetails.goalId,
        revision: createdDetails.revision + 1,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: 1 },
      });
      const snapshot = readSnapshot(ctx as never);
      expect(snapshot?.roundsStarted).toBe(1);
      arm(ctx.sessionManager.getSessionId(), snapshot!);
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
      setGoalHumanInput(ctx.sessionManager.getSessionId());
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
      const ref = arm(ctx.sessionManager.getSessionId(), snapshot!);
      clearGoalTurnMarks(ctx.sessionManager.getSessionId(), ref?.roundId);
      await expect(
        exec(byName.update_goal, ctx, { goalId: snapshot!.goalId, revision: snapshot!.revision, action: "complete" }),
      ).rejects.toThrow("GOAL_TOOL_ROUND_STALE");
      await expect(
        exec(byName.update_goal, ctx, {
          goalId: snapshot!.goalId,
          revision: snapshot!.revision,
          action: "blocked",
          blockedReason: { message: "缺密钥" },
        }),
      ).rejects.toThrow("GOAL_TOOL_ROUND_STALE");
    });
  });

  it("rejects blocked below the round threshold and accepts a nonempty blockedReason at or above it", async () => {
    const { byName, ctx, pi } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const createdDetails = created.details as { goalId: string; revision: number };
      await expect(
        exec(byName.update_goal, ctx, {
          goalId: createdDetails.goalId,
          revision: createdDetails.revision,
          action: "blocked",
          blockedReason: { message: "太早" },
        }),
      ).rejects.toThrow("GOAL_TOOL_ROUND_STALE");

      writeEvent(pi as never, ctx as never, {
        kind: "round",
        goalId: createdDetails.goalId,
        revision: createdDetails.revision + 1,
        at: "2026-09-13T00:00:00.000Z",
        payload: { round: 3 },
      });
      const snapshot = readSnapshot(ctx as never);
      expect(snapshot?.roundsStarted).toBe(3);
      arm(ctx.sessionManager.getSessionId(), snapshot!);
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

  it("does not let session A's human mark authorize session B create_goal", async () => {
    const a = setup("session-a");
    const b = setup("session-b");
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(a.sessionId);
      await expect(exec(b.byName.create_goal, b.ctx, { condition: "x" })).rejects.toThrow("GOAL_TOOL_HUMAN");
    });
  });

  it("does not let session B settle clear session A's pending round", async () => {
    const a = setup("session-a");
    const snapshot = { goalId: "g-a", runNumber: 1, conditionRevision: 1, round: 1 };
    const ref = occupyGoalRound(a.sessionId, snapshot);
    clearGoalTurnMarks("session-b");
    expect(occupiedGoalRound(a.sessionId)).toEqual(ref);
  });

  it("rejects update_goal when revision does not match the current snapshot", async () => {
    const { byName, ctx } = setup();
    await runInWorkspace(ws, async () => {
      setGoalHumanInput(ctx.sessionManager.getSessionId());
      const created = await exec(byName.create_goal, ctx, { condition: "x" });
      const details = created.details as { goalId: string };
      await expect(
        exec(byName.update_goal, ctx, { goalId: details.goalId, revision: 99, action: "edit", condition: "y" }),
      ).rejects.toThrow("VERSION_CONFLICT");
    });
  });
});
