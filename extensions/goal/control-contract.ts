import type { GoalSnapshot } from './types.js';
import type { GoalStatusEnvelope } from './status.js';

export type GoalControlAction = 'create' | 'edit' | 'pause' | 'resume' | 'clear';
export interface GoalControlRequest {
  operationId: string;
  action: GoalControlAction;
  goalId: string;
  expectedRevision: number;
  expectedConditionRevision: number;
  condition?: string;
  maxRounds?: number;
}
export interface GoalControlReceipt {
  operationId: string;
  sessionId: string;
  goalId: string;
  ownerEpoch?: string;
  action: GoalControlAction;
  outcome: 'committed' | 'conflict' | 'failed' | 'unavailable';
  expectedConditionRevision: number;
  committedRevision?: number;
  replayed?: boolean;
  snapshot: GoalSnapshot | null;
  /** Latest projection can be newer than this operation's committed snapshot. */
  status?: GoalStatusEnvelope;
  message?: string;
}

export function parseGoalControlRequest(raw: unknown): GoalControlRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_GOAL_CONTROL');
  const value = raw as Record<string, unknown>;
  if (typeof value.operationId !== 'string' || !value.operationId.trim() || value.operationId.length > 160) throw new Error('INVALID_GOAL_OPERATION_ID');
  const action = value.action;
  if (action !== 'create' && action !== 'edit' && action !== 'pause' && action !== 'resume' && action !== 'clear') throw new Error('INVALID_GOAL_CONTROL_ACTION');
  if (typeof value.goalId !== 'string' || (!value.goalId && action !== 'create')) throw new Error('INVALID_GOAL_ID');
  for (const name of ['expectedRevision', 'expectedConditionRevision']) {
    if (!Number.isSafeInteger(value[name]) || (value[name] as number) < (action === 'create' ? 0 : 1)) throw new Error('INVALID_GOAL_VERSION');
  }
  if ((action === 'create' || action === 'edit') && (typeof value.condition !== 'string' || !value.condition.trim() || value.condition.trim().length > 4000)) throw new Error('INVALID_GOAL_CONDITION');
  if (value.maxRounds !== undefined && (!Number.isSafeInteger(value.maxRounds) || (value.maxRounds as number) < 1)) throw new Error('INVALID_GOAL_MAX_ROUNDS');
  return {
    operationId: value.operationId,
    action,
    goalId: value.goalId,
    expectedRevision: value.expectedRevision as number,
    expectedConditionRevision: value.expectedConditionRevision as number,
    ...(typeof value.condition === 'string' ? { condition: value.condition.trim() } : {}),
    ...(typeof value.maxRounds === 'number' ? { maxRounds: value.maxRounds } : {}),
  };
}
