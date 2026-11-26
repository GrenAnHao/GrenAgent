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

interface GoalOwner { epoch: string; sequence: number; unavailable?: string; stoppedAt?: string }
const OWNERS_KEY = Symbol.for("gren.goal.status-owners");
function owners(): Map<string, GoalOwner> {
  const slot = globalThis as unknown as Record<symbol, Map<string, GoalOwner> | undefined>;
  return slot[OWNERS_KEY] ??= new Map();
}

/** Called only on a live owner lifecycle, never for an offline read. */
export function beginGoalOwner(sessionId: string): string {
  const epoch = crypto.randomUUID();
  owners().set(sessionId, { epoch, sequence: 0 });
  setActivation(sessionId, "disarmed");
  return epoch;
}

export function endGoalOwner(sessionId: string): void {
  owners().delete(sessionId);
  activations().delete(sessionId);
}

export function getGoalOwnerEpoch(sessionId: string): string | undefined {
  return owners().get(sessionId)?.epoch;
}

export function setGoalOwnerUnavailable(sessionId: string, code: string): void {
  const owner = owners().get(sessionId);
  if (!owner) return;
  owner.unavailable = code;
  owner.stoppedAt ??= new Date().toISOString();
  setActivation(sessionId, "disarmed");
}

export function getGoalOwnerStoppedAt(sessionId: string): string | undefined {
  return owners().get(sessionId)?.stoppedAt;
}

export function clearGoalOwnerUnavailable(sessionId: string): void {
  const owner = owners().get(sessionId);
  if (!owner) return;
  delete owner.unavailable;
  delete owner.stoppedAt;
}

export function __resetGoalActivationsForTest(): void {
  activations().clear();
  owners().clear();
}

export interface GoalStatusEnvelope {
  schemaVersion: typeof GOAL_STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspace?: string;
  source?: "live" | "offline";
  ownerEpoch?: string;
  sequence?: number;
  unavailable?: string;
  snapshot: (GoalSnapshot & { activation: GoalActivation }) | null;
  history: ReturnType<typeof listGoalHistory>;
}

/**
 * setStatus("goal") 推送和宿主按会话补拉共用的形状。渲染层只认这一种信封，
 * 推送丢了（窗口还没就绪、冷启动）也能靠补拉得到同一份投影。
 */
export function buildGoalStatus(input: { entries: unknown[]; sessionId: string; workspace?: string; source?: "live" | "offline" }): GoalStatusEnvelope {
  const snapshot = foldGoal(input.entries);
  const source = input.source ?? "live";
  let owner = source === "live" ? owners().get(input.sessionId) : undefined;
  if (source === "live" && !owner) {
    owner = { epoch: crypto.randomUUID(), sequence: 0 };
    owners().set(input.sessionId, owner);
  }
  // The entire envelope, including a clear tombstone, has a watermark.
  const watermark = owner ? { ownerEpoch: owner.epoch, sequence: ++owner.sequence } : {};
  const exhausted = source === "offline" && snapshot && snapshot.runRoundsStarted >= snapshot.maxRounds;
  // An unavailable projection freezes the UI clock without inventing a durable
  // pause event. The disk snapshot remains unchanged and the failure explicit.
  let projected = snapshot;
  if (snapshot?.runStartedAt && owner?.stoppedAt) {
    const { runStartedAt, ...rest } = snapshot;
    const elapsed = Date.parse(owner.stoppedAt) - Date.parse(runStartedAt);
    projected = { ...rest, ranMs: snapshot.ranMs + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0) };
  }
  return {
    schemaVersion: GOAL_STATUS_SCHEMA_VERSION,
    sessionId: input.sessionId,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    source,
    ...watermark,
    ...(owner?.unavailable ? { unavailable: owner.unavailable } : {}),
    snapshot: projected ? {
      ...projected,
      activation: source === "offline" || exhausted ? "disarmed" : getActivation(input.sessionId),
      ...(exhausted && projected.status === "active" ? { pauseReason: { code: "max-rounds" as const } } : {}),
    } : null,
    history: listGoalHistory(input.entries),
  };
}
