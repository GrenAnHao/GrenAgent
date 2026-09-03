// goal: set a session completion condition AND immediately drive the agent to
// pursue it (the condition becomes a triggered user turn). On agent_end an
// independent judge decides whether it is actually met; if not, re-enter with
// the reason until met / react cap / user abort. Pausing suspends judging and
// re-entry. Fail-open on any judge failure so a flaky judge never traps the user.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { judge } from "./judge.js";
import { type GoalState, restoreFromEntries } from "./state.js";
import { desktopControl, type DesktopControlPort } from "../_shared/desktop-control.js";

const enabled = () => (getConfig("GOAL_ENABLED") ?? "1") !== "0";
const maxReact = () => Number(getConfig("GOAL_MAX_REACT") ?? "12") || 12;
const goalModel = () => getConfig("GOAL_MODEL");

export const pluginManifest = {
  id: "goal",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["agent", "ui", "event-subscriber"],
  permissions: { interaction: "auto" },
} as const;

export default function (pi: ExtensionAPI, control: DesktopControlPort = desktopControl()) {
  let state: GoalState | undefined;

  const persist = () => pi.appendEntry("goal", state ?? null);

  // 推送结构化状态给前端（pill 渲染需要 condition + paused + react）。
  const setStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus(
      "goal",
      state
        ? JSON.stringify({ condition: state.condition, paused: state.paused, react: state.react })
        : undefined,
    );

  const makeAsk = (ctx: ExtensionContext): AskFn | undefined => {
    const model = resolveModel(
      ctx.model as never,
      (ctx.modelRegistry ?? { find: () => undefined }) as never,
      goalModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, ctx.signal);
  };

  const clear = (ctx: ExtensionContext) => {
    state = undefined;
    persist();
    setStatus(ctx);
  };

  pi.registerCommand("goal", {
    description: "设定会话目标并驱动执行：/goal <条件> | /goal pause | /goal resume | /goal clear",
    handler: async (args, ctx) => {
      const text = args.trim();

      if (text === "" || text === "clear" || text === "reset") {
        clear(ctx);
        ctx.ui.notify("已清除目标。", "info");
        return;
      }

      if (text === "pause") {
        if (!state) {
          ctx.ui.notify("当前没有生效的目标。", "warning");
          return;
        }
        state.paused = true;
        persist();
        setStatus(ctx);
        ctx.ui.notify("目标已暂停，期间不再自动催进度。", "info");
        return;
      }

      if (text === "resume") {
        if (!state) {
          ctx.ui.notify("当前没有生效的目标。", "warning");
          return;
        }
        state.paused = false;
        persist();
        setStatus(ctx);
        ctx.ui.notify("目标已恢复。", "info");
        return;
      }

      // 设定（或覆盖）目标，并立刻把条件作为一轮用户消息驱动 agent 开始执行。
      state = { condition: text, react: 0, paused: false };
      persist();
      setStatus(ctx);
      ctx.ui.notify(`已设定目标并开始执行：${text}`, "info");
      await queueGoalTurn(pi, control, ctx, { customType: "goal-start", content: text, display: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreFromEntries(ctx.sessionManager.getEntries() as never);
    setStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled() || !state || state.paused) return;
    if (ctx.signal?.aborted) return; // user abort → do not re-enter

    const ask = makeAsk(ctx);
    if (!ask) {
      ctx.ui.notify("Goal: 无可用裁判模型，已放行。", "warning");
      clear(ctx);
      return;
    }

    const verdict = await judge(ask, event.messages as unknown[], state.condition);
    if (verdict.ok) {
      ctx.ui.notify(`目标达成：${state.condition}`, "info");
      clear(ctx);
      return;
    }
    if (state.react >= maxReact()) {
      ctx.ui.notify(`Goal: 已达重入上限(${maxReact()})，停止。最后判定：${verdict.reason}`, "warning");
      clear(ctx);
      return;
    }
    state.react += 1;
    persist();
    setStatus(ctx);
    await queueGoalTurn(pi, control, ctx, {
        customType: "goal-reentry",
        content: `目标尚未达成：${verdict.reason}\n请继续完成目标：${state.condition}`,
        display: true,
    });
  });
}

async function queueGoalTurn(
  pi: Pick<ExtensionAPI, 'sendMessage'>,
  control: DesktopControlPort,
  ctx: ExtensionContext,
  message: { customType: string; content: string; display: true },
): Promise<void> {
  try {
    await control.request('turn.start', {
      workspace: ctx.cwd,
      input: message.content,
      permissionProfile: getConfig('PI_PERMISSION_PROFILE') ?? 'workspace',
    });
    pi.sendMessage(message, { triggerTurn: false });
  } catch {
    pi.sendMessage(message, { triggerTurn: true });
  }
}
