import type { SessionInfo } from './pi';

const ALL_SESSIONS_TTL_MS = 30_000;

let allSessionsCache: { data: SessionInfo[]; expiresAt: number } | null = null;
let allSessionsInflight: Promise<SessionInfo[]> | null = null;

export function getCachedAllSessions(): SessionInfo[] | null {
  if (!allSessionsCache) return null;
  if (allSessionsCache.expiresAt <= Date.now()) {
    allSessionsCache = null;
    return null;
  }
  return allSessionsCache.data;
}

export function setCachedAllSessions(data: SessionInfo[]): void {
  allSessionsCache = { data, expiresAt: Date.now() + ALL_SESSIONS_TTL_MS };
}

export function invalidateAllSessionsCache(): void {
  allSessionsCache = null;
}

export function getAllSessionsInflight(): Promise<SessionInfo[]> | null {
  return allSessionsInflight;
}

export function setAllSessionsInflight(promise: Promise<SessionInfo[]> | null): void {
  allSessionsInflight = promise;
}

// 会话列表的单调代次：每次删除/新建/重命名等 mutation 自增；
// 重拉响应回来时若代次已变（期间发生过 mutation），该响应作废，避免把旧列表灌回（回弹治根）。
let mutationEpoch = 0;

export function bumpSessionMutationEpoch(): number {
  return ++mutationEpoch;
}

export function getSessionMutationEpoch(): number {
  return mutationEpoch;
}

/** 请求发起时记录 startedEpoch；响应回来调此判定是否仍可应用。 */
export function isFreshResponse(startedEpoch: number): boolean {
  return startedEpoch === mutationEpoch;
}
