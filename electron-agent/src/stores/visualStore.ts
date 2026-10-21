import { create } from 'zustand';
import { dockSessionKey } from './dockStore';
import { pathsEquivalent } from '../lib/pathUtils';
import type { PiEventEnvelope } from '../lib/pi';

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
  /** 宿主不再等这条确认（超时 / 撤回）：按 requestId 把对应条目改回不在等。 */
  dismissRequest: (requestId: string) => void;
  /** 会话这一轮结束：read_visual_choice 是回合内的阻塞工具，它的请求已经没人等了。 */
  settlePending: (owner: VisualOwner) => void;
}

function withoutPending(entries: Record<string, VisualEntry>, match: (entry: VisualEntry) => boolean): Record<string, VisualEntry> | undefined {
  let next: Record<string, VisualEntry> | undefined;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry.pending || !match(entry)) continue;
    next ??= { ...entries };
    next[key] = { ...entry, pending: false, requestId: null };
  }
  return next;
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

  dismissRequest: (requestId) =>
    set((s) => {
      const entries = withoutPending(s.entries, (entry) => entry.requestId === requestId);
      return entries ? { entries } : s;
    }),

  settlePending: (owner) =>
    set((s) => {
      const entries = withoutPending(s.entries, (entry) =>
        entry.sessionPath && owner.sessionPath
          ? pathsEquivalent(entry.sessionPath, owner.sessionPath)
          : entry.sessionPath === null && pathsEquivalent(entry.workspace, owner.workspace),
      );
      return entries ? { entries } : s;
    }),

  clearVisual: (owner) =>
    set((s) => {
      const key = visualKeyOf(owner);
      if (!s.entries[key]) return s;
      const { [key]: _gone, ...rest } = s.entries;
      void _gone;
      return { entries: rest };
    }),
}));

/**
 * 交互会话一轮结束（不重试的 agent_end 或 agent_settled）时，把它名下还挂着的视觉设计确认改回不在等。
 * 否则 read_visual_choice 超时或回合被中断后，面板还能点、侧栏「需要你选择」角标一直亮。
 */
export function settleVisualOnTurnEnd(env: PiEventEnvelope): void {
  if (env.source === 'goal' || env.source === 'subagent') return;
  const sessionPath = typeof env.sessionPath === 'string' && env.sessionPath ? env.sessionPath : undefined;
  if (!sessionPath) return;
  const event = env.event as { type?: string; willRetry?: boolean };
  const ended = event.type === 'agent_settled' || (event.type === 'agent_end' && event.willRetry !== true);
  if (ended) useVisualStore.getState().settlePending({ sessionPath, workspace: env.workspace });
}
