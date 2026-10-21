import type { AttentionKind } from '../../electron/app/attentionContract';
import type { PendingEntry } from './attentionPending';

export type { AttentionKind };
export type RowStatusKind = AttentionKind | 'running';

/** 需要点开才消失的未读：上一轮结果（完成 / 失败共用一格）和 Goal 受阻。 */
export interface UnreadEntry {
  path: string;
  workspace: string;
  outcome?: { kind: 'done' | 'failed'; message?: string; seq: number };
  blocked?: { message?: string };
}

export interface SessionAttentionState {
  pending?: PendingEntry;
  unread?: UnreadEntry;
}

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  approval: '等待批准',
  choice: '需要你选择',
  failed: '失败',
  blocked: '任务受阻',
  done: '已完成',
};

const ERROR_TOOLTIP_MAX = 60;

/** 优先级：approval > choice > running > failed > blocked > done。 */
export function resolveRowStatus(state: SessionAttentionState | undefined, running: boolean): RowStatusKind | undefined {
  if (state?.pending) return state.pending.kind;
  if (running) return 'running';
  const unread = state?.unread;
  if (unread?.outcome?.kind === 'failed') return 'failed';
  if (unread?.blocked) return 'blocked';
  if (unread?.outcome?.kind === 'done') return 'done';
  return undefined;
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export function attentionTooltip(kind: AttentionKind, state: SessionAttentionState): string {
  switch (kind) {
    case 'approval':
      return `等待批准：${state.pending?.title ?? '有操作等待批准'}`;
    case 'choice':
      return `等待你选择：${state.pending?.title ?? '有问题等你回答'}`;
    case 'failed': {
      const message = state.unread?.outcome?.message?.trim();
      return `失败：${message ? truncate(message, ERROR_TOOLTIP_MAX) : '回合出错'}`;
    }
    case 'blocked':
      return `Goal 受阻：${state.unread?.blocked?.message?.trim() || '需要你处理'}`;
    case 'done':
      return '已完成，未查看';
  }
}

/** 算进任务栏 / 分组头数字的状态：等待中的请求、上一轮失败、Goal 受阻。完成不算。 */
export function needsAction(state: SessionAttentionState | undefined): boolean {
  if (!state) return false;
  return Boolean(state.pending || state.unread?.outcome?.kind === 'failed' || state.unread?.blocked);
}

export function attentionCount(
  states: Iterable<[key: string, SessionAttentionState]>,
  listed?: ReadonlySet<string>,
): number {
  let count = 0;
  for (const [key, state] of states) {
    if (listed && !listed.has(key)) continue;
    if (needsAction(state)) count += 1;
  }
  return count;
}

const PRIORITY: RowStatusKind[] = ['approval', 'choice', 'running', 'failed', 'blocked', 'done'];

/** 折叠分组头：组里最高优先级的状态，加需要处理的会话数。 */
export function summarizeGroup(
  items: Array<{ state: SessionAttentionState | undefined; running: boolean }>,
): { kind: RowStatusKind; count: number } | undefined {
  let top: RowStatusKind | undefined;
  let count = 0;
  for (const { state, running } of items) {
    const kind = resolveRowStatus(state, running);
    if (kind && (!top || PRIORITY.indexOf(kind) < PRIORITY.indexOf(top))) top = kind;
    if (needsAction(state)) count += 1;
  }
  return top ? { kind: top, count } : undefined;
}
