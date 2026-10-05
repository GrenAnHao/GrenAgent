import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pi', () => ({
  pi: { warmWorkspace: vi.fn(() => Promise.resolve()) },
}));

import { pi } from './pi';
import { prewarmRecent, resetPrewarmForTest, selectPrewarmCwds } from './prewarm';

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
});
