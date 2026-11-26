import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureGoalToolCall, forgetGoalToolCall, occupiedGoalRound, setGoalHumanInput } from "./auth.js";
import { getCompactionActivity } from "../_shared/compaction-activity.js";
import {
  clearGoalRunState,
  onAgentSettled,
  pauseAtGoalLimit,
  recordGoalCompactionFailure,
  recordGoalRunStart,
  recordRunStopReasons,
  startArmedGoalRound,
} from "./continue.js";
import { parseGoalArgs } from "./parse.js";
import { executeGoalCommandControl, registerGoalControl } from "./control.js";
import { formatGoalReceipt } from "./receipt.js";
import {
  currentStatusSnapshot,
  pushStatus,
  readSnapshot,
  sessionIdOf,
} from "./session.js";
import { registerGoalTools } from "./tools.js";
import type { GoalSnapshot } from "./types.js";
import { endGoalOwner } from "./status.js";
import { recoverGoalOwnerLoss } from './recover-owner-loss.js';

export const pluginManifest = {
  id: "goal",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["agent", "tool", "ui", "event-subscriber"],
  permissions: { interaction: "auto" },
} as const;

const NO_GOAL = "当前没有生效的目标。";
const MISSING_CONDITION = "缺少新的目标条件。";
const INVALID_PARAMS = "目标条件无效。";
const ALREADY_ACTIVE = "已有未完成的目标，请先 edit 或 clear。";

function receiptOf(ctx: ExtensionContext, snapshot: GoalSnapshot): string {
  return formatGoalReceipt({
    ...snapshot,
    activation: currentStatusSnapshot(ctx)?.activation ?? "disarmed",
  });
}

function notifyMissing(ctx: ExtensionContext, level: "warning" | "error"): void {
  ctx.ui.notify(NO_GOAL, level);
}

export default function (pi: ExtensionAPI) {
  registerGoalTools(pi);
  let unregisterControl: (() => void) | undefined;

  pi.registerCommand("goal", {
    description: "查询或管理会话目标。空参数查询；/goal <条件> 创建；/goal edit <条件> 编辑；/goal pause | resume | clear",
    handler: async (args, ctx) => {
      const parsed = parseGoalArgs(args);
      try {
        if (parsed.type === "error") {
          ctx.ui.notify(parsed.code === "MISSING_CONDITION" ? MISSING_CONDITION : INVALID_PARAMS, "error");
          return;
        }
        if (parsed.type === "query") {
          const snapshot = currentStatusSnapshot(ctx);
          if (!snapshot) {
            notifyMissing(ctx, "warning");
            return;
          }
          pushStatus(ctx);
          ctx.ui.notify(formatGoalReceipt(snapshot), "info");
          return;
        }
        const action = parsed.type;
        const result = await executeGoalCommandControl(pi, ctx, action,
          action === "create" || action === "edit" ? parsed.condition : undefined);
        if (result.outcome !== "committed") {
          ctx.ui.notify(result.message ?? `GOAL_CONTROL_${result.outcome.toUpperCase()}`, "error");
          return;
        }
        if (action === "clear") {
          ctx.ui.notify("已清除目标。", "info");
          return;
        }
        if (result.snapshot) ctx.ui.notify(receiptOf(ctx, result.snapshot), "info");
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "GOAL_MISSING") {
          notifyMissing(ctx, parsed.type === "edit" ? "error" : "warning");
          return;
        }
        if (code === "GOAL_ALREADY_ACTIVE") {
          ctx.ui.notify(ALREADY_ACTIVE, "error");
          return;
        }
        ctx.ui.notify(code || "Goal 请求失败", "error");
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "interactive" || event.source === "rpc") {
      setGoalHumanInput(sessionIdOf(ctx));
    }
    return { action: "continue" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    const mayStart = await recoverGoalOwnerLoss(pi, ctx);
    const snapshot = readSnapshot(ctx);
    if (mayStart && snapshot?.status === "active" && snapshot.runRoundsStarted >= snapshot.maxRounds) pauseAtGoalLimit(pi, ctx);
    unregisterControl = registerGoalControl(pi, ctx);
    if (mayStart) await startArmedGoalRound(pi, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    captureGoalToolCall(sessionIdOf(ctx), event.toolCallId, event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => { forgetGoalToolCall(event.toolCallId); });
  pi.on("session_compact_failed", (event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const origin = getCompactionActivity(sessionId)?.origin;
    if (!event.aborted && event.errorMessage && occupiedGoalRound(sessionId)
      && (event.reason === "threshold" || event.reason === "overflow" || origin === "policy-auto")) {
      recordGoalCompactionFailure(sessionId, event.errorMessage);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    unregisterControl?.();
    unregisterControl = undefined;
    clearGoalRunState(sessionIdOf(ctx));
    endGoalOwner(sessionIdOf(ctx));
  });

  pi.on("agent_start", (_event, ctx) => {
    recordGoalRunStart(sessionIdOf(ctx));
  });

  pi.on("agent_end", async (event, ctx) => {
    recordRunStopReasons(sessionIdOf(ctx), event.messages);
  });

  pi.on("agent_settled", async (event, ctx) => {
    await onAgentSettled(event, ctx, pi);
  });
}
