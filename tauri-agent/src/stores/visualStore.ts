import { create } from 'zustand';

export interface VisualState {
  html: string | null;
  mode: 'inline' | 'panel' | null;
  /** true = read_visual_choice 正在等待用户选择 */
  pending: boolean;
  /** 每次 setVisual 递增，用于 key 强制重挂载 iframe */
  sessionId: number;
  /** 当前 pending 对应的 ui-request id（用于 respondUi 回传） */
  requestId: string | null;
  setVisual: (html: string, mode: 'inline' | 'panel') => void;
  setPending: (pending: boolean, requestId?: string) => void;
  clearVisual: () => void;
}

export const useVisualStore = create<VisualState>()((set, get) => ({
  html: null,
  mode: null,
  pending: false,
  sessionId: 0,
  requestId: null,

  setVisual: (html, mode) =>
    set((s) => ({
      html,
      mode,
      sessionId: s.sessionId + 1,
    })),

  setPending: (pending, requestId) =>
    set({ pending, requestId: requestId ?? get().requestId }),

  clearVisual: () => set({ html: null, mode: null, pending: false, requestId: null }),
}));
