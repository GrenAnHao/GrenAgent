import type { SessionInfo } from './pi';
import { pathsEquivalent } from './pathUtils';

/** 合并磁盘扫描结果与尚未落盘的 optimistic 会话（按 path 去重）。 */
export function mergeAllSessions(allSessions: SessionInfo[], optimistic: SessionInfo[]): SessionInfo[] {
  const merged = overlayUntitledNames(allSessions, optimistic);
  for (const o of optimistic) {
    if (!o.path || !o.cwd) continue;
    if (merged.some((m) => pathsEquivalent(m.path, o.path))) continue;
    merged.push(o);
  }
  return merged;
}

/** AUTO_TITLE 关闭时磁盘会话常无 session_info.name；保留发送瞬间写下的首条消息标题。 */
function overlayUntitledNames(disk: SessionInfo[], optimistic: SessionInfo[]): SessionInfo[] {
  return disk.map((session) => {
    if (session.name?.trim()) return session;
    const named = optimistic.find((o) => pathsEquivalent(o.path, session.path) && o.name?.trim());
    return named ? { ...session, name: named.name } : session;
  });
}

/** 磁盘已出现同 path 的会话后，移除对应 optimistic 占位。磁盘仍未命名时保留带标题的占位。 */
export function pruneOptimisticSessions(allSessions: SessionInfo[], optimistic: SessionInfo[]): SessionInfo[] {
  return optimistic.filter((o) => {
    const disk = allSessions.find((r) => pathsEquivalent(r.path, o.path));
    if (!disk) return true;
    return !disk.name?.trim() && Boolean(o.name?.trim());
  });
}

/**
 * 侧栏里看得见的会话：磁盘 + 乐观占位，去掉乐观删除的和已归档的。
 * 侧栏分组、删除 / 归档后挑下一个会话都用它，免得切到一份侧栏里没有的会话。
 */
export function visibleSessions(
  allSessions: SessionInfo[],
  optimistic: SessionInfo[],
  deletedPaths: string[],
): SessionInfo[] {
  const merged = filterDeletedSessions(mergeAllSessions(allSessions, optimistic), deletedPaths);
  return merged.some((s) => s.archived) ? merged.filter((s) => !s.archived) : merged;
}

/** 已归档的会话（不含乐观删除中的），时间倒序。 */
export function archivedSessions(allSessions: SessionInfo[], deletedPaths: string[]): SessionInfo[] {
  return filterDeletedSessions(
    allSessions.filter((s) => s.archived),
    deletedPaths,
  ).sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
}

/** 过滤掉已乐观删除（等待后台清理完成）的会话 path，供侧栏列表即时移除。 */
export function filterDeletedSessions(sessions: SessionInfo[], deletedPaths: string[]): SessionInfo[] {
  if (deletedPaths.length === 0) return sessions;
  return sessions.filter((s) => !deletedPaths.some((p) => pathsEquivalent(p, s.path)));
}
