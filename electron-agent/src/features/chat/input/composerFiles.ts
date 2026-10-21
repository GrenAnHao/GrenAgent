import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createIdbStorage } from '../../../lib/idbStorage';
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
   * 持久化到 IndexedDB（pi-composer-files），不进 localStorage：图片是 base64，几张就撑爆 5~10MB 配额。
   * 见 .agents/notes/implemented/feature/2026-10-19-composer-draft-full-restore.md
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

/** 落盘时去掉 url：它要么是整份 data URL（和 data 重复一倍），要么是重启后就失效的 blob URL。 */
export function stripAttachmentUrls(byKey: Record<string, ComposerFiles>): Record<string, ComposerFiles> {
  const out: Record<string, ComposerFiles> = {};
  for (const [key, files] of Object.entries(byKey)) {
    out[key] = {
      ...files,
      attachments: files.attachments.map(({ url: _url, ...rest }) => rest as ImageAttachment),
    };
  }
  return out;
}

/** 读回来时用 data 重建 url，形状不对的条目丢掉。 */
export function reviveComposerFiles(raw: unknown): Record<string, ComposerFiles> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ComposerFiles> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const files = value as Partial<ComposerFiles>;
    const attachments = (Array.isArray(files.attachments) ? files.attachments : [])
      .filter((a): a is ImageAttachment => Boolean(a && typeof a.data === 'string' && typeof a.mimeType === 'string'))
      .map((a) => ({
        type: 'image' as const,
        mimeType: a.mimeType,
        data: a.data,
        name: typeof a.name === 'string' ? a.name : 'image',
        url: typeof a.url === 'string' && a.url.startsWith('data:') ? a.url : `data:${a.mimeType};base64,${a.data}`,
      }));
    const pastedTexts = (Array.isArray(files.pastedTexts) ? files.pastedTexts : []).filter(
      (p): p is PastedText => Boolean(p && typeof p.id === 'string' && typeof p.text === 'string'),
    );
    if (attachments.length === 0 && pastedTexts.length === 0) continue;
    out[key] = { attachments, pastedTexts };
  }
  return out;
}

/** hydration 是异步的：存档回来时内存里已经有的桶优先，启动瞬间贴进来的东西不能被覆盖。 */
export function mergeComposerFiles(
  persisted: Record<string, ComposerFiles>,
  current: Record<string, ComposerFiles>,
): Record<string, ComposerFiles> {
  return { ...persisted, ...current };
}

export const useComposerFilesStore = create<ComposerFilesState>()(
  persist(
    (set) => ({
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
    }),
    {
      name: 'pi-composer-files',
      storage: createJSONStorage(() => createIdbStorage('pi-composer-files')),
      partialize: (s) => ({ byKey: stripAttachmentUrls(s.byKey) }),
      merge: (persisted, current) => ({
        ...current,
        byKey: mergeComposerFiles(
          reviveComposerFiles((persisted as { byKey?: unknown } | undefined)?.byKey),
          current.byKey,
        ),
      }),
    },
  ),
);
