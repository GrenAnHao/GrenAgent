import { create } from 'zustand';
import type { ExtensionUiRequest } from '../lib/pi';

/**
 * ChatInput 上方的内联「交互请求」：扩展经 ctx.ui.select / confirm / input 发起的请求，
 * 不再弹 Modal，而是按 workspace 暂存于此，由 PromptRequestCard 在输入框上方渲染并回传。
 *
 * 同一 workspace 一次只显示一条（byWorkspace），后来的排在 waiting 里，前一条答完或被宿主收回
 * （dismiss）再顶上来。并行的子代理会同时请求批准（extensions/_shared/approval-route.ts），
 * 新请求覆盖旧的会让前一条悄悄超时。
 */
export interface UiPromptItem {
  workspace: string;
  request: ExtensionUiRequest;
  /** 发起请求的会话。同项目多个会话同时在跑时用来把请求留在它自己的会话上。 */
  sessionPath?: string;
  /** 收到请求的时刻。带 timeout 的请求（子代理审批）据此显示倒计时。 */
  receivedAt?: number;
}

interface UiPromptState {
  byWorkspace: Record<string, UiPromptItem>;
  waiting: Record<string, UiPromptItem[]>;
  setRequest: (item: UiPromptItem) => void;
  clear: (workspace: string, id?: string) => void;
  /** 从画面和队列里摘掉满足条件的请求（切走会话时暂存用），按原顺序返回。 */
  takeWhere: (workspace: string, match: (item: UiPromptItem) => boolean) => UiPromptItem[];
  /** 宿主不再等这条请求（超时、撤回、已在别处答复）：不管在哪个工作区、显示中还是排队中都摘掉。 */
  dismiss: (id: string) => void;
}

type Slots = Pick<UiPromptState, 'byWorkspace' | 'waiting'>;

/** 把一个工作区的请求列表（第一条显示，其余排队）写回状态。 */
function withQueue(s: Slots, workspace: string, items: UiPromptItem[]): Slots {
  const byWorkspace = { ...s.byWorkspace };
  const waiting = { ...s.waiting };
  const [head, ...rest] = items;
  if (head) byWorkspace[workspace] = head;
  else delete byWorkspace[workspace];
  if (rest.length) waiting[workspace] = rest;
  else delete waiting[workspace];
  return { byWorkspace, waiting };
}

function queueOf(s: Slots, workspace: string): UiPromptItem[] {
  const head = s.byWorkspace[workspace];
  return head ? [head, ...(s.waiting[workspace] ?? [])] : [...(s.waiting[workspace] ?? [])];
}

export const useUiPromptStore = create<UiPromptState>((set, get) => ({
  byWorkspace: {},
  waiting: {},
  setRequest: (item) =>
    set((s) => {
      const stamped = item.receivedAt === undefined ? { ...item, receivedAt: Date.now() } : item;
      const queue = queueOf(s, item.workspace);
      const at = queue.findIndex((q) => q.request.id === item.request.id);
      // 同一个 id 再来一次（切回会话时放回）原地替换，不重复排队。
      const next = at >= 0 ? queue.map((q, i) => (i === at ? stamped : q)) : [...queue, stamped];
      return withQueue(s, item.workspace, next);
    }),
  clear: (workspace, id) =>
    set((s) => {
      const queue = queueOf(s, workspace);
      // 不带 id 只清画面上那条；带 id 只清那一条，避免清掉已经顶上来的别的请求。
      const at = id === undefined ? (s.byWorkspace[workspace] ? 0 : -1) : queue.findIndex((q) => q.request.id === id);
      if (at < 0) return s;
      return withQueue(s, workspace, queue.filter((_, i) => i !== at));
    }),
  takeWhere: (workspace, match) => {
    const queue = queueOf(get(), workspace);
    const taken = queue.filter(match);
    if (taken.length) set((s) => withQueue(s, workspace, queueOf(s, workspace).filter((q) => !taken.includes(q))));
    return taken;
  },
  dismiss: (id) =>
    set((s) => {
      let next: Slots = s;
      const workspaces = new Set([...Object.keys(s.byWorkspace), ...Object.keys(s.waiting)]);
      for (const workspace of workspaces) {
        const queue = queueOf(next, workspace);
        if (queue.some((q) => q.request.id === id)) {
          next = withQueue(next, workspace, queue.filter((q) => q.request.id !== id));
        }
      }
      return next === s ? s : next;
    }),
}));
