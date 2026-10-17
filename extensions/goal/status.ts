import { foldGoal } from "./fold.js";
import { listGoalHistory } from "./history.js";
import type { GoalActivation, GoalSnapshot } from "./types.js";

export const GOAL_STATUS_SCHEMA_VERSION = 1;

// 武装态只在内存里（不落盘）。挂在 globalThis 上：扩展经 jiti 加载、宿主直接 import，
// 两份模块实例看到的是同一张表，宿主补拉 Goal 时才能读到真实的 armed / disarmed。
const ACTIVATIONS_KEY = Symbol.for("gren.goal.activations");

function activations(): Map<string, GoalActivation> {
  const slot = globalThis as unknown as Record<symbol, Map<string, GoalActivation> | undefined>;
  let map = slot[ACTIVATIONS_KEY];
  if (!map) {
    map = new Map();
    slot[ACTIVATIONS_KEY] = map;
  }
  return map;
}

export function getActivation(sessionId: string): GoalActivation {
  return activations().get(sessionId) ?? "disarmed";
}

export function setActivation(sessionId: string, activation: GoalActivation): void {
  activations().set(sessionId, activation);
}

export function __resetGoalActivationsForTest(): void {
  activations().clear();
}

export interface GoalStatusEnvelope {
  schemaVersion: typeof GOAL_STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspace?: string;
  snapshot: (GoalSnapshot & { activation: GoalActivation }) | null;
  history: ReturnType<typeof listGoalHistory>;
}

/**
 * setStatus("goal") 推送和宿主按会话补拉共用的形状。渲染层只认这一种信封，
 * 推送丢了（窗口还没就绪、冷启动）也能靠补拉得到同一份投影。
 */
export function buildGoalStatus(input: { entries: unknown[]; sessionId: string; workspace?: string }): GoalStatusEnvelope {
  const snapshot = foldGoal(input.entries);
  return {
    schemaVersion: GOAL_STATUS_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    snapshot: snapshot ? { ...snapshot, activation: getActivation(input.sessionId) } : null,
    history: listGoalHistory(input.entries),
  };
}
