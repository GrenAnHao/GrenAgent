import { useMemo } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { mergeAllSessions } from '../../lib/mergeSessions';
import { useSessionStore } from '../../store/session';
import { isUnder } from '../../lib/pathUtils';

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
): ConversationItem[] {
  if (!worksDir) return [];
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of all) {
    if (!s.cwd || !isUnder(s.cwd, worksDir)) continue;
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
  items.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return items;
}

export function useConversations(): ConversationItem[] {
  const all = useSessionStore((s) => s.allSessions);
  const optimistic = useSessionStore((s) => s.optimisticSessions);
  const worksDir = useSessionStore((s) => s.worksDir);
  const current = useSessionStore((s) => s.activeWorkspace);
  const keyword = useSessionStore((s) => s.searchKeyword);
  return useMemo(
    () => buildConversations(mergeAllSessions(all, optimistic), worksDir, current, keyword),
    [all, optimistic, worksDir, current, keyword],
  );
}
