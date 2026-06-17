import { create } from 'zustand';
import type { SessionInfo } from '../lib/pi';
import { mergeAllSessions, pruneOptimisticSessions } from '../lib/mergeSessions';
import { pathsEquivalent } from '../lib/pathUtils';

interface SessionStore {
  sessions: SessionInfo[]; // 当前 workspace 的会话（保留，兼容现有用法）
  allSessions: SessionInfo[]; // 跨项目全量会话
  optimisticSessions: SessionInfo[]; // 尚未落盘、侧栏占位用
  registeredProjects: string[]; // 已打开但可能尚无 session 文件的项目 cwd
  worksDir: string; // ~/.pi/agent/works 的 canonical 前缀（区分对话/项目）
  activeWorkspace: string; // 当前选中项目 cwd（替代常量 WORKSPACE，默认 '.'）
  activeSessionPath: string | null;
  workspaceSessionPaths: Record<string, string>; // workspace(cwd) → 该 ws 当前活跃 sessionPath
  searchKeyword: string;
  isLoading: boolean;
  allSessionsLoading: boolean;
  error: string | null;

  setSessions: (sessions: SessionInfo[]) => void;
  setAllSessions: (sessions: SessionInfo[]) => void;
  /** 磁盘列表更新后同步清理已落盘的 optimistic 占位。 */
  syncAllSessions: (sessions: SessionInfo[]) => void;
  upsertOptimisticSession: (session: SessionInfo) => void;
  /** 删除会话后清掉对应乐观占位（按 path）——否则它匹配不到磁盘会话、永不被 prune，侧栏残留。 */
  removeOptimisticSession: (path: string) => void;
  /** 删除对话/项目后清掉该 cwd 下全部乐观占位。 */
  removeOptimisticByCwd: (cwd: string) => void;
  registerProject: (cwd: string) => void;
  unregisterProject: (cwd: string) => void;
  getMergedSessions: () => SessionInfo[];
  setWorksDir: (dir: string) => void;
  setActiveWorkspace: (cwd: string) => void;
  setActiveSession: (path: string) => void;
  setWorkspaceSessionPath: (workspace: string, path: string) => void;
  setSearchKeyword: (kw: string) => void;
  setLoading: (loading: boolean) => void;
  setAllSessionsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  allSessions: [],
  optimisticSessions: [],
  registeredProjects: [],
  worksDir: '',
  activeWorkspace: '',
  activeSessionPath: null,
  workspaceSessionPaths: {},
  searchKeyword: '',
  isLoading: false,
  allSessionsLoading: false,
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setAllSessions: (allSessions) => set({ allSessions }),
  syncAllSessions: (allSessions) =>
    set((s) => ({
      allSessions,
      optimisticSessions: pruneOptimisticSessions(allSessions, s.optimisticSessions),
    })),
  upsertOptimisticSession: (session) =>
    set((s) => {
      const rest = s.optimisticSessions.filter((o) => !pathsEquivalent(o.path, session.path));
      return { optimisticSessions: [...rest, session] };
    }),
  removeOptimisticSession: (path) =>
    set((s) => ({
      optimisticSessions: s.optimisticSessions.filter((o) => !pathsEquivalent(o.path, path)),
    })),
  removeOptimisticByCwd: (cwd) =>
    set((s) => ({
      optimisticSessions: s.optimisticSessions.filter((o) => !pathsEquivalent(o.cwd ?? '', cwd)),
    })),
  registerProject: (cwd) =>
    set((s) =>
      s.registeredProjects.some((p) => pathsEquivalent(p, cwd))
        ? s
        : { registeredProjects: [...s.registeredProjects, cwd] },
    ),
  unregisterProject: (cwd) =>
    set((s) => ({
      registeredProjects: s.registeredProjects.filter((p) => !pathsEquivalent(p, cwd)),
    })),
  getMergedSessions: () => mergeAllSessions(get().allSessions, get().optimisticSessions),
  setWorksDir: (worksDir) => set({ worksDir }),
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace }),
  setActiveSession: (path) => set({ activeSessionPath: path }),
  setWorkspaceSessionPath: (workspace, path) =>
    set((s) => ({ workspaceSessionPaths: { ...s.workspaceSessionPaths, [workspace]: path } })),
  setSearchKeyword: (searchKeyword) => set({ searchKeyword }),
  setLoading: (isLoading) => set({ isLoading }),
  setAllSessionsLoading: (allSessionsLoading) => set({ allSessionsLoading }),
  setError: (error) => set({ error }),
}));
