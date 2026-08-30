import { useMemo } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { filterDeletedSessions, mergeAllSessions } from '../../lib/mergeSessions';
import { useSessionStore } from '../../store/session';
import { isUnder } from '../../lib/pathUtils';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export interface ConversationItem {
  cwd: string;
  sessionPath: string;
  name: string;
  timestamp: string;
  isCurrent: boolean;
}

export function friendlyTime(ts: string | null): string {
  if (!ts) return '新对话';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '新对话';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 对话`;
}

export function buildConversations(
  all: SessionInfo[],
  worksDir: string,
  current: string,
  keyword: string,
  deletedCwds: string[] = [],
  pinnedCwds: string[] = [],
): ConversationItem[] {
  if (!worksDir) return [];
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of all) {
    if (!s.cwd || !isUnder(s.cwd, worksDir)) continue;
    if (deletedCwds.some((cwd) => pathsEquivalent(cwd, s.cwd ?? ''))) continue;
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd)!.push(s);
  }
  let items: ConversationItem[] = [];
  for (const [cwd, list] of byCwd) {
    const sorted = [...list].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    const rep = sorted[0];
    items.push({
      cwd,
      sessionPath: rep.path,
      name: rep.name || friendlyTime(rep.timestamp),
      timestamp: rep.timestamp ?? '',
      isCurrent: cwd === current,
    });
  }
  const kw = keyword.trim().toLowerCase();
  if (kw) items = items.filter((c) => c.name.toLowerCase().includes(kw));
  items.sort((a, b) => {
    const ap = pinnedCwds.some((cwd) => pathsEquivalent(cwd, a.cwd));
    const bp = pinnedCwds.some((cwd) => pathsEquivalent(cwd, b.cwd));
    if (ap !== bp) return ap ? -1 : 1;
    return (b.timestamp ?? '').localeCompare(a.timestamp ?? '');
  });
  return items;
}

export function useConversations(): ConversationItem[] {
  const all = useSessionStore((s) => s.allSessions);
  const optimistic = useSessionStore((s) => s.optimisticSessions);
  const deletedSessionPaths = useSessionStore((s) => s.deletedSessionPaths);
  const worksDir = useSessionStore((s) => s.worksDir);
  const current = useSessionStore((s) => s.activeWorkspace);
  const keyword = useSessionStore((s) => s.searchKeyword);
  const deletedCwds = useSessionStore((s) => s.deletedConversationCwds);
  const pinnedCwds = useSidebarPrefsStore((s) => s.pinnedConversations);
  return useMemo(
    () =>
      buildConversations(
        filterDeletedSessions(mergeAllSessions(all, optimistic), deletedSessionPaths),
        worksDir,
        current,
        keyword,
        deletedCwds,
        pinnedCwds,
      ),
    [all, optimistic, deletedSessionPaths, worksDir, current, keyword, deletedCwds, pinnedCwds],
  );
}
