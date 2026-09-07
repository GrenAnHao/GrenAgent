export type GoalStatus = 'active' | 'paused' | 'disarmed' | 'judging' | 'blocked' | 'complete' | 'error' | 'cleared';
export type GoalSource = 'human' | 'legacy' | 'fork';
export type GoalStopReasonKind = 'user_pause' | 'judge_failed' | 'judge_unavailable' | 'blocked' | 'runtime_error' | 'persistence_error' | 'cleared' | 'max_rounds';
export interface GoalStopReason { kind: GoalStopReasonKind; summary: string; at: string; turnId?: string }
export interface GoalJudgeRecord { model: string; verdict: 'pass' | 'fail' | 'error'; reason: string; missing: string[]; revision: number; turnId?: string; at: string }
export interface GoalBlockageRecord { fingerprint: string; count: number; summary: string; lastTurnId?: string; at: string }
/**
 * `sessionId` is the only ownership key. Pi generates it as a UUID, writes it
 * into the session JSONL header and mirrors it in the file name
 * (`<timestamp>_<uuid>.jsonl`), so it is unique across workspaces and every
 * AgentData Goal query is keyed by `session_id` alone. `workspace` is display
 * and authorization metadata; runtime maps additionally key by
 * `(workspace, sessionId)` because a caller can hand the runtime an
 * unverified session id that must not address another workspace's worker.
 */
export interface GoalSnapshot {
  goalId: string; sessionId: string; workspace: string; revision: number; condition: string; status: GoalStatus;
  roundsUsed: number; maxRounds: number; createdAt: string; updatedAt: string; stopReason?: GoalStopReason;
  judge?: GoalJudgeRecord; blockage?: GoalBlockageRecord; sourceGoalId?: string; sourceSessionId?: string; clearedAt?: string; source?: GoalSource;
}
export interface GoalEvent {
  id: string; goalId: string; sessionId: string; revision: number; kind: string; payload: Record<string, unknown>;
  idempotencyKey?: string; createdAt: string; publishedAt?: string;
}
export interface GoalDispatch {
  idempotencyKey: string; goalId: string; revision: number; nextRound: number;
  status: 'claimed' | 'queued' | 'settled' | 'failed'; turnId?: string;
}
export interface CreateGoalInput { sessionId: string; workspace: string; condition: string; origin: 'human-ui' | 'human-agent'; maxRounds?: number; continuousIntentEvidence?: string }
export interface GoalCasUpdate { sessionId: string; goalId: string; revision: number; action: 'pause' | 'resume' | 'begin_judging' | 'block' | 'disarm' | 'clear' | 'judge_pass' | 'judge_fail'; payload?: Record<string, unknown>; origin: 'human-ui' | 'human-agent' | 'system' }
export type GoalUpdateInput = GoalCasUpdate;
export interface RoundClaimInput {
  sessionId: string; goalId: string; revision: number; nextRound: number; idempotencyKey: string;
  workspace?: string; origin?: string; promptDigest?: string; continuousIntent?: boolean; turnId?: string;
}
export interface RoundSettlementInput { sessionId: string; goalId: string; revision: number; idempotencyKey: string; turnId: string; summary: string }
/** Release a claimed round that can never settle (worker crash, workspace close, stale generation). */
export interface RoundCancelInput { sessionId: string; goalId: string; revision: number; idempotencyKey: string; turnId?: string; reason: string }
export interface GoalProgressInput { sessionId: string; goalId: string; revision: number; summary?: string; fingerprint?: string }
export interface JudgeResultInput { sessionId: string; goalId: string; revision: number; verdict: 'pass' | 'fail' | 'error'; reason: string; missing?: string[]; fingerprint?: string; turnId?: string; model?: string }
export interface GoalRuntimeErrorInput { sessionId: string; goalId: string; revision: number; reason: string; turnId?: string }
export interface ForkGoalInput { sourceSessionId: string; sourceGoalId: string; targetSessionId: string }
export interface RecoverLegacyGoalInput {
  sessionId: string;
  workspace: string;
  condition: string;
  react: number;
  paused: boolean;
  legacyEntryTimestamp?: string | number;
}
