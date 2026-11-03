import { describe, expect, it } from 'vitest';
import { ReadAdmission, readBusyError, readFlightKey, readTimeoutError } from './readAdmission';

function admission(readers: number, extra: { maxQueued?: number; timeoutMs?: number; now?: () => number } = {}) {
  let clock = 0;
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  const now = extra.now ?? (() => clock);
  const queue = new ReadAdmission({
    readers,
    maxQueued: extra.maxQueued,
    timeoutMs: extra.timeoutMs ?? 30,
    now,
    setTimer: (fn, ms) => { const timer = { fn, at: now() + ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) { timer.cancelled = true; timer.fn(); }
    }
  };
  return { queue, advance };
}

describe('ReadAdmission', () => {
  it('lets each workspace use at most half the pool, rounded up, and rejects when the queue is full', async () => {
    const { queue } = admission(2, { maxQueued: 1 });
    const first = await queue.acquire('a');
    const second = queue.acquire('a');
    const third = queue.acquire('b');
    await expect(queue.acquire('c')).rejects.toThrow(readBusyError(1_000).message);
    expect(queue.queued).toBe(1);
    first.release();
    const started = await second;
    expect(queue.queued).toBe(0);
    started.release();
    (await third).release();
  });

  it('drops a queued read when its wait exceeds the timeout', async () => {
    const { queue, advance } = admission(1, { timeoutMs: 30 });
    const running = await queue.acquire('a');
    const waiting = queue.acquire('b');
    advance(29);
    advance(1);
    await expect(waiting).rejects.toThrow(readTimeoutError().message);
    running.release();
  });

  it('builds the same flight key for the same call and a different one after the generation changes', () => {
    const call = { op: 'call', tool: 'codegraph_search', args: { limit: 1, query: 'x' } };
    expect(readFlightKey('repo', call, 2)).toBe(readFlightKey('repo', { op: 'call', tool: 'codegraph_search', args: { query: 'x', limit: 1 } }, 2));
    expect(readFlightKey('repo', call, 3)).not.toBe(readFlightKey('repo', call, 2));
    expect(readFlightKey('repo', { op: 'status' }, 2)).toBeUndefined();
  });
});
