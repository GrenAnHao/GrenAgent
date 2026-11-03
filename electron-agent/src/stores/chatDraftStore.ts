import { create } from 'zustand';
import {
  composerDraftEquals,
  normalizeComposerDraft,
  type ComposerDraft,
} from '../features/chat/input/editor/composerDraft';

/** 旧版本的整表存档只读兼容；新写入逐 owner 存，避免窗口之间覆盖无关草稿。 */
const LEGACY_STORAGE_KEY = 'pi-chat-drafts';
const STORAGE_PREFIX = 'pi-chat-draft:';
type StoredDraft = string | ComposerDraft;

function readDrafts(): Record<string, StoredDraft> {
  const drafts: Record<string, StoredDraft> = {};
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (legacy?.state?.drafts && typeof legacy.state.drafts === 'object') Object.assign(drafts, legacy.state.drafts);
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      const key = decodeURIComponent(storageKey.slice(STORAGE_PREFIX.length));
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (value === null) delete drafts[key];
      else drafts[key] = normalizeComposerDraft(value);
    }
  } catch { /* 无存储或旧数据损坏时保留可读的内存草稿。 */ }
  return drafts;
}

function readOwner(key: string): ComposerDraft | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + encodeURIComponent(key));
    return raw === null ? undefined : normalizeComposerDraft(JSON.parse(raw));
  } catch { return undefined; }
}

function writeOwner(key: string, value: ComposerDraft | null): void {
  try {
    // null 同时遮住旧整表中的同名记录；删会话后旧存档不会再次复活。
    localStorage.setItem(STORAGE_PREFIX + encodeURIComponent(key), JSON.stringify(value));
  } catch { /* 配额异常时仍保留当前内存内容。 */ }
}

interface ChatDraftState {
  /** JSONL 路径或独立 draft:<uuid> → 正文、胶囊与文件标签的编辑器快照。 */
  drafts: Record<string, StoredDraft>;
  /** 仅运行期：首发后的旧回调仍归新会话；删除墓碑拒绝迟到保存。 */
  adoptions: Record<string, string>;
  removed: Record<string, true>;
  resolveKey: (key: string) => string | null;
  adopt: (from: string, to: string) => void;
  remove: (key: string) => void;
  getDraft: (key: string) => ComposerDraft;
  setDraft: (key: string, draft: ComposerDraft | string) => void;
  clearDraft: (key: string) => void;
}

export const useChatDraftStore = create<ChatDraftState>((set, get) => ({
  drafts: readDrafts(),
  adoptions: {},
  removed: {},
  resolveKey: (key) => {
    const s = get();
    const target = s.adoptions[key] ?? key;
    return s.removed[target] ? null : target;
  },
  adopt: (from, to) => set((s) => {
    if (!from || !to || from === to || s.removed[to]) return s;
    const drafts = { ...s.drafts };
    const source = normalizeComposerDraft(drafts[from] ?? readOwner(from));
    const target = normalizeComposerDraft(drafts[to] ?? readOwner(to));
    if (!target.text && source.text) drafts[to] = source;
    if (drafts[to]) writeOwner(to, normalizeComposerDraft(drafts[to]));
    delete drafts[from];
    writeOwner(from, null);
    return { drafts, adoptions: { ...s.adoptions, [from]: to } };
  }),
  remove: (key) => set((s) => {
    const target = s.adoptions[key] ?? key;
    const drafts = { ...s.drafts };
    delete drafts[target];
    delete drafts[key];
    writeOwner(target, null);
    if (key !== target) writeOwner(key, null);
    return { drafts, removed: { ...s.removed, [target]: true } };
  }),
  getDraft: (key) => {
    const target = get().resolveKey(key);
    if (!target) return normalizeComposerDraft(undefined);
    // 另一个窗口可能已经更新该会话；进入时读取该 owner 的最新存档。
    return readOwner(target) ?? normalizeComposerDraft(get().drafts[target]);
  },
  setDraft: (key, draft) => set((s) => {
    const target = s.resolveKey(key);
    if (!target) return s;
    const next = normalizeComposerDraft(draft);
    const cur = normalizeComposerDraft(s.drafts[target]);
    if (composerDraftEquals(cur, next)) return s;
    writeOwner(target, next.text ? next : null);
    if (!next.text) {
      const drafts = { ...s.drafts };
      delete drafts[target];
      return { drafts };
    }
    return { drafts: { ...s.drafts, [target]: next } };
  }),
  clearDraft: (key) => set((s) => {
    const target = s.resolveKey(key);
    if (!target) return s;
    writeOwner(target, null);
    if (!(target in s.drafts)) return s;
    const drafts = { ...s.drafts };
    delete drafts[target];
    return { drafts };
  }),
}));
