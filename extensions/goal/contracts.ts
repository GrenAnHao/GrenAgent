export type GoalStatus = "active" | "paused" | "disarmed" | "judging" | "blocked" | "complete" | "error" | "cleared";

export interface GoalSnapshot {
  goalId: string;
  sessionId: string;
  workspace: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsUsed: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  stopReason?: { reason: string; code?: string };
  judge?: { verdict: "pass" | "fail" | "error"; reason: string; missing?: string[]; fingerprint?: string; turnId?: string };
  blockage?: { reason: string; fingerprint?: string; consecutiveRounds: number };
  sourceGoalId?: string;
  sourceSessionId?: string;
  clearedAt?: string;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  sessionId: string;
  revision: number;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt: string;
  publishedAt?: string;
}

export interface GoalDispatch {
  idempotencyKey: string;
  goalId: string;
  revision: number;
  nextRound: number;
  status: "claimed" | "queued" | "settled" | "failed";
  turnId?: string;
}

export interface CreateGoalInput {
  sessionId: string;
  workspace: string;
  condition: string;
  origin: "human-ui" | "human-agent";
  maxRounds?: number;
}

export interface GoalCasUpdate {
  sessionId: string;
  goalId: string;
  revision: number;
  action: string;
  payload?: Record<string, unknown>;
  origin: string;
}

export type GoalUpdateInput = GoalCasUpdate;

export interface RoundClaimInput {
  sessionId: string;
  goalId: string;
  revision: number;
  nextRound: number;
  idempotencyKey: string;
}

export interface RoundSettlementInput {
  sessionId: string;
  goalId: string;
  revision: number;
  idempotencyKey: string;
  turnId: string;
  summary: string;
}

export interface JudgeResultInput {
  sessionId: string;
  goalId: string;
  revision: number;
  verdict: "pass" | "fail" | "error";
  reason: string;
  missing?: string[];
  fingerprint?: string;
  turnId?: string;
}
