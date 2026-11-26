import { pi, type GoalOwnerLossNotice } from '../../lib/pi';
import { useGoalStore, type GoalHistoryItem, type GoalSnapshot, type GoalStatusStamp } from '../../stores/goalStore';

interface ParsedGoalStatus extends GoalStatusStamp {
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
    const stamp: GoalStatusStamp = {
      ...(parsed.source === 'live' || parsed.source === 'offline' ? { source: parsed.source } : {}),
      ...(readNonEmptyString(parsed.ownerEpoch) ? { ownerEpoch: readNonEmptyString(parsed.ownerEpoch) } : {}),
      ...(readPositiveInteger(parsed.sequence) !== undefined ? { sequence: readPositiveInteger(parsed.sequence) } : {}),
    };
    if (parsed.snapshot === null) return { sessionId, ...stamp };
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
      runNumber: readPositiveInteger(candidate.runNumber) ?? 1,
      runRoundsStarted: readNonnegativeInteger(candidate.runRoundsStarted) ?? readNonnegativeInteger(candidate.roundsStarted) ?? 0,
      conditionRevision: readPositiveInteger(candidate.conditionRevision) ?? 1,
      maxRounds: readPositiveInteger(candidate.maxRounds) ?? 256,
      createdAt: readNonEmptyString(candidate.createdAt) ?? now,
      updatedAt: readNonEmptyString(candidate.updatedAt) ?? now,
      ranMs: readNonnegativeInteger(candidate.ranMs) ?? 0,
      ...(readNonEmptyString(candidate.runStartedAt) ? { runStartedAt: readNonEmptyString(candidate.runStartedAt) } : {}),
      activation: candidate.activation === 'armed' ? 'armed' : 'disarmed',
      ...(blockedReason ? { blockedReason } : {}),
      ...(readNonEmptyString(parsed.unavailable) ? { runtimeUnavailable: readNonEmptyString(parsed.unavailable) } : {}),
      ...(readPauseReason(candidate.pauseReason) ? { pauseReason: readPauseReason(candidate.pauseReason) } : {}),
      ...(Array.isArray(parsed.history) ? { history: parsed.history as GoalHistoryItem[] } : {}),
    };
    return { sessionId, snapshot, ...stamp };
  } catch {
    return undefined;
  }
}

/**
 * 把一份信封写进 goalStore。带会话路径时顺手记下「路径 → sessionId」，
 * 输入栏的 Goal 条按当前会话路径就能找到它，不必再等 getState。
 */
export function applyGoalStatus(statusText: unknown, envelopeSessionId?: unknown, sessionPath?: string, authoritativeOwner = false): boolean {
  const parsed = parseGoalStatus(statusText, envelopeSessionId);
  if (!parsed) return false;
  const store = useGoalStore.getState();
  if (sessionPath) store.bindSessionPath(sessionPath, parsed.sessionId);
  if (!parsed.source && !store.watermarks?.[parsed.sessionId]) {
    store.setSnapshot(parsed.sessionId, parsed.snapshot);
    return true;
  }
  let snapshot = parsed.snapshot;
  const previous = store.bySession?.[parsed.sessionId];
  if (snapshot && previous?.runtimeUnavailable === 'GOAL_OWNER_LOST' && snapshot.goalId === previous.goalId
    && snapshot.status === 'active' && snapshot.activation === 'disarmed' && !snapshot.runtimeUnavailable) {
    // A new owner may announce itself before its recovery append commits. Keep
    // the confirmed loss visible until a real pause (or explicit new run) lands.
    const { runStartedAt: _running, ...stopped } = snapshot;
    snapshot = { ...stopped, ranMs: Math.max(snapshot.ranMs, previous.ranMs), runtimeUnavailable: 'GOAL_OWNER_LOST' };
  }
  return store.acceptStatus(parsed.sessionId, snapshot, parsed, authoritativeOwner);
}

/** A trusted host-loss notice freezes display only; it never invents a pause event. */
export function applyGoalOwnerLoss(notice: GoalOwnerLossNotice): void {
  if (!notice || !readNonEmptyString(notice.sessionPath) || !readNonEmptyString(notice.sessionId)
    || !readNonEmptyString(notice.ownerEpoch) || !readNonEmptyString(notice.goalId)) return;
  const store = useGoalStore.getState();
  store.bindSessionPath(notice.sessionPath, notice.sessionId);
  store.bumpMutationFence(notice.sessionPath);
  store.markOwnerLost(notice.sessionId, notice.ownerEpoch, notice.goalId);
}

/** A new epoch is confirmed through a host pull, never by sorting random IDs. */
export function shouldConfirmGoalOwner(statusText: unknown, envelopeSessionId?: unknown): boolean {
  const parsed = parseGoalStatus(statusText, envelopeSessionId);
  if (!parsed?.ownerEpoch || parsed.source !== 'live') return false;
  const watermark = useGoalStore.getState().watermarks?.[parsed.sessionId];
  return !!watermark && watermark.ownerEpoch !== parsed.ownerEpoch && !watermark.retiredEpochs.includes(parsed.ownerEpoch);
}

const refreshGenerations = new Map<string, number>();

/** 按会话路径向主进程补拉一次 Goal。读不到（会话还没落盘、主进程不认识）就保持现状。 */
export async function refreshGoalStatus(workspace: string | undefined, sessionPath: string | null | undefined): Promise<void> {
  if (!workspace || !sessionPath) return;
  try {
    const store = useGoalStore.getState();
    const fence = store.mutationFence(sessionPath);
    const key = `${workspace}\n${sessionPath.replaceAll('\\\\', '/').toLowerCase()}`;
    const generation = (refreshGenerations.get(key) ?? 0) + 1;
    refreshGenerations.set(key, generation);
    const status = await pi.getGoal(workspace, sessionPath);
    if (generation !== refreshGenerations.get(key) || fence !== useGoalStore.getState().mutationFence(sessionPath)) return;
    if (status) applyGoalStatus(status, undefined, sessionPath, true);
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

function readPauseReason(value: unknown): GoalSnapshot['pauseReason'] | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  if (code !== 'user' && code !== 'max-rounds' && code !== 'request-error' && code !== 'runtime-error') return undefined;
  return { code, ...(readNonEmptyString(value.message) ? { message: readNonEmptyString(value.message) } : {}) };
}

function readBlockedReason(value: unknown): GoalSnapshot['blockedReason'] | undefined {
  if (!isRecord(value)) return undefined;
  const code = readNonEmptyString(value.code);
  const message = readNonEmptyString(value.message);
  if (!code || !message) return undefined;
  return { code, message };
}
