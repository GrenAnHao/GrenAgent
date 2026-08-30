import { create } from 'zustand';

/** 当前会话目标（由 sidecar goal 扩展经 setStatus 推送的 JSON 解析而来）。 */
export interface GoalInfo {
  condition: string;
  paused: boolean;
  react: number;
}

interface GoalStoreState {
  goal?: GoalInfo;
  setGoal: (goal?: GoalInfo) => void;
}

export const useGoalStore = create<GoalStoreState>((set) => ({
  goal: undefined,
  setGoal: (goal) => set({ goal }),
}));
