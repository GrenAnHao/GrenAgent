import type { SessionInfo } from './pi';
import { pathsEquivalent } from './pathUtils';

/** 合并磁盘扫描结果与尚未落盘的 optimistic 会话（按 path 去重）。 */
export function mergeAllSessions(allSessions: SessionInfo[], optimistic: SessionInfo[]): SessionInfo[] {
  const merged = [...allSessions];
  for (const o of optimistic) {
    if (!o.path || !o.cwd) continue;
    if (merged.some((m) => pathsEquivalent(m.path, o.path))) continue;
    merged.push(o);
  }
  return merged;
}

/** 磁盘已出现同 path 的会话后，移除对应 optimistic 占位。 */
export function pruneOptimisticSessions(allSessions: SessionInfo[], optimistic: SessionInfo[]): SessionInfo[] {
  return optimistic.filter((o) => !allSessions.some((r) => pathsEquivalent(r.path, o.path)));
}

/** 过滤掉已乐观删除（等待后台清理完成）的会话 path，供侧栏列表即时移除。 */
export function filterDeletedSessions(sessions: SessionInfo[], deletedPaths: string[]): SessionInfo[] {
  if (deletedPaths.length === 0) return sessions;
  return sessions.filter((s) => !deletedPaths.some((p) => pathsEquivalent(p, s.path)));
}
