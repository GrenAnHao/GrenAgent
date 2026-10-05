import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitStreamingEnd } from './streamingGate';

function fakeSource(initial: boolean) {
  let state = { isStreaming: initial };
  const listeners = new Set<(s: { isStreaming: boolean }) => void>();
  return {
    getState: () => state,
    subscribe: (l: (s: { isStreaming: boolean }) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(v: boolean) {
      state = { isStreaming: v };
      for (const l of listeners) l(state);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('awaitStreamingEnd', () => {
  it('已在 streaming：转 false 后 resolve', async () => {
    const src = fakeSource(true);
    let done = false;
    const p = awaitStreamingEnd(src).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    src.set(false);
    await p;
    expect(done).toBe(true);
  });

  it('尚未 streaming：先开始再结束才 resolve（不被 prompt 早返回误判）', async () => {
    const src = fakeSource(false);
    let done = false;
    const p = awaitStreamingEnd(src).then(() => {
      done = true;
    });
    src.set(true); // streaming 开始
    await Promise.resolve();
    expect(done).toBe(false);
    src.set(false); // streaming 结束
    await p;
    expect(done).toBe(true);
  });

  it('超时未开始：兜底 resolve，避免永久占槽', async () => {
    vi.useFakeTimers();
    const src = fakeSource(false);
    let done = false;
    const p = awaitStreamingEnd(src, { startTimeoutMs: 1000 }).then(() => {
      done = true;
    });
    vi.advanceTimersByTime(1000);
    await p;
    expect(done).toBe(true);
  });

  it('画面切到另一个会话时放行，不把新会话的 isStreaming 当成本轮结束信号', async () => {
    const src = fakeSource(true);
    let detached = false;
    let done = false;
    const p = awaitStreamingEnd(src, { isDetached: () => detached }).then(() => {
      done = true;
    });
    detached = true;
    // 切到的会话也在跑：isStreaming 仍为 true，但必须放行。
    src.set(true);
    await p;
    expect(done).toBe(true);
  });

  it('开始等待前就已切走：立即放行', async () => {
    const src = fakeSource(false);
    await expect(awaitStreamingEnd(src, { isDetached: () => true })).resolves.toBeUndefined();
  });
});
