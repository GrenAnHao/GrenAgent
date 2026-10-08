import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pi', () => ({
  pi: { warmWorkspace: vi.fn(() => Promise.resolve()) },
}));

import { pi } from './pi';
import {
  cancelHoverPrewarm,
  HOVER_PREWARM_DWELL_MS,
  PREWARM_IDLE_MS,
  prewarmRecent,
  prewarmWorkspace,
  resetPrewarmForTest,
  selectPrewarmCwds,
  startHoverPrewarm,
} from './prewarm';

const warm = vi.mocked(pi.warmWorkspace);

afterEach(() => {
  resetPrewarmForTest();
  warm.mockReset();
  warm.mockImplementation(() => Promise.resolve());
  vi.useRealTimers();
});

describe('selectPrewarmCwds', () => {
  it('跳过当前工作区，并按路径等价去重', () => {
    expect(selectPrewarmCwds(['D:/current', 'd:\\current', 'D:/a', 'D:/a', 'D:/b'], 'D:/current', 4)).toEqual([
      'D:/a',
      'D:/b',
    ]);
  });

  it('当前工作区不在列表里时仍只取上限个', () => {
    expect(selectPrewarmCwds(['D:/a', 'D:/b', 'D:/c', 'D:/d', 'D:/e'], 'D:/other', 4)).toEqual([
      'D:/a',
      'D:/b',
      'D:/c',
      'D:/d',
    ]);
  });
});

describe('prewarmRecent', () => {
  it('延迟结束前不预热，且上一个运行时建完才开始下一个', async () => {
    const pending: Array<() => void> = [];
    warm.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    vi.useFakeTimers();

    prewarmRecent(['D:/current', 'D:/a', 'D:/b'], 4, 1500, 'd:/current');
    await vi.advanceTimersByTimeAsync(1499);
    expect(warm).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith('D:/a');

    await vi.advanceTimersByTimeAsync(5000);
    expect(warm).toHaveBeenCalledTimes(1);

    pending[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm).toHaveBeenLastCalledWith('D:/b');
  });

  it('用户在操作时推迟下一个预热，停手满 PREWARM_IDLE_MS 才开始', async () => {
    const pending: Array<() => void> = [];
    warm.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    vi.useFakeTimers();

    prewarmRecent(['D:/a', 'D:/b'], 4, 1500);
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

    await vi.advanceTimersByTimeAsync(PREWARM_IDLE_MS - 1);
    expect(warm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warm).toHaveBeenCalledWith('D:/a');

    window.dispatchEvent(new MouseEvent('pointerdown'));
    pending[0]?.();
    await vi.advanceTimersByTimeAsync(PREWARM_IDLE_MS - 1);
    expect(warm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm).toHaveBeenLastCalledWith('D:/b');
  });

  it('prewarmWorkspace 不等空闲，立即开始', async () => {
    vi.useFakeTimers();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    prewarmWorkspace('D:/draft');
    expect(warm).toHaveBeenCalledWith('D:/draft');
  });
});

describe('悬停预热', () => {
  it('划过不预热，停留满 HOVER_PREWARM_DWELL_MS 才开始', async () => {
    vi.useFakeTimers();

    startHoverPrewarm('D:/a');
    await vi.advanceTimersByTimeAsync(HOVER_PREWARM_DWELL_MS - 1);
    startHoverPrewarm('D:/b');
    await vi.advanceTimersByTimeAsync(HOVER_PREWARM_DWELL_MS - 1);
    cancelHoverPrewarm();
    await vi.advanceTimersByTimeAsync(5000);
    expect(warm).not.toHaveBeenCalled();

    startHoverPrewarm('D:/c');
    await vi.advanceTimersByTimeAsync(HOVER_PREWARM_DWELL_MS);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith('D:/c');
  });

  it('已有运行时在建时不再并发，等它建完再开始悬停的那个', async () => {
    const pending: Array<() => void> = [];
    warm.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
    vi.useFakeTimers();

    prewarmWorkspace('D:/busy');
    startHoverPrewarm('D:/hover');
    await vi.advanceTimersByTimeAsync(HOVER_PREWARM_DWELL_MS * 5);
    expect(warm).toHaveBeenCalledTimes(1);

    pending[0]?.();
    await vi.advanceTimersByTimeAsync(HOVER_PREWARM_DWELL_MS);
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm).toHaveBeenLastCalledWith('D:/hover');
  });
});
