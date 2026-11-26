import { randomUUID } from "node:crypto";
import { resolveToolOrigin } from "../_shared/workspace-context.js";

/** An execution slot remains occupied even after its permission has been revoked. */
export interface GoalRoundRef {
  sessionId: string;
  goalId: string;
  runNumber: number;
  roundId: string;
  conditionRevision: number;
  round: number;
}

const humanMarks = new Map<string, true>();
const occupied = new Map<string, GoalRoundRef>();
const grants = new Map<string, GoalRoundRef>();
const calls = new Map<string, GoalRoundRef | null>();
const WORKSLOT_LISTENERS_KEY = Symbol.for('gren.goal.workslot-listeners');
function workslotListeners(): Map<string, Set<(ref: GoalRoundRef | undefined) => void>> {
  const root = globalThis as unknown as Record<symbol, Map<string, Set<(ref: GoalRoundRef | undefined) => void>> | undefined>;
  return root[WORKSLOT_LISTENERS_KEY] ??= new Map();
}
export function subscribeGoalWorkslot(sessionId: string, listener: (ref: GoalRoundRef | undefined) => void): () => void {
  const listeners = workslotListeners().get(sessionId) ?? new Set();
  listeners.add(listener);
  workslotListeners().set(sessionId, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) workslotListeners().delete(sessionId); };
}
function publishWorkslot(sessionId: string, ref: GoalRoundRef | undefined): void {
  for (const listener of workslotListeners().get(sessionId) ?? []) {
    // Telemetry must never throw back into a committed Goal event or slot release.
    try { listener(ref); } catch { /* no confirmed crash fence if delivery fails */ }
  }
}

export function __resetGoalAuthForTest(): void {
  humanMarks.clear();
  occupied.clear();
  grants.clear();
  calls.clear();
  workslotListeners().clear();
}

export function setGoalHumanInput(sessionId: string): void { humanMarks.set(sessionId, true); }
export function hasHumanInput(sessionId: string): boolean { return humanMarks.has(sessionId); }

/** Never replace a live runner's slot, even when an edit has revoked its grant. */
export function occupyGoalRound(sessionId: string, ref: Omit<GoalRoundRef, "sessionId" | "roundId">): GoalRoundRef | undefined {
  if (occupied.has(sessionId)) return undefined;
  const token = Object.freeze({ ...ref, sessionId, roundId: randomUUID() });
  occupied.set(sessionId, token);
  grants.set(sessionId, token);
  publishWorkslot(sessionId, token);
  return token;
}

export function occupiedGoalRound(sessionId: string): GoalRoundRef | undefined { return occupied.get(sessionId); }
export function revokeGoalRound(sessionId: string): void { grants.delete(sessionId); }
export function releaseGoalRound(sessionId: string, roundId: string): boolean {
  if (occupied.get(sessionId)?.roundId !== roundId) return false;
  occupied.delete(sessionId);
  grants.delete(sessionId);
  publishWorkslot(sessionId, undefined);
  return true;
}

/** Capture at the SDK execution-start boundary, before any async tool work. */
export function captureGoalToolCall(sessionId: string, toolCallId: string, parentToolCallId?: string): void {
  const parent = parentToolCallId === undefined ? undefined : calls.get(parentToolCallId);
  const token = parentToolCallId === undefined ? grants.get(sessionId) : parent;
  calls.set(toolCallId, token?.sessionId === sessionId ? token : null);
}
export function forgetGoalToolCall(toolCallId: string): void { calls.delete(toolCallId); }

export function assertGoalToolRound(sessionId: string, toolCallId: string, snapshot: {
  goalId: string; runNumber: number; conditionRevision: number; status: string;
}): void {
  const ref = calls.get(toolCallId);
  const current = grants.get(sessionId);
  if (!ref || !current || current.roundId !== ref.roundId || ref.sessionId !== sessionId ||
    snapshot.status !== "active" || ref.goalId !== snapshot.goalId ||
    ref.runNumber !== snapshot.runNumber || ref.conditionRevision !== snapshot.conditionRevision) {
    throw new Error("GOAL_TOOL_ROUND_STALE");
  }
}

/** Settle removes only its own slot; a delayed old settlement cannot clear new work. */
export function clearGoalTurnMarks(sessionId: string, roundId?: string): void {
  humanMarks.delete(sessionId);
  if (roundId) releaseGoalRound(sessionId, roundId);
}

export function assertToolCaller(): void {
  if (resolveToolOrigin() === "subagent") throw new Error("GOAL_TOOL_ORIGIN");
}
