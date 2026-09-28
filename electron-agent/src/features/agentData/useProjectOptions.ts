import { useMemo } from 'react';
import { useSessionStore } from '../../store';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';

export interface ProjectOption { cwd: string; name: string }

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * Agent 数据面板的项目下拉选项：仅"路径 + 显示名"，按路径排序。
 * 刻意不复用 useProjectGroups——后者带侧栏的置顶/隐藏/关键字过滤语义，
 * 面板的筛选器不应该被侧栏搜索框影响。
 */
export function useProjectOptions(): ProjectOption[] {
  const allSessions = useSessionStore((state) => state.allSessions);
  const registeredProjects = useSessionStore((state) => state.registeredProjects);
  const keptProjects = useSidebarPrefsStore((state) => state.keptProjects);
  const activeWorkspace = useSessionStore((state) => state.activeWorkspace);
  const worksDir = useSessionStore((state) => state.worksDir);

  return useMemo(() => {
    const candidates = [
      ...allSessions.map((session) => session.cwd ?? ''),
      ...registeredProjects,
      ...keptProjects,
      activeWorkspace,
    ].filter((cwd) => cwd && !(worksDir && isUnder(cwd, worksDir)));

    const unique: string[] = [];
    for (const cwd of candidates) {
      if (!unique.some((existing) => pathsEquivalent(existing, cwd))) unique.push(cwd);
    }
    return unique.sort((a, b) => a.localeCompare(b)).map((cwd) => {
      const name = basename(cwd);
      const duplicated = unique.some((other) => other !== cwd && basename(other).toLowerCase() === name.toLowerCase());
      return { cwd, name: duplicated ? `${name} · ${cwd.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/[^/]+$/, '')}` : name };
    });
  }, [allSessions, registeredProjects, keptProjects, activeWorkspace, worksDir]);
}
