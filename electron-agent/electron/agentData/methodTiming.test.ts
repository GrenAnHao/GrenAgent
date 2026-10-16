import { describe, expect, it } from 'vitest';
import { AgentDataTiming } from './methodTiming';

function fixture() {
  let now = 0;
  const timing = new AgentDataTiming({ now: () => now, wall: () => 1_000 + now });
  return { timing, advance: (ms: number) => { now += ms; } };
}

describe('AgentDataTiming', () => {
  it('returns undefined for an empty window and resets after drain', () => {
    const { timing } = fixture();
    expect(timing.drain()).toBeUndefined();
    timing.record('memory.search', 3);
    expect(timing.drain()?.n).toBe(1);
    expect(timing.drain()).toBeUndefined();
  });

  it('aggregates per method and keeps end-to-end time only for request entries', () => {
    const { timing } = fixture();
    timing.record('item.upsert', 12, { totalMs: 13 });
    timing.record('item.upsert', 20, { totalMs: 25 });
    timing.record('wiki.rebuildPageIndex', 7);
    const sample = timing.drain()!;
    expect(sample.syncMs).toBe(39);
    expect(sample.n).toBe(3);
    expect(sample.methods[0]).toEqual({ method: 'item.upsert', n: 2, syncMs: 32, syncMaxMs: 20, totalMs: 38, totalMaxMs: 25 });
    expect(sample.methods[1]).toEqual({ method: 'wiki.rebuildPageIndex', n: 1, syncMs: 7, syncMaxMs: 7 });
  });

  it('counts a nested segment in its own row but not twice in the window total', () => {
    const { timing, advance } = fixture();
    const outer = timing.start();
    advance(5);
    timing.timeSync('wiki.rebuildPageIndex', () => advance(60));
    advance(5);
    timing.record('wiki.pageWrite', outer(), { nested: timing.nested });
    const sample = timing.drain()!;
    expect(sample.syncMs).toBe(70);
    expect(sample.n).toBe(1);
    expect(sample.methods.map((row) => [row.method, row.syncMs])).toEqual([['wiki.pageWrite', 70], ['wiki.rebuildPageIndex', 60]]);
    expect(sample.slow).toEqual([
      { method: 'wiki.pageWrite', syncMs: 70, at: 1_070 },
      { method: 'wiki.rebuildPageIndex', syncMs: 60, at: 1_065, nested: true },
    ]);
  });

  it('timeSync records when the callback throws and rethrows the error', () => {
    const { timing, advance } = fixture();
    expect(() => timing.timeSync('task.memory_extract.complete', () => { advance(4); throw new Error('boom'); })).toThrow('boom');
    expect(timing.nested).toBe(false);
    expect(timing.drain()!.methods[0]).toMatchObject({ method: 'task.memory_extract.complete', syncMs: 4 });
  });

  it('a segment stop is idempotent so error paths cannot unbalance nesting', () => {
    const { timing, advance } = fixture();
    const stop = timing.start();
    advance(3);
    expect(stop()).toBe(3);
    advance(10);
    expect(stop()).toBe(3);
    expect(timing.nested).toBe(false);
  });

  it('bounds method keys, method rows and slow entries within one window', () => {
    const { timing } = fixture();
    for (let i = 0; i < 260; i += 1) timing.record(`attacker.${i}`, 1);
    for (let i = 0; i < 40; i += 1) timing.record('readThread', 100 + i);
    const sample = timing.drain()!;
    expect(sample.methods).toHaveLength(15);
    expect(sample.methods.some((row) => row.method === '(other)')).toBe(true);
    expect(sample.slow).toHaveLength(20);
    expect(sample.slow[0].syncMs).toBe(139);
    expect(sample.slow.at(-1)!.syncMs).toBe(120);
  });

  it('truncates very long method labels', () => {
    const { timing } = fixture();
    timing.record('x'.repeat(500), 1);
    expect(timing.drain()!.methods[0].method).toHaveLength(80);
  });
});
