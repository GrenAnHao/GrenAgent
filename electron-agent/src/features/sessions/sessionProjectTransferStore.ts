import { create } from 'zustand';

/** 「移动到项目…」弹窗要移动的那一份会话；null = 没打开。 */
export interface SessionProjectTransferTarget {
  sourceWorkspace: string;
  sessionPath: string;
  title: string;
}

interface SessionProjectTransferState {
  target: SessionProjectTransferTarget | null;
  open: (target: SessionProjectTransferTarget) => void;
  close: () => void;
}

/**
 * 弹窗只记「这次要移动谁」。预览、提交、重开都由弹窗自己按合同走；
 * 成功后由 App 注入的回调负责列表投影和打开目标。
 */
export const useSessionProjectTransferStore = create<SessionProjectTransferState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
