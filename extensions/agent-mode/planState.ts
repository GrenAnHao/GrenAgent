// 每个会话当前绑定的 Plan（内存表）。agent-mode 扩展写，宿主（agent-host 进程里同一份模块）读：
// 手切模式时据此判断「有未确认的计划」并取消切换。持久化走会话条目，不在这里。
import type { AgentMode } from "./modes.js";
import { isUnconfirmed, type Plan } from "./plan.js";

const bySession = new Map<string, Plan>();

export function getSessionPlan(sessionId: string | undefined): Plan | undefined {
  return sessionId ? bySession.get(sessionId) : undefined;
}

export function setSessionPlan(sessionId: string | undefined, plan: Plan | undefined): void {
  if (!sessionId) return;
  if (plan) bySession.set(sessionId, plan);
  else bySession.delete(sessionId);
}

/** 拥有完整工具集、能直接动手的模式。未确认计划时不能手切进去，只能经侧栏确认执行。 */
export function isExecutingMode(mode: AgentMode): boolean {
  return mode === "agent" || mode === "debug" || mode === "brainstorm";
}

export const PLAN_UNCONFIRMED_MESSAGE =
  "当前会话有尚未确认的计划，不能直接切到执行模式。请在右侧计划面板点「确认执行」（会自动切到 Agent 并开跑），或先在面板里取消计划。";

/** 手切到 mode 是否要被取消：会话有未确认计划，且目标是能动手的模式。 */
export function planBlocksModeSwitch(sessionId: string | undefined, mode: AgentMode): boolean {
  return isExecutingMode(mode) && isUnconfirmed(getSessionPlan(sessionId));
}

/** 仅测试。 */
export function __resetPlanStateForTest(): void {
  bySession.clear();
}
