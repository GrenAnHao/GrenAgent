import { resolveToolOrigin } from "../_shared/workspace-context.js";

export interface GoalRoundRef {
  goalId: string;
  revision: number;
  round: number;
}

const humanMarks = new Map<string, true>();
const pendingRounds = new Map<string, GoalRoundRef>();

function authKey(sessionId: string): string {
  return sessionId;
}

export function __resetGoalAuthForTest(): void {
  humanMarks.clear();
  pendingRounds.clear();
}

export function setGoalHumanInput(sessionId: string): void {
  humanMarks.set(authKey(sessionId), true);
}

export function setGoalRoundPending(sessionId: string, ref: GoalRoundRef): void {
  pendingRounds.set(authKey(sessionId), { ...ref });
}

export function clearGoalTurnMarks(sessionId: string): void {
  const key = authKey(sessionId);
  humanMarks.delete(key);
  pendingRounds.delete(key);
}

export function hasHumanInput(sessionId: string): boolean {
  return humanMarks.has(authKey(sessionId));
}

export function hasGoalRound(sessionId: string, ref: GoalRoundRef): boolean {
  const pending = pendingRounds.get(authKey(sessionId));
  return !!pending
    && pending.goalId === ref.goalId
    && pending.revision === ref.revision
    && pending.round === ref.round;
}

export function assertToolCaller(): void {
  if (resolveToolOrigin() === "subagent") {
    throw new Error("GOAL_TOOL_ORIGIN");
  }
}
