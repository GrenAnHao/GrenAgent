import { useMemo, useRef } from 'react';
import type { SessionInfo } from '../../lib/pi';
import { filterDeletedSessions, mergeAllSessions } from '../../lib/mergeSessions';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { shareUnchanged } from '../../lib/structuralShare';
import { isolatedPathOf } from '../../lib/isolatedWorkspace';

export interface ProjectGroup {
  cwd: string;
  name: string;
  isCurrent: boolean;
  pinned: boolean;
  sessions: SessionInfo[];
  lastActivity: string; // 该组最新 timestamp
  /** 独立工作区（<主仓>/.gren/worktrees/<id>）：挂在父项目下面显示。 */
  isolated?: { parentCwd: string; id: string; branch: string; parentListed: boolean };
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

/** 运行时注册 + 持久保留的空项目 cwd，去重后供侧栏画空组。 */
export function mergeProjectRegistrations(runtime: string[], kept: string[]): string[] {
  const out = [...runtime];
  for (const cwd of kept) {
    if (!out.some((p) => pathsEquivalent(p, cwd))) out.push(cwd);
  }
  return out;
}

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

  // 排序：置顶 > 最近活跃 > 名称。刻意不把「当前项目」置顶——否则每次打开某个项目对话，
  // 该项目就被顶到最前导致整列重排，体验割裂。保持稳定顺序，仅在真正产生新活动
  //（timestamp 变化）时才自然上移。
  groups.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.lastActivity !== b.lastActivity) return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
    return a.name.localeCompare(b.name);
  });

  return nestIsolatedGroups(groups, aliases);
}

/**
 * 独立工作区的组紧跟在父项目后面（父项目不在列表里时留在原位），默认名字是分支 gren/<id>，
 * 父项目不在时前面带上父项目名。父项目自己的排序不受影响。
 */
function nestIsolatedGroups(groups: ProjectGroup[], aliases: Record<string, string>): ProjectGroup[] {
  const children = new Map<ProjectGroup, ProjectGroup[]>();
  const nested = new Set<ProjectGroup>();
  const annotated = groups.map((group) => {
    const iso = isolatedPathOf(group.cwd);
    if (!iso) return group;
    const parent = groups.find((g) => !isolatedPathOf(g.cwd) && pathsEquivalent(g.cwd, iso.parentRoot));
    const name = aliases[group.cwd] || (parent ? iso.branch : `${basename(iso.parentRoot)} · ${iso.branch}`);
    const next: ProjectGroup = {
      ...group,
      name,
      isolated: { parentCwd: parent?.cwd ?? iso.parentRoot, id: iso.id, branch: iso.branch, parentListed: Boolean(parent) },
    };
    if (parent) {
      nested.add(next);
      children.set(parent, [...(children.get(parent) ?? []), next]);
    }
    return next;
  });
  const out: ProjectGroup[] = [];
  for (const group of annotated) {
    if (nested.has(group)) continue;
    out.push(group);
    const kids = children.get(group);
    if (kids) out.push(...kids);
  }
  return out;
}

/** 先按路径共享每组的会话对象，再按 cwd 共享分组本身。 */
export function sharePreviousGroups(prev: readonly ProjectGroup[] | undefined, next: ProjectGroup[]): ProjectGroup[] {
  if (!prev) return next;
  const prevByCwd = new Map(prev.map((group) => [group.cwd, group]));
  const withSessions = next.map((group) => {
    const old = prevByCwd.get(group.cwd);
    return old ? { ...group, sessions: shareUnchanged(old.sessions, group.sessions, (session) => session.path) } : group;
  });
  return shareUnchanged(prev, withSessions, (group) => group.cwd);
}

export function useProjectGroups(): ProjectGroup[] {
  const allSessions = useSessionStore((s) => s.allSessions);
  const optimisticSessions = useSessionStore((s) => s.optimisticSessions);
  const deletedSessionPaths = useSessionStore((s) => s.deletedSessionPaths);
  const registeredProjects = useSessionStore((s) => s.registeredProjects);
  const keptProjects = useSidebarPrefsStore((s) => s.keptProjects);
  const current = useSessionStore((s) => s.activeWorkspace);
  const keyword = useSessionStore((s) => s.searchKeyword);
  const worksDir = useSessionStore((s) => s.worksDir);
  const pinnedProjects = useSidebarPrefsStore((s) => s.pinnedProjects);
  const hiddenProjects = useSidebarPrefsStore((s) => s.hiddenProjects);
  const aliases = useSidebarPrefsStore((s) => s.aliases);

  // 沿用上一轮没变的分组和会话对象：切会话会整份重建，侧栏的 memo 行组件只该重渲变了的那几行。
  const previous = useRef<ProjectGroup[] | undefined>(undefined);
  return useMemo(
    () => {
      const built = buildProjectGroups(
        filterDeletedSessions(mergeAllSessions(allSessions, optimisticSessions), deletedSessionPaths),
        {
          current,
          pinnedProjects,
          hiddenProjects,
          aliases,
          keyword,
          worksDir,
          registeredProjects: mergeProjectRegistrations(registeredProjects, keptProjects),
        },
      );
      previous.current = sharePreviousGroups(previous.current, built);
      return previous.current;
    },
    [
      allSessions,
      optimisticSessions,
      deletedSessionPaths,
      registeredProjects,
      keptProjects,
      current,
      pinnedProjects,
      hiddenProjects,
      aliases,
      keyword,
      worksDir,
    ],
  );
}
