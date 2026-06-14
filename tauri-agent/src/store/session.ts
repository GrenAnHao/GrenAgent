import { create } from 'zustand';
import type { SessionInfo } from '../lib/pi';

interface SessionStore {
  sessions: SessionInfo[]; // 当前 workspace 的会话（保留，兼容现有用法）
  allSessions: SessionInfo[]; // 跨项目全量会话
  activeWorkspace: string; // 当前选中项目 cwd（替代常量 WORKSPACE，默认 '.'）
  activeSessionPath: string | null;
  searchKeyword: string;
  isLoading: boolean;
  allSessionsLoading: boolean;
  error: string | null;

  setSessions: (sessions: SessionInfo[]) => void;
  setAllSessions: (sessions: SessionInfo[]) => void;
  setActiveWorkspace: (cwd: string) => void;
  setActiveSession: (path: string) => void;
  setSearchKeyword: (kw: string) => void;
  setLoading: (loading: boolean) => void;
  setAllSessionsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  allSessions: [],
  activeWorkspace: '.',
  activeSessionPath: null,
  searchKeyword: '',
  isLoading: false,
  allSessionsLoading: false,
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setAllSessions: (allSessions) => set({ allSessions }),
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace }),
  setActiveSession: (path) => set({ activeSessionPath: path }),
  setSearchKeyword: (searchKeyword) => set({ searchKeyword }),
  setLoading: (isLoading) => set({ isLoading }),
  setAllSessionsLoading: (allSessionsLoading) => set({ allSessionsLoading }),
  setError: (error) => set({ error }),
}));
