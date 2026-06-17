import { useMemo } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { mergeAllSessions } from '../../lib/mergeSessions';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export interface ProjectGroup {
  cwd: string;
  name: string;
  isCurrent: boolean;
  pinned: boolean;
  sessions: SessionInfo[];
  lastActivity: string; // 该组最新 timestamp
}

interface BuildParams {
  current: string;
  pinnedProjects: string[];
  hiddenProjects: string[];
  aliases: Record<string, string>;
  keyword: string;
  worksDir: string;
  registeredProjects: string[];
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function buildProjectGroups(sessions: SessionInfo[], params: BuildParams): ProjectGroup[] {
  const { current, pinnedProjects, hiddenProjects, aliases, keyword, worksDir, registeredProjects } =
    params;
  const kw = keyword.trim().toLowerCase();

  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    if (worksDir && isUnder(s.cwd, worksDir)) continue; // 排除「对话」(works 目录)
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd)!.push(s);
  }

  let groups: ProjectGroup[] = [];
  for (const [cwd, list] of byCwd) {
    if (hiddenProjects.includes(cwd)) continue;
    const sorted = [...list].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    const name = aliases[cwd] || basename(cwd);
    groups.push({
      cwd,
      name,
      isCurrent: cwd === current,
      pinned: pinnedProjects.includes(cwd),
      sessions: sorted,
      lastActivity: sorted[0]?.timestamp ?? '',
    });
  }

  for (const cwd of registeredProjects) {
    if (hiddenProjects.includes(cwd)) continue;
    if (worksDir && isUnder(cwd, worksDir)) continue;
    if (groups.some((g) => pathsEquivalent(g.cwd, cwd))) continue;
    groups.push({
      cwd,
      name: aliases[cwd] || basename(cwd),
      isCurrent: cwd === current,
      pinned: pinnedProjects.includes(cwd),
      sessions: [],
      lastActivity: '',
    });
  }

  // 关键字过滤：项目名命中 → 整组保留；否则保留命中标题的会话
  if (kw) {
    groups = groups
      .map((g): ProjectGroup | null => {
        if (g.name.toLowerCase().includes(kw)) return g;
        const hit = g.sessions.filter((s) => (s.name ?? '').toLowerCase().includes(kw));
        return hit.length ? { ...g, sessions: hit } : null;
      })
      .filter((g): g is ProjectGroup => g !== null);
  }

  // 排序：当前项目 > 置顶 > 最近活跃（无 session 的新开项目靠 isCurrent 靠前）
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.lastActivity !== b.lastActivity) return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
    return a.name.localeCompare(b.name);
  });

  return groups;
}

export function useProjectGroups(): ProjectGroup[] {
  const allSessions = useSessionStore((s) => s.allSessions);
  const optimisticSessions = useSessionStore((s) => s.optimisticSessions);
  const registeredProjects = useSessionStore((s) => s.registeredProjects);
  const current = useSessionStore((s) => s.activeWorkspace);
  const keyword = useSessionStore((s) => s.searchKeyword);
  const worksDir = useSessionStore((s) => s.worksDir);
  const pinnedProjects = useSidebarPrefsStore((s) => s.pinnedProjects);
  const hiddenProjects = useSidebarPrefsStore((s) => s.hiddenProjects);
  const aliases = useSidebarPrefsStore((s) => s.aliases);

  return useMemo(
    () =>
      buildProjectGroups(mergeAllSessions(allSessions, optimisticSessions), {
        current,
        pinnedProjects,
        hiddenProjects,
        aliases,
        keyword,
        worksDir,
        registeredProjects,
      }),
    [
      allSessions,
      optimisticSessions,
      registeredProjects,
      current,
      pinnedProjects,
      hiddenProjects,
      aliases,
      keyword,
      worksDir,
    ],
  );
}
