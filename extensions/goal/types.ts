export const GOAL_EVENT_KINDS = ["create", "edit", "pause", "resume", "complete", "blocked", "clear", "round"] as const;
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number];
export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type GoalActivation = "armed" | "disarmed";

export interface GoalEvent {
  kind: GoalEventKind;
  goalId: string;
  revision: number;
  at: string;
  payload: Record<string, unknown>;
}

export interface GoalBlockedReason {
  code: "model-reported";
  message: string;
}

export interface GoalSnapshot {
  goalId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsStarted: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  activation?: GoalActivation;
  blockedReason?: GoalBlockedReason;
}

export const DEFAULT_MAX_ROUNDS = 256;
export const GOAL_BLOCKED_MIN_ROUNDS = 3;
