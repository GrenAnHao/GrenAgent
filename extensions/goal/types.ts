export const GOAL_EVENT_KINDS = ["create", "edit", "pause", "resume", "restart", "complete", "blocked", "clear", "round"] as const;
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

export interface GoalPauseReason {
  code: "request-error" | "runtime-error" | "user" | "max-rounds";
  /** Safe explanation only: never persist raw provider responses or credentials. */
  message?: string;
}

export interface GoalSnapshot {
  goalId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  /** Lifetime count; restarting a budget never resets this. */
  roundsStarted: number;
  runNumber: number;
  runRoundsStarted: number;
  conditionRevision: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  /** Completed running segments in ms. Pause / blocked / complete freeze this. */
  ranMs: number;
  /** Current running segment start; absent while frozen. */
  runStartedAt?: string;
  activation?: GoalActivation;
  blockedReason?: GoalBlockedReason;
  pauseReason?: GoalPauseReason;
}

export const DEFAULT_MAX_ROUNDS = 256;
export const GOAL_BLOCKED_MIN_ROUNDS = 3;
