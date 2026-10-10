import { create } from 'zustand';
import type { ImageAttachment } from './ChatInputContext';
import type { PastedText } from './editor/types';

/** 输入框里还没发出去的图片和粘贴块。 */
export interface ComposerFiles {
  attachments: ImageAttachment[];
  pastedTexts: PastedText[];
}

/** 没有任何内容时所有选择器都拿到这同一个对象，避免每次渲染换引用。 */
export const EMPTY_COMPOSER_FILES: ComposerFiles = Object.freeze({
  attachments: [],
  pastedTexts: [],
}) as ComposerFiles;

interface ComposerFilesState {
  /**
   * 草稿 key → 这个 key 的待发图片和粘贴块。key 与 chatDraftStore 一致：
   * 会话文件路径，草稿对话还没落盘时回退到 workspace。
   * 只放内存、不持久化：图片是 base64，写进 localStorage 会撑爆配额。
   */
  byKey: Record<string, ComposerFiles>;
  addAttachments: (key: string, items: ImageAttachment[]) => void;
  removeAttachment: (key: string, index: number) => void;
  addPastedText: (key: string, text: PastedText) => void;
  removePastedText: (key: string, id: string) => void;
  /** 发送失败时把发送前的快照放回原 key。空快照不留空桶。 */
  restore: (key: string, files: ComposerFiles) => void;
  clear: (key: string) => void;
}

/** 写入一个 key 的新内容；两项都空就把桶删掉，key 不会越攒越多。 */
function withBucket(
  byKey: Record<string, ComposerFiles>,
  key: string,
  next: ComposerFiles,
): Record<string, ComposerFiles> {
  if (next.attachments.length === 0 && next.pastedTexts.length === 0) {
    if (!(key in byKey)) return byKey;
    const rest = { ...byKey };
    delete rest[key];
    return rest;
  }
  return { ...byKey, [key]: next };
}

export const useComposerFilesStore = create<ComposerFilesState>()((set) => ({
  byKey: {},
  addAttachments: (key, items) =>
    set((s) => {
      if (items.length === 0) return s;
      const cur = s.byKey[key] ?? EMPTY_COMPOSER_FILES;
      return { byKey: withBucket(s.byKey, key, { ...cur, attachments: [...cur.attachments, ...items] }) };
    }),
  removeAttachment: (key, index) =>
    set((s) => {
      const cur = s.byKey[key];
      if (!cur) return s;
      return {
        byKey: withBucket(s.byKey, key, { ...cur, attachments: cur.attachments.filter((_, i) => i !== index) }),
      };
    }),
  addPastedText: (key, text) =>
    set((s) => {
      const cur = s.byKey[key] ?? EMPTY_COMPOSER_FILES;
      return { byKey: withBucket(s.byKey, key, { ...cur, pastedTexts: [...cur.pastedTexts, text] }) };
    }),
  removePastedText: (key, id) =>
    set((s) => {
      const cur = s.byKey[key];
      if (!cur) return s;
      return { byKey: withBucket(s.byKey, key, { ...cur, pastedTexts: cur.pastedTexts.filter((p) => p.id !== id) }) };
    }),
  restore: (key, files) =>
    set((s) => ({
      byKey: withBucket(s.byKey, key, { attachments: files.attachments.slice(), pastedTexts: files.pastedTexts.slice() }),
    })),
  clear: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return s;
      const rest = { ...s.byKey };
      delete rest[key];
      return { byKey: rest };
    }),
}));
