import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryClient } from "../memory/client.js";
import { registerGoalTools } from "./tools.js";
import type { GoalSnapshot } from "./contracts.js";

export const pluginManifest = {
  id: "goal",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["agent", "tool", "ui", "event-subscriber"],
  permissions: { interaction: "auto" },
} as const;

type GoalPort = Pick<MemoryClient, "request">;

function scope(ctx: ExtensionContext): { sessionId: string; workspace: string } {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) throw new Error("SESSION_NOT_BOUND");
  return { sessionId, workspace: ctx.cwd };
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  ctx.ui.notify(code || (error instanceof Error ? error.message : "Goal 请求失败"), "warning");
}

function checkedSnapshot(value: GoalSnapshot, requestScope: { sessionId: string; workspace: string }, expected?: { goalId: string; revision: number }): GoalSnapshot {
  if (value.sessionId !== requestScope.sessionId || value.workspace !== requestScope.workspace) throw new Error("GOAL_SCOPE_MISMATCH");
  if (expected && (value.goalId !== expected.goalId || value.revision !== expected.revision + 1)) throw new Error("VERSION_CONFLICT");
  return value;
}

export default function (pi: ExtensionAPI, clientOrControl?: unknown, injectedClient?: GoalPort) {
  // The second argument was historically a desktop control port. Accept a
  // request-capable object there as a test/embedding injection point while
  // keeping that legacy call shape source-compatible.
  const client: GoalPort = injectedClient
    ?? (clientOrControl && typeof (clientOrControl as { request?: unknown }).request === "function"
      ? clientOrControl as GoalPort
      : new MemoryClient());
  registerGoalTools(pi, client);
  let cached: GoalSnapshot | undefined;

  const pushStatus = (ctx: ExtensionContext) => {
    const snapshot = cached;
    ctx.ui.setStatus(
      "goal",
      snapshot
        ? JSON.stringify({ condition: snapshot.condition, paused: snapshot.status === "paused", status: snapshot.status, revision: snapshot.revision, goalId: snapshot.goalId })
        : undefined,
    );
  };

  const read = async (ctx: ExtensionContext): Promise<GoalSnapshot | undefined> => {
    const requestScope = scope(ctx);
    const value = await client.request<GoalSnapshot | undefined>("goal.get", requestScope);
    if (value && (value.sessionId !== requestScope.sessionId || value.workspace !== requestScope.workspace)) throw new Error("GOAL_SCOPE_MISMATCH");
    cached = value;
    pushStatus(ctx);
    return value;
  };

  pi.registerCommand("goal", {
    description: "设定会话目标：/goal <条件> | /goal pause | /goal resume | /goal clear",
    handler: async (args, ctx) => {
      const text = args.trim();
      try {
        const current = await read(ctx);
        if (text === "" || text === "clear" || text === "reset") {
          if (!current) { ctx.ui.notify("当前没有生效的目标。", "warning"); return; }
          const requestScope = scope(ctx);
          cached = checkedSnapshot(await client.request<GoalSnapshot>("goal.update", { ...requestScope, goalId: current.goalId, revision: current.revision, action: "clear" }), requestScope, current);
          pushStatus(ctx);
          ctx.ui.notify("已清除目标。", "info");
          return;
        }
        if (text === "pause" || text === "resume") {
          if (!current) { ctx.ui.notify("当前没有生效的目标。", "warning"); return; }
          const requestScope = scope(ctx);
          cached = checkedSnapshot(await client.request<GoalSnapshot>("goal.update", { ...requestScope, goalId: current.goalId, revision: current.revision, action: text }), requestScope, current);
          pushStatus(ctx);
          ctx.ui.notify(text === "pause" ? "目标已暂停。" : "目标已恢复。", "info");
          return;
        }
        if (text.length > 4000) throw new Error("INVALID_PARAMS");
        const requestScope = scope(ctx);
        cached = checkedSnapshot(await client.request<GoalSnapshot>("goal.create", { ...requestScope, condition: text, continuousIntentEvidence: text }), requestScope);
        pushStatus(ctx);
        ctx.ui.notify(`已设定目标：${text}`, "info");
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try { await read(ctx); } catch { cached = undefined; pushStatus(ctx); }
  });

  // GoalCoordinator owns judging, retries, and turn scheduling. The extension
  // deliberately performs no recursive sendMessage/turn.start work here.
  pi.on("agent_end", async () => undefined);
}
