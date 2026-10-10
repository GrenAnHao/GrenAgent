import { parsePartialArgs } from '../lib/streamingJson';
import { saveThinkingDuration } from '../lib/thinkingDurations';
import type { AgentEvent } from '../lib/pi';
import {
  applyEvent,
  LARGE_PARSE_INTERVAL_MS,
  materializeToolDrafts,
  type AgentState,
} from './agentReducer';

/** rAF 被浏览器暂停（最小化、隐藏、webview 节流）时，用 setTimeout 兜底唤醒 flush。 */
export const BACKGROUND_FLUSH_MS = 60;

export interface SessionStreamOptions {
  getState: () => AgentState;
  /** 整份替换 state。 */
  setState: (next: AgentState) => void;
  /**
   * 一批事件已经写进 state 之后调用。
   * reachedEnd：这批里有 message_end / agent_end / 压缩结束，调用方在这时落缓存、落盘。
   */
  onCommitted?: (info: { state: AgentState; reachedEnd: boolean }) => void;
}

export interface SessionStream {
  /** 入队并安排下一帧 flush。 */
  push: (event: AgentEvent) => void;
  /** 立刻把队列里的事件应用掉；队列空时只补解析被推迟的工具草稿。 */
  flush: () => void;
  hasPending: () => boolean;
  /** 丢弃未应用的事件并取消所有定时器（切换、重置、销毁时调用）。 */
  clear: () => void;
  /** 非 active 时不用 rAF，直接走 setTimeout。 */
  setActive: (active: boolean) => void;
  /** agent_start / agent_end / agent_settled 每应用一条就加一。 */
  epoch: () => number;
}

/** 推理结束后把实时计出的时长按消息 timestamp 落盘（供之后从 JSONL 还原时回填）。 */
export function persistThinkingDurations(state: AgentState): void {
  for (const m of state.messages) {
    if (m.kind === 'assistant' && m.thinking && m.timestamp != null && m.thinkingDuration != null) {
      saveThinkingDuration(m.timestamp, m.thinkingDuration);
    }
  }
}

/**
 * 被动收流的核心：事件入队，按动画帧批量套进 reducer，再把工具草稿解析成卡片参数。
 *
 * 主代理（agent.ts）和子代理详情（useChildSessionBinding）共用这一份，
 * 这样两边的批处理、毒事件隔离、大参数延迟解析、rAF 暂停兜底永远一致。
 * 高频 delta 一帧内合并成一次 setState；打字机视觉由 Markdown animated 承担，不丢事件、保持顺序。
 */
export function createSessionStream(options: SessionStreamOptions): SessionStream {
  let queue: AgentEvent[] = [];
  let epoch = 0;
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let active = true;

  const hasDirtyDraft = (state: AgentState) =>
    Boolean(state.toolDrafts && Object.values(state.toolDrafts).some((draft) => draft.dirty));

  function cancelFrame(): void {
    if (rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timeoutId != null) clearTimeout(timeoutId);
    rafId = null;
    timeoutId = null;
  }

  function scheduleDraftParse(): void {
    if (draftTimer != null) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      flush();
    }, LARGE_PARSE_INTERVAL_MS);
  }

  function flush(): void {
    // 双保险下可能挂着一个未触发的调度：取消它，避免重复 flush（幂等但浪费一帧）。
    cancelFrame();
    if (!queue.length) {
      const current = options.getState();
      if (!hasDirtyDraft(current)) return;
      const { state: materialized, deferred } = materializeToolDrafts(current, Date.now(), parsePartialArgs);
      options.setState(materialized);
      if (deferred) scheduleDraftParse();
      return;
    }
    const events = queue;
    queue = [];
    let state = options.getState();
    let reachedEnd = false;
    for (const ev of events) {
      // 单个「毒事件」apply 失败只丢自己，不中断整批——否则长任务恢复时一批事件里
      // 一个异常会把其后的正文/thinking 全部丢弃，表现为「跑到一半直接停了」。
      try {
        state = applyEvent(state, ev);
      } catch {
        continue;
      }
      if (ev.type === 'agent_start' || ev.type === 'agent_end' || ev.type === 'agent_settled') {
        epoch += 1;
      }
      if (ev.type === 'message_end' || ev.type === 'agent_end' || (ev.type === 'compaction_end' && ev.aborted !== true)) {
        reachedEnd = true;
      }
    }
    const { state: materialized, deferred } = materializeToolDrafts(state, Date.now(), parsePartialArgs);
    state = materialized;
    if (deferred) scheduleDraftParse();
    options.setState(state);
    options.onCommitted?.({ state, reachedEnd });
  }

  function scheduleFlush(): void {
    if (rafId != null || timeoutId != null) return;
    if (active && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush);
      // 双保险：rAF 会被浏览器暂停，一旦暂停 rafId 永久非 null，此前的单 rAF 调度会把
      // setTimeout 兜底永久挡死（rafId != null 直接 return），queue 无限堆积、UI 冻结成
      // 「跑到一半直接停了」。补一个 timeout 兜底唤醒，flush 时取消未触发的一方。
      timeoutId = setTimeout(flush, BACKGROUND_FLUSH_MS);
    } else {
      timeoutId = setTimeout(flush, BACKGROUND_FLUSH_MS);
    }
  }

  return {
    push(event) {
      // 只合并没有 message 快照的相邻正文/思考增量，不跨消息、工具或 contentIndex 边界。
      // 否则即使一帧只 setState 一次，reducer 仍会为每个 token 复制整份历史数组。
      const previous = queue.at(-1);
      const currentDelta = event.type === 'message_update' && !event.message
        ? event.assistantMessageEvent as { type?: string; delta?: unknown; contentIndex?: unknown }
        : undefined;
      const previousDelta = previous?.type === 'message_update' && !previous.message
        ? previous.assistantMessageEvent as { type?: string; delta?: unknown; contentIndex?: unknown }
        : undefined;
      if (
        currentDelta && previousDelta &&
        (currentDelta.type === 'text_delta' || currentDelta.type === 'thinking_delta') &&
        previousDelta.type === currentDelta.type &&
        previousDelta.contentIndex === currentDelta.contentIndex &&
        typeof previousDelta.delta === 'string' && typeof currentDelta.delta === 'string'
      ) {
        queue[queue.length - 1] = {
          ...event,
          assistantMessageEvent: { ...currentDelta, delta: previousDelta.delta + currentDelta.delta },
        } as AgentEvent;
      } else {
        queue.push(event);
      }
      scheduleFlush();
    },
    flush,
    hasPending: () => queue.length > 0,
    clear() {
      queue = [];
      cancelFrame();
      if (draftTimer != null) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
    },
    setActive(next) {
      active = next;
    },
    epoch: () => epoch,
  };
}
