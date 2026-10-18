import { create } from 'zustand';
import { dockSessionKey } from './dockStore';

/** 发起视觉设计的会话。sessionPath 为 null 表示还没有落盘路径的草稿会话。 */
export interface VisualOwner {
  sessionPath: string | null;
  workspace: string;
}

/** 一个会话名下的视觉设计：页面、等待中的确认请求都跟着发起它的会话走。 */
export interface VisualEntry extends VisualOwner {
  html: string;
  mode: 'inline' | 'panel';
  /** 每次 setVisual 全局递增：换页面时 iframe 重挂、已提交标记按它区分。 */
  rev: number;
  pending: boolean;
  requestId: string | null;
}

export interface VisualState {
  /** key = visualKeyOf(owner)。多个会话的视觉设计并存，互不覆盖。 */
  entries: Record<string, VisualEntry>;
  seq: number;
  /** 已提交过的 rev 集合——会话内持久，防止切回对话后卡片 / 面板变成可点击 */
  submittedIds: Set<number>;
  setVisual: (owner: VisualOwner, html: string, mode: 'inline' | 'panel') => void;
  setPending: (owner: VisualOwner, pending: boolean, requestId?: string) => void;
  markSubmitted: (rev: number) => void;
  clearVisual: (owner: VisualOwner) => void;
}

/** 与右坞会话归属同一套 key，路径写法不同（大小写 / 斜杠）也算同一个会话。 */
export function visualKeyOf(owner: VisualOwner): string {
  return dockSessionKey(owner);
}

export const useVisualStore = create<VisualState>()((set) => ({
  entries: {},
  seq: 0,
  submittedIds: new Set(),

  // 不动 pending / requestId：read_visual_choice 的请求可能先于或后于换页到达，各自独立。
  setVisual: (owner, html, mode) =>
    set((s) => {
      const key = visualKeyOf(owner);
      const prev = s.entries[key];
      const rev = s.seq + 1;
      const entry: VisualEntry = {
        sessionPath: owner.sessionPath,
        workspace: owner.workspace,
        html,
        mode,
        rev,
        pending: prev?.pending ?? false,
        requestId: prev?.requestId ?? null,
      };
      return { seq: rev, entries: { ...s.entries, [key]: entry } };
    }),

  setPending: (owner, pending, requestId) =>
    set((s) => {
      const key = visualKeyOf(owner);
      const prev = s.entries[key];
      // 请求先到、页面还没到：先占位，页面到了再补 html（空 html 的条目不会被渲染）。
      const base: VisualEntry = prev ?? {
        sessionPath: owner.sessionPath,
        workspace: owner.workspace,
        html: '',
        mode: 'inline',
        rev: 0,
        pending: false,
        requestId: null,
      };
      return {
        entries: { ...s.entries, [key]: { ...base, pending, requestId: requestId ?? base.requestId } },
      };
    }),

  markSubmitted: (rev) => set((s) => ({ submittedIds: new Set([...s.submittedIds, rev]) })),

  clearVisual: (owner) =>
    set((s) => {
      const key = visualKeyOf(owner);
      if (!s.entries[key]) return s;
      const { [key]: _gone, ...rest } = s.entries;
      void _gone;
      return { entries: rest };
    }),
}));
