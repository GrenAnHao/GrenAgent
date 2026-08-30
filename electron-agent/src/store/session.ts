import { create } from 'zustand';
import type { SessionInfo } from '../lib/pi';
import { mergeAllSessions, pruneOptimisticSessions } from '../lib/mergeSessions';
import { pathsEquivalent } from '../lib/pathUtils';

interface SessionStore {
  sessions: SessionInfo[]; // 当前 workspace 的会话（保留，兼容现有用法）
  allSessions: SessionInfo[]; // 跨项目全量会话
  optimisticSessions: SessionInfo[]; // 尚未落盘、侧栏占位用
  deletedConversationCwds: string[]; // 已乐观删除、等待后台清理完成的对话 cwd
  deletedSessionPaths: string[]; // 已乐观删除、等待后台清理完成的会话 path
  registeredProjects: string[]; // 已打开但可能尚无 session 文件的项目 cwd
  worksDir: string; // ~/.pi/agent/works 的 canonical 前缀（区分对话/项目）
  activeWorkspace: string; // 当前选中项目 cwd（替代常量 WORKSPACE，默认 '.'）
  draftConversationCwd: string | null; // 新建但尚未首发落盘 session 的空白对话 cwd
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
  hideDeletedConversation: (cwd: string) => void;
  unhideDeletedConversation: (cwd: string) => void;
  /** 乐观删除单个会话：先从侧栏隐藏，后台删除完成后由 syncAllSessions 自动清理隐藏集。 */
  hideDeletedSession: (path: string) => void;
  unhideDeletedSession: (path: string) => void;
  registerProject: (cwd: string) => void;
  unregisterProject: (cwd: string) => void;
  getMergedSessions: () => SessionInfo[];
  setWorksDir: (dir: string) => void;
  setActiveWorkspace: (cwd: string) => void;
  setDraftConversation: (cwd: string | null) => void;
  clearDraftConversation: (cwd?: string) => void;
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
  deletedConversationCwds: [],
  deletedSessionPaths: [],
  registeredProjects: [],
  worksDir: '',
  activeWorkspace: '',
  draftConversationCwd: null,
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
      // 不再按单次磁盘列表自动撤销 deletedSessionPaths。会话文件名唯一、删后不会再生，故隐藏标记
      // 保持到本次运行结束即可（删除失败时由 unhideDeletedSession 撤销）。先前的「列表不含该 path 即
      // 撤销隐藏」在切换对话触发的多次 list_all_sessions 下不安全：删除前发出的旧请求（仍含该 path）
      // 乱序晚到、或切换重扫会把已删会话写回 allSessions，而隐藏标记已被提前撤销 → 已删项重新显示。
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
  hideDeletedConversation: (cwd) =>
    set((s) =>
      s.deletedConversationCwds.some((x) => pathsEquivalent(x, cwd))
        ? s
        : { deletedConversationCwds: [...s.deletedConversationCwds, cwd] },
    ),
  unhideDeletedConversation: (cwd) =>
    set((s) => ({
      deletedConversationCwds: s.deletedConversationCwds.filter((x) => !pathsEquivalent(x, cwd)),
    })),
  hideDeletedSession: (path) =>
    set((s) =>
      s.deletedSessionPaths.some((x) => pathsEquivalent(x, path))
        ? s
        : { deletedSessionPaths: [...s.deletedSessionPaths, path] },
    ),
  unhideDeletedSession: (path) =>
    set((s) => ({
      deletedSessionPaths: s.deletedSessionPaths.filter((x) => !pathsEquivalent(x, path)),
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
  setDraftConversation: (draftConversationCwd) => set({ draftConversationCwd }),
  clearDraftConversation: (cwd) =>
    set((s) =>
      !cwd || (s.draftConversationCwd && pathsEquivalent(s.draftConversationCwd, cwd))
        ? { draftConversationCwd: null }
        : s,
    ),
  setActiveSession: (path) => set({ activeSessionPath: path }),
  setWorkspaceSessionPath: (workspace, path) =>
    set((s) => ({ workspaceSessionPaths: { ...s.workspaceSessionPaths, [workspace]: path } })),
  setSearchKeyword: (searchKeyword) => set({ searchKeyword }),
  setLoading: (isLoading) => set({ isLoading }),
  setAllSessionsLoading: (allSessionsLoading) => set({ allSessionsLoading }),
  setError: (error) => set({ error }),
}));
