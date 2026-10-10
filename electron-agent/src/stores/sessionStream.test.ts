import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../lib/pi';
import { initialAgentState, type AgentState } from './agentReducer';
import * as reducer from './agentReducer';
import { BACKGROUND_FLUSH_MS, createSessionStream } from './sessionStream';

function harness() {
  let state: AgentState = initialAgentState();
  const setState = vi.fn((next: AgentState) => {
    state = next;
  });
  const committed = vi.fn();
  const stream = createSessionStream({ getState: () => state, setState, onCommitted: committed });
  return { stream, setState, committed, get: () => state };
}

const thinking = (delta: string): AgentEvent =>
  ({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } }) as unknown as AgentEvent;
const start = { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } } as unknown as AgentEvent;
const end = {
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1 },
} as unknown as AgentEvent;

describe('createSessionStream', () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  const flushRAF = () => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    for (const cb of cbs) cb(0);
  };

  beforeEach(() => {
    rafCallbacks = [];
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('一帧内的多条事件只 setState 一次，delta 按顺序累加', () => {
    const h = harness();
    h.stream.push(start);
    h.stream.push(thinking('Wal'));
    h.stream.push(thinking('king'));
    expect(h.setState).not.toHaveBeenCalled();
    flushRAF();
    expect(h.setState).toHaveBeenCalledTimes(1);
    const last = h.get().messages.at(-1);
    expect(last).toMatchObject({ kind: 'assistant', thinking: 'Walking', streaming: true });
  });

  it('九条并发流将连续增量合并后再走 reducer，保留正文、思考和消息边界', () => {
    const apply = vi.spyOn(reducer, 'applyEvent');
    const streams = Array.from({ length: 9 }, () => harness());
    for (let i = 0; i < 200; i++) {
      for (const h of streams) {
        if (i === 0) h.stream.push(start);
        h.stream.push(thinking('想'));
      }
    }
    for (let i = 0; i < 200; i++) {
      for (const h of streams) {
        h.stream.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '字' } });
      }
    }
    for (const h of streams) h.stream.push({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '字'.repeat(200) }], timestamp: 1 },
    });
    flushRAF();
    for (const h of streams) {
      expect(h.get().messages[0]).toMatchObject({ text: '字'.repeat(200), thinking: '想'.repeat(200), streaming: false });
    }
    expect(apply).toHaveBeenCalledTimes(9 * 4);
  });

  it('合并增量不跨 contentIndex、完整快照与新消息边界', () => {
    const apply = vi.spyOn(reducer, 'applyEvent');
    const h = harness();
    h.stream.push(start);
    h.stream.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'a', contentIndex: 0 } });
    h.stream.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'b', contentIndex: 1 } });
    h.stream.push({
      type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'snapshot' }] },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'c', contentIndex: 1 },
    });
    h.stream.push(thinking('!'));
    h.stream.push(end);
    h.stream.push({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } });
    h.stream.push(thinking('new'));
    flushRAF();
    expect(apply).toHaveBeenCalledTimes(8);
    expect(h.get().messages[0]).toMatchObject({ thinking: 'snapshot!', text: 'done', streaming: false });
    expect(h.get().messages[1]).toMatchObject({ thinking: 'new', streaming: true });
  });

  it('毒事件只丢自己，不中断同一批里后面的事件', () => {
    const h = harness();
    h.stream.push(start);
    h.stream.push({ type: 'message_start' } as unknown as AgentEvent);
    h.stream.push(thinking('ok'));
    flushRAF();
    expect(h.get().messages.at(-1)).toMatchObject({ kind: 'assistant', thinking: 'ok' });
  });

  it('rAF 被暂停时靠 setTimeout 兜底 flush', () => {
    const h = harness();
    h.stream.push(start);
    h.stream.push(thinking('x'));
    expect(h.setState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS);
    expect(h.get().messages.at(-1)).toMatchObject({ thinking: 'x' });
    // 兜底先到，随后补发的 rAF 回调是幂等的空 flush，不会重复 setState。
    const calls = h.setState.mock.calls.length;
    flushRAF();
    expect(h.setState.mock.calls.length).toBe(calls);
  });

  it('setActive(false) 时直接走 setTimeout，不用 rAF', () => {
    const h = harness();
    h.stream.setActive(false);
    h.stream.push(start);
    expect(rafCallbacks).toHaveLength(0);
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS);
    expect(h.get().messages).toHaveLength(1);
  });

  it('大参数草稿被推迟后，不再有事件也会自动补一次解析', () => {
    const h = harness();
    h.stream.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'w1', toolName: 'write' },
    } as unknown as AgentEvent);
    h.stream.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":"a.txt","content":"hi' },
    } as unknown as AgentEvent);
    flushRAF();
    expect(h.get().messages.find((m) => m.kind === 'tool')).toMatchObject({ args: { path: 'a.txt', content: 'hi' } });

    h.stream.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'x'.repeat(64 * 1024) },
    } as unknown as AgentEvent);
    flushRAF();
    // 刚解析过且草稿很大：这一帧先不解析，卡片参数停在旧值。
    expect(h.get().toolDrafts?.[0]?.dirty).toBe(true);
    expect(h.get().messages.find((m) => m.kind === 'tool')).toMatchObject({ args: { path: 'a.txt', content: 'hi' } });

    vi.advanceTimersByTime(150);
    expect(h.get().toolDrafts?.[0]?.dirty).toBe(false);
    const card = h.get().messages.find((m) => m.kind === 'tool');
    expect(card?.kind === 'tool' ? JSON.stringify(card.args).length : 0).toBeGreaterThan(1000);
  });

  it('clear 丢弃未应用的事件并取消调度', () => {
    const h = harness();
    h.stream.push(start);
    expect(h.stream.hasPending()).toBe(true);
    h.stream.clear();
    expect(h.stream.hasPending()).toBe(false);
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS * 2);
    expect(h.setState).not.toHaveBeenCalled();
  });

  it('message_end 标记 reachedEnd，agent_start / agent_end 推进 epoch', () => {
    const h = harness();
    h.stream.push({ type: 'agent_start' } as unknown as AgentEvent);
    h.stream.push(start);
    flushRAF();
    expect(h.committed).toHaveBeenLastCalledWith(expect.objectContaining({ reachedEnd: false }));
    expect(h.stream.epoch()).toBe(1);

    h.stream.push(end);
    h.stream.push({ type: 'agent_end', willRetry: false } as unknown as AgentEvent);
    flushRAF();
    expect(h.committed).toHaveBeenLastCalledWith(expect.objectContaining({ reachedEnd: true }));
    expect(h.stream.epoch()).toBe(2);
  });
});
