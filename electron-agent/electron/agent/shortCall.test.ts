import { describe, expect, it } from 'vitest';
import { ShortCallQueue, timeoutForKind } from './shortCall.js';

describe('ShortCallQueue', () => {
  it('串行执行，第二个等第一个结束', async () => {
    const order: string[] = [];
    const q = new ShortCallQueue();
    let release!: () => void;
    const first = q.run(async () => {
      order.push('a-start');
      await new Promise<void>((r) => { release = r; });
      order.push('a-end');
      return 1;
    });
    const second = q.run(async () => {
      order.push('b');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('超时 abort 后队列继续', async () => {
    const q = new ShortCallQueue();
    const sawAbort: boolean[] = [];
    await expect(q.run(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort.push(true); reject(new Error('aborted')); });
      });
    }, 20)).rejects.toThrow('aborted');
    await expect(q.run(async () => 'ok', 1000)).resolves.toBe('ok');
    expect(sawAbort).toEqual([true]);
  });

  it('timeoutForKind：goal/wiki/memory 60s，未知 kind 走 fallback', () => {
    expect(timeoutForKind('goal_judge')).toBe(60_000);
    expect(timeoutForKind('wiki_page_generate')).toBe(60_000);
    expect(timeoutForKind('memory_extract')).toBe(60_000);
    expect(timeoutForKind('memory_deduplicate')).toBe(60_000);
    expect(timeoutForKind('memory_scene')).toBe(60_000);
    expect(timeoutForKind('memory_persona')).toBe(60_000);
    expect(timeoutForKind('other', 5_000)).toBe(5_000);
  });
});
