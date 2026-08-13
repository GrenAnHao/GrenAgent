import { create } from 'zustand';

export interface VisualState {
  html: string | null;
  mode: 'inline' | 'panel' | null;
  pending: boolean;
  sessionId: number;
  requestId: string | null;
  /** 已提交过的 sessionId 集合——会话内持久，防止重新切回对话后卡片变成可点击 */
  submittedIds: Set<number>;
  setVisual: (html: string, mode: 'inline' | 'panel') => void;
  setPending: (pending: boolean, requestId?: string) => void;
  markSubmitted: (id: number) => void;
  clearVisual: () => void;
}

export const useVisualStore = create<VisualState>()((set, get) => ({
  html: null,
  mode: null,
  pending: false,
  sessionId: 0,
  requestId: null,
  submittedIds: new Set(),

  setVisual: (html, mode) =>
    set((s) => ({ html, mode, sessionId: s.sessionId + 1 })),

  setPending: (pending, requestId) =>
    set({ pending, requestId: requestId ?? get().requestId }),

  markSubmitted: (id) =>
    set((s) => ({ submittedIds: new Set([...s.submittedIds, id]) })),

  clearVisual: () => set({ html: null, mode: null, pending: false, requestId: null }),
}));
