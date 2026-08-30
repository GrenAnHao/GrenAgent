import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useThrottledValue } from './useThrottledValue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useThrottledValue', () => {
  it('enabled=false：直接返回最新值（节流关闭）', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 100, { enabled: false }),
      { initialProps: { v: 'a' } },
    );
    expect(result.current).toBe('a');
    rerender({ v: 'b' });
    expect(result.current).toBe('b');
  });

  it('enabled=true：100ms 内多次更新只在 trailing edge 生效', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useThrottledValue(v, 100, { enabled: true }),
      { initialProps: { v: 'a' } },
    );
    expect(result.current).toBe('a');

    rerender({ v: 'b' });
    rerender({ v: 'c' });
    rerender({ v: 'd' });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('d');
  });

  it('enabled 从 true 切到 false：立即同步最新值', () => {
    const { result, rerender } = renderHook(
      ({ v, enabled }: { v: string; enabled: boolean }) =>
        useThrottledValue(v, 100, { enabled }),
      { initialProps: { v: 'a', enabled: true } },
    );

    rerender({ v: 'b', enabled: true });
    rerender({ v: 'c', enabled: true });
    expect(result.current).toBe('a');

    rerender({ v: 'c', enabled: false });
    expect(result.current).toBe('c');
  });

  it('默认 enabled=true', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 100), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'b' });
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('b');
  });
});
