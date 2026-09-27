import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolcallDeltaCoalescer } from './toolcallDeltaCoalescer.js';

function delta(contentIndex: number, text: string, extra: Record<string, unknown> = {}, usage: unknown = { output: 1 }) {
  return {
    type: 'message_update',
    usage,
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex, delta: text, ...extra },
  };
}

describe('createToolcallDeltaCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一 contentIndex 的连续 delta 合并成一条，delta 按序拼接', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push } = createToolcallDeltaCoalescer(emit);
    push(delta(0, '{"pa'));
    push(delta(0, 'th"'));
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(32);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].assistantMessageEvent.delta).toBe('{"path"');
  });

  it('不同 contentIndex 分开发', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push } = createToolcallDeltaCoalescer(emit);
    push(delta(0, 'a'));
    push(delta(1, 'b'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].assistantMessageEvent).toMatchObject({ contentIndex: 0, delta: 'a' });
    vi.advanceTimersByTime(32);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0].assistantMessageEvent).toMatchObject({ contentIndex: 1, delta: 'b' });
  });

  it('非 delta 事件到来前先 flush', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push } = createToolcallDeltaCoalescer(emit);
    push(delta(0, 'aa'));
    push(delta(0, 'bb'));
    push({ type: 'agent_end', willRetry: false });
    expect(emit.mock.calls.map((c) => c[0].type === 'message_update' ? c[0].assistantMessageEvent.delta : c[0].type)).toEqual(['aabb', 'agent_end']);
  });

  it('32ms 到时 flush', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push } = createToolcallDeltaCoalescer(emit);
    push(delta(0, 'x'));
    vi.advanceTimersByTime(31);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('手动 flush() 幂等', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push, flush } = createToolcallDeltaCoalescer(emit);
    push(delta(0, 'x'));
    flush();
    flush();
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(32);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('id / toolName 取最新非空值', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const { push, flush } = createToolcallDeltaCoalescer(emit);
    push(delta(0, 'a', { id: 'old', toolName: 'write' }));
    push(delta(0, 'b', { id: 'new' }));
    push(delta(0, 'c'));
    flush();
    expect(emit.mock.calls[0][0].assistantMessageEvent).toMatchObject({
      delta: 'abc',
      id: 'new',
      toolName: 'write',
    });
  });
});
