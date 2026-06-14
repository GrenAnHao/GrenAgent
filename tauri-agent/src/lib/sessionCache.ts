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
