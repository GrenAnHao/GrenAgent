import { create } from 'zustand';

interface PlanModeState {
  /** 当前模式徽章文本（如 "📋 Plan" / "▶ 2/5"）；undefined 表示非规划模式。 */
  status?: string;
  setStatus: (status?: string) => void;
}

export const usePlanModeStore = create<PlanModeState>((set) => ({
  status: undefined,
  setStatus: (status) => set({ status }),
}));
