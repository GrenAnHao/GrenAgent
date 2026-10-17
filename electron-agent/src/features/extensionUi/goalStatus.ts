import { pi } from '../../lib/pi';
import { useGoalStore, type GoalHistoryItem, type GoalSnapshot } from '../../stores/goalStore';

interface ParsedGoalStatus {
  sessionId: string;
  snapshot?: GoalSnapshot;
}

const GOAL_STATUS_SCHEMA_VERSION = 1;

/**
 * Goal 信封：扩展 setStatus("goal") 推来的，和主进程 agent_get_goal 补拉回来的是同一种。
 * 只接受 v1：顶层 sessionId / history，嵌套 snapshot（折叠字段，不含 sessionId）。旧版 {condition, paused, react} 忽略。
 */
export function parseGoalStatus(statusText: unknown, envelopeSessionId?: unknown): ParsedGoalStatus | undefined {
  try {
    const parsed = typeof statusText === 'string'
      ? (statusText ? JSON.parse(statusText) : undefined)
      : statusText;
    if (!isRecord(parsed) || parsed.schemaVersion !== GOAL_STATUS_SCHEMA_VERSION) return undefined;
    const sessionId = readNonEmptyString(parsed.sessionId ?? envelopeSessionId);
    if (!sessionId) return undefined;
    if (parsed.snapshot === null) return { sessionId };
    if (!isRecord(parsed.snapshot)) return undefined;

    const candidate = parsed.snapshot;
    const goalId = readNonEmptyString(candidate.goalId);
    const condition = readNonEmptyString(candidate.condition);
    const status = readGoalStatus(candidate.status);
    const revision = readPositiveInteger(candidate.revision);
    if (!goalId || !condition || !status || revision === undefined) return undefined;

    const now = new Date().toISOString();
    const blockedReason = readBlockedReason(candidate.blockedReason);
    const snapshot: GoalSnapshot = {
      goalId,
      sessionId,
      revision,
      condition,
      status,
      roundsStarted: readNonnegativeInteger(candidate.roundsStarted) ?? 0,
      maxRounds: readPositiveInteger(candidate.maxRounds) ?? 256,
      createdAt: readNonEmptyString(candidate.createdAt) ?? now,
      updatedAt: readNonEmptyString(candidate.updatedAt) ?? now,
      ranMs: readNonnegativeInteger(candidate.ranMs) ?? 0,
      ...(readNonEmptyString(candidate.runStartedAt) ? { runStartedAt: readNonEmptyString(candidate.runStartedAt) } : {}),
      activation: candidate.activation === 'armed' ? 'armed' : 'disarmed',
      ...(blockedReason ? { blockedReason } : {}),
      ...(Array.isArray(parsed.history) ? { history: parsed.history as GoalHistoryItem[] } : {}),
    };
    return { sessionId, snapshot };
  } catch {
    return undefined;
  }
}

/**
 * 把一份信封写进 goalStore。带会话路径时顺手记下「路径 → sessionId」，
 * 输入栏的 Goal 条按当前会话路径就能找到它，不必再等 getState。
 */
export function applyGoalStatus(statusText: unknown, envelopeSessionId?: unknown, sessionPath?: string): boolean {
  const parsed = parseGoalStatus(statusText, envelopeSessionId);
  if (!parsed) return false;
  const store = useGoalStore.getState();
  if (sessionPath) store.bindSessionPath(sessionPath, parsed.sessionId);
  store.setSnapshot(parsed.sessionId, parsed.snapshot);
  return true;
}

/** 按会话路径向主进程补拉一次 Goal。读不到（会话还没落盘、主进程不认识）就保持现状。 */
export async function refreshGoalStatus(workspace: string | undefined, sessionPath: string | null | undefined): Promise<void> {
  if (!workspace || !sessionPath) return;
  try {
    const status = await pi.getGoal(workspace, sessionPath);
    if (status) applyGoalStatus(status, undefined, sessionPath);
  } catch {
    // 补拉失败不清条：推送仍可能补上，下次切换会话也会再拉。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readGoalStatus(value: unknown): GoalSnapshot['status'] | undefined {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
    ? value
    : undefined;
}

function readBlockedReason(value: unknown): GoalSnapshot['blockedReason'] | undefined {
  if (!isRecord(value)) return undefined;
  const code = readNonEmptyString(value.code);
  const message = readNonEmptyString(value.message);
  if (!code || !message) return undefined;
  return { code, message };
}
