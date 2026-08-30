import { describe, it, expect } from 'vitest';
import { createCommandLanes } from './commandLanes';

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** 刷净所有已排队的 microtask（run 链有多层 then/await）。 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('commandLanes', () => {
  it('同 sessionKey 串行执行', async () => {
    const lanes = createCommandLanes({ globalConcurrency: 10 });
    const order: string[] = [];
    const d1 = defer();
    const p1 = lanes.run('s', async () => {
      order.push('a-start');
      await d1.promise;
      order.push('a-end');
    });
    const p2 = lanes.run('s', async () => {
      order.push('b-start');
    });
    await tick();
    expect(order).toEqual(['a-start']); // b 未开始（串行）
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('global 并发上限限制不同 session 同时执行数', async () => {
    const lanes = createCommandLanes({ globalConcurrency: 1 });
    const order: string[] = [];
    const d1 = defer();
    const p1 = lanes.run('s1', async () => {
      order.push('1');
      await d1.promise;
    });
    const p2 = lanes.run('s2', async () => {
      order.push('2');
    });
    await tick();
    expect(order).toEqual(['1']); // global=1 → s2 等待
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1', '2']);
  });
});
