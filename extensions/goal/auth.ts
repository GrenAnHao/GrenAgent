import { resolveToolOrigin } from "../_shared/workspace-context.js";

export interface GoalRoundRef {
  goalId: string;
  revision: number;
  round: number;
}

const humanMarks = new Map<string, true>();
const pendingRounds = new Map<string, GoalRoundRef>();

function authKey(): string {
  return process.cwd();
}

export function __resetGoalAuthForTest(): void {
  humanMarks.clear();
  pendingRounds.clear();
}

export function setGoalHumanInput(): void {
  humanMarks.set(authKey(), true);
}

export function setGoalRoundPending(ref: GoalRoundRef): void {
  pendingRounds.set(authKey(), { ...ref });
}

export function clearGoalTurnMarks(): void {
  const key = authKey();
  humanMarks.delete(key);
  pendingRounds.delete(key);
}

export function hasHumanInput(): boolean {
  return humanMarks.has(authKey());
}

export function hasGoalRound(ref: GoalRoundRef): boolean {
  const pending = pendingRounds.get(authKey());
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
