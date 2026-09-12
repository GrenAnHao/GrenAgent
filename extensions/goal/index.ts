import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearGoalTurnMarks, setGoalHumanInput } from "./auth.js";
import { parseGoalArgs } from "./parse.js";
import { formatGoalReceipt } from "./receipt.js";
import {
  clearGoal,
  createGoal,
  currentStatusSnapshot,
  editGoal,
  onSessionStart,
  pauseGoal,
  pushStatus,
  resumeGoal,
} from "./session.js";
import type { GoalSnapshot } from "./types.js";

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

// 任务 6 从 agent_end 读取；此处不发消息、不重入。
let lastAssistantStopReason: unknown;

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
        if (parsed.type === "create") {
          ctx.ui.notify(receiptOf(ctx, createGoal(pi, ctx, parsed.condition)), "info");
          return;
        }
        if (parsed.type === "edit") {
          ctx.ui.notify(receiptOf(ctx, editGoal(pi, ctx, parsed.condition)), "info");
          return;
        }
        if (parsed.type === "pause") {
          ctx.ui.notify(receiptOf(ctx, pauseGoal(pi, ctx)), "info");
          return;
        }
        if (parsed.type === "resume") {
          ctx.ui.notify(receiptOf(ctx, resumeGoal(pi, ctx)), "info");
          return;
        }
        clearGoal(pi, ctx);
        ctx.ui.notify("已清除目标。", "info");
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

  pi.on("input", async (event) => {
    if (event.source === "interactive" || event.source === "rpc") {
      setGoalHumanInput();
    }
    return { action: "continue" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    onSessionStart(ctx);
  });

  pi.on("agent_end", async (event) => {
    const messages = Array.isArray((event as { messages?: unknown }).messages)
      ? (event as { messages: Array<{ role?: unknown; stopReason?: unknown }> }).messages
      : [];
    for (const message of messages) {
      if (message?.role === "assistant") {
        lastAssistantStopReason = message.stopReason;
      }
    }
  });

  pi.on("agent_settled", async () => {
    clearGoalTurnMarks();
  });
}

void lastAssistantStopReason;
