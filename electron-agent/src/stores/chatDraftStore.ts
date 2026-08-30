import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ChatDraftState {
  /**
   * 会话 key → 未发送的输入草稿（markdown）。
   * key 由 ChatInput 决定：优先用 activeSessionPath（每会话独立），新建/草稿对话还没落盘 session 时回退 workspace(cwd)。
   * 持久化到 localStorage（pi-chat-drafts），重启 app 后恢复。
   */
  drafts: Record<string, string>;
  getDraft: (key: string) => string;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
}

export const useChatDraftStore = create<ChatDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => get().drafts[key] ?? '',
      setDraft: (key, text) =>
        set((s) => {
          const cur = s.drafts[key] ?? '';
          if (cur === text) return s;
          // 空草稿直接删 key，避免 localStorage 堆积空串。
          if (!text) {
            if (!(key in s.drafts)) return s;
            const next = { ...s.drafts };
            delete next[key];
            return { drafts: next };
          }
          return { drafts: { ...s.drafts, [key]: text } };
        }),
      clearDraft: (key) =>
        set((s) => {
          if (!(key in s.drafts)) return s;
          const next = { ...s.drafts };
          delete next[key];
          return { drafts: next };
        }),
    }),
    { name: 'pi-chat-drafts' },
  ),
);
