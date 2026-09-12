import { create } from 'zustand';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalHistoryItem =
  | {
      source: 'event';
      kind: string;
      goalId: string;
      revision: number;
      at: string;
      payload: Record<string, unknown>;
    }
  | {
      source: 'round';
      goalId: string;
      revision: number;
      round: number;
      content?: string;
    };

export interface GoalSnapshot {
  goalId: string;
  sessionId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsStarted: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  activation: 'armed' | 'disarmed';
  blockedReason?: { code: string; message: string };
  history?: GoalHistoryItem[];
}

/** 旧版 setStatus 投影的形状，仅保留给插件兼容层，不参与会话 Goal 渲染。 */
export interface GoalInfo {
  condition: string;
  paused: boolean;
  react: number;
}

export interface GoalStoreState {
  /** 当前会话 Goal 投影；sessionId 来自信封，是唯一索引。 */
  bySession: Record<string, GoalSnapshot>;
  /** @deprecated 旧扩展状态兼容字段，禁止作为当前会话 Goal 的权威来源。 */
  goal?: GoalInfo;
  setSnapshot: (sessionId: string, snapshot?: GoalSnapshot) => void;
  getSnapshot: (sessionId: string) => GoalSnapshot | undefined;
  clearSnapshot: (sessionId: string, revision: number) => void;
  dropSession: (sessionId: string) => void;
  /** @deprecated 仅供旧扩展状态兼容，不写入 bySession。 */
  setGoal: (goal?: GoalInfo) => void;
}

export const useGoalStore = create<GoalStoreState>((set, get) => ({
  bySession: {},
  goal: undefined,

  setSnapshot: (sessionId, snapshot) => {
    if (!sessionId.trim()) return;
    set((state) => {
      const current = state.bySession[sessionId];
      // Goal revisions 是单调递增的 CAS 版本。迟到事件不能回写较新的 UI 投影。
      if (snapshot && snapshot.sessionId !== sessionId) return state;
      if (snapshot && current) {
        if (snapshot.goalId === current.goalId && snapshot.revision <= current.revision) return state;
        // A cleared Goal may be followed by a new generation whose revision
        // starts at 1. Prefer the newer generation, while rejecting a late
        // event from an older generation when its creation time is known.
        if (snapshot.goalId !== current.goalId) {
          const nextCreated = Date.parse(snapshot.createdAt);
          const currentCreated = Date.parse(current.createdAt);
          if (Number.isFinite(nextCreated) && Number.isFinite(currentCreated) && nextCreated < currentCreated) return state;
          if (Number.isFinite(nextCreated) && Number.isFinite(currentCreated) && nextCreated === currentCreated
            && snapshot.updatedAt < current.updatedAt) return state;
        }
      }
      const bySession = { ...state.bySession };
      if (snapshot) bySession[sessionId] = snapshot;
      else delete bySession[sessionId];
      return { bySession };
    });
  },

  getSnapshot: (sessionId) => get().bySession[sessionId],

  clearSnapshot: (sessionId, revision) => {
    if (!sessionId.trim() || !Number.isSafeInteger(revision)) return;
    set((state) => {
      const current = state.bySession[sessionId];
      if (!current || current.revision !== revision) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },

  dropSession: (sessionId) => {
    if (!sessionId.trim()) return;
    set((state) => {
      if (!state.bySession[sessionId]) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },

  setGoal: (goal) => set({ goal }),
}));
