import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { shareUnchanged, useStableCallback } from './structuralShare';

describe('shareUnchanged', () => {
  it('字段都相同的条目沿用上一轮的对象，整组没变时沿用上一轮的数组', () => {
    const prev = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const next = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];

    const shared = shareUnchanged(prev, next, (x) => x.id);

    expect(shared).toBe(prev);
  });

  it('只替换变了的条目，顺序跟新一轮走', () => {
    const a = { id: 'a', n: 1 };
    const b = { id: 'b', n: 2 };
    const next = [{ id: 'b', n: 3 }, { id: 'a', n: 1 }, { id: 'c', n: 0 }];

    const shared = shareUnchanged([a, b], next, (x) => x.id);

    expect(shared).not.toBe(next);
    expect(shared[0]).toBe(next[0]);
    expect(shared[1]).toBe(a);
    expect(shared[2]).toBe(next[2]);
  });

  it('字段是数组时按元素引用比较', () => {
    const sessions = [{ path: 'p1' }];
    const prev = [{ cwd: 'x', sessions }];

    expect(shareUnchanged(prev, [{ cwd: 'x', sessions: [sessions[0]] }], (g) => g.cwd)[0]).toBe(prev[0]);
    expect(shareUnchanged(prev, [{ cwd: 'x', sessions: [{ path: 'p1' }] }], (g) => g.cwd)[0]).not.toBe(prev[0]);
  });

  it('没有上一轮时原样返回', () => {
    const next = [{ id: 'a' }];
    expect(shareUnchanged(undefined, next, (x) => x.id)).toBe(next);
  });
});

describe('useStableCallback', () => {
  it('引用不变，调用的是最新一次渲染的函数', () => {
    let seen = '';
    const { result, rerender } = renderHook(({ tag }) => useStableCallback((x: string) => { seen = `${tag}:${x}`; }), {
      initialProps: { tag: 'first' },
    });
    const first = result.current;

    rerender({ tag: 'second' });
    result.current('go');

    expect(result.current).toBe(first);
    expect(seen).toBe('second:go');
  });
});
