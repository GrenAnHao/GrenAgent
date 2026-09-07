export type GoalStatus = "active" | "paused" | "disarmed" | "judging" | "blocked" | "complete" | "error" | "cleared";
export type GoalSource = "human" | "legacy" | "fork";
export type GoalStopReasonKind = "user_pause" | "judge_failed" | "judge_unavailable" | "blocked" | "runtime_error" | "persistence_error" | "cleared" | "max_rounds";
export interface GoalStopReason { kind: GoalStopReasonKind; summary: string; at: string; turnId?: string }
export interface GoalJudgeRecord { model: string; verdict: "pass" | "fail" | "error"; reason: string; missing: string[]; revision: number; turnId?: string; at: string }
export interface GoalBlockageRecord { fingerprint: string; count: number; summary: string; lastTurnId?: string; at: string }

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
  stopReason?: GoalStopReason;
  judge?: GoalJudgeRecord;
  blockage?: GoalBlockageRecord;
  sourceGoalId?: string;
  sourceSessionId?: string;
  clearedAt?: string;
  source?: GoalSource;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  sessionId: string;
  revision: number;
  kind: "pause" | "resume" | "begin_judging" | "block" | "disarm" | "clear" | "judge_pass" | "judge_fail" | "legacy_goal_restored";
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
  continuousIntentEvidence?: string;
}

export interface GoalCasUpdate {
  sessionId: string;
  goalId: string;
  revision: number;
  action: "pause" | "resume" | "begin_judging" | "block" | "disarm" | "clear" | "judge_pass" | "judge_fail";
  payload?: Record<string, unknown>;
  origin: "human-ui" | "human-agent" | "system";
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
