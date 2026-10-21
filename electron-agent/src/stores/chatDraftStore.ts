import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  composerDraftEquals,
  normalizeComposerDraft,
  type ComposerDraft,
} from '../features/chat/input/editor/composerDraft';

/** 落盘形状：老版本是纯文本字符串，新版本带 Lexical JSON；读的时候两种都认。 */
type StoredDraft = string | ComposerDraft;

interface ChatDraftState {
  /**
   * 会话 key → 未发送的输入草稿。
   * key 由 ChatInput 决定：优先用 activeSessionPath（每会话独立），新建/草稿对话还没落盘 session 时回退 workspace(cwd)。
   * 持久化到 localStorage（pi-chat-drafts），重启 app 后恢复。
   * 见 .agents/notes/implemented/feature/2026-10-19-composer-draft-full-restore.md
   */
  drafts: Record<string, StoredDraft>;
  getDraft: (key: string) => ComposerDraft;
  setDraft: (key: string, draft: ComposerDraft | string) => void;
  clearDraft: (key: string) => void;
}

export const useChatDraftStore = create<ChatDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => normalizeComposerDraft(get().drafts[key]),
      setDraft: (key, draft) =>
        set((s) => {
          const next = normalizeComposerDraft(draft);
          const cur = normalizeComposerDraft(s.drafts[key]);
          if (composerDraftEquals(cur, next)) return s;
          // 空草稿直接删 key，避免 localStorage 堆积空串。
          if (!next.text) {
            if (!(key in s.drafts)) return s;
            const rest = { ...s.drafts };
            delete rest[key];
            return { drafts: rest };
          }
          return { drafts: { ...s.drafts, [key]: next } };
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
