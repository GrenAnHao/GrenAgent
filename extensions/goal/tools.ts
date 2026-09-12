import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertToolCaller, hasGoalRound, hasHumanInput } from "./auth.js";
import {
  blockGoal,
  completeGoal,
  createGoal,
  currentStatusSnapshot,
  editGoal,
  pauseGoal,
  readSnapshot,
  resumeGoal,
} from "./session.js";
import { GOAL_BLOCKED_MIN_ROUNDS } from "./types.js";

const condition = Type.String({ minLength: 1, maxLength: 4000 });
const revision = Type.Integer({ minimum: 1 });

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: value == null ? "null" : JSON.stringify(value) }],
    details: value ?? null,
  };
}

function requireHuman(): void {
  if (!hasHumanInput()) throw new Error("GOAL_TOOL_HUMAN");
}

function requireRoundOrHuman(ctx: ExtensionContext): void {
  if (hasHumanInput()) return;
  const snapshot = readSnapshot(ctx);
  if (
    snapshot
    && hasGoalRound({ goalId: snapshot.goalId, revision: snapshot.revision, round: snapshot.roundsStarted })
  ) {
    return;
  }
  throw new Error("GOAL_TOOL_ROUND");
}

function requireCurrentRevision(ctx: ExtensionContext, goalId: string, expectedRevision: number) {
  const snapshot = readSnapshot(ctx);
  if (!snapshot || snapshot.goalId !== goalId || snapshot.revision !== expectedRevision) {
    throw new Error("VERSION_CONFLICT");
  }
  return snapshot;
}

export function registerGoalTools(pi: ExtensionAPI): void {
  if (typeof (pi as ExtensionAPI & { registerTool?: unknown }).registerTool !== "function") return;

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the Goal for the current session.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      return result(currentStatusSnapshot(ctx));
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a session Goal for continuous work.",
    parameters: Type.Object({
      condition,
      maxRounds: Type.Optional(revision),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      assertToolCaller();
      requireHuman();
      if (typeof params.condition !== "string" || params.condition.length === 0 || params.condition.length > 4000) {
        throw new Error("INVALID_PARAMS");
      }
      createGoal(pi, ctx, params.condition, typeof params.maxRounds === "number" ? params.maxRounds : undefined);
      return result(currentStatusSnapshot(ctx));
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Update the current session Goal.",
    parameters: Type.Object({
      goalId: Type.String({ minLength: 1 }),
      revision,
      action: Type.Union([
        Type.Literal("edit"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("complete"),
        Type.Literal("blocked"),
      ]),
      condition: Type.Optional(condition),
      blockedReason: Type.Optional(Type.Object({
        message: Type.String(),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      assertToolCaller();
      const action = params.action;
      if (action === "edit" || action === "pause" || action === "resume") {
        requireHuman();
      }
      if (action === "complete" || action === "blocked") {
        requireRoundOrHuman(ctx);
      }
      const snapshot = requireCurrentRevision(ctx, String(params.goalId ?? ""), Number(params.revision));
      if (action === "resume" && snapshot.status === "paused") {
        throw new Error("GOAL_TOOL_RESUME_PAUSED");
      }
      if (action === "edit") {
        if (typeof params.condition !== "string") throw new Error("INVALID_PARAMS");
        editGoal(pi, ctx, params.condition);
      } else if (action === "pause") {
        pauseGoal(pi, ctx);
      } else if (action === "resume") {
        resumeGoal(pi, ctx);
      } else if (action === "complete") {
        completeGoal(pi, ctx);
      } else if (action === "blocked") {
        const message = typeof params.blockedReason?.message === "string" ? params.blockedReason.message.trim() : "";
        if (snapshot.roundsStarted < GOAL_BLOCKED_MIN_ROUNDS || !message) {
          throw new Error("GOAL_TOOL_BLOCKED");
        }
        blockGoal(pi, ctx, params.blockedReason!.message);
      }
      return result(currentStatusSnapshot(ctx));
    },
  });
}
