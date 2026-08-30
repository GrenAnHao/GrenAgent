import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSessionStats, onPiEvent } = vi.hoisted(() => ({
  getSessionStats: vi.fn(() =>
    Promise.resolve({
      sessionId: 's',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  ),
  onPiEvent: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('../lib/pi', () => ({ pi: { getSessionStats }, onPiEvent }));

import { useSessionStats } from './useSessionStats';

afterEach(() => vi.clearAllMocks());

describe('useSessionStats', () => {
  it('挂载时拉取一次 stats', async () => {
    renderHook(() => useSessionStats('/ws'));
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledWith('/ws'));
  });

  it('refetchKey 变化时重拉（打开旧会话历史加载完成后刷新，修复首拉为 0 不更新）', async () => {
    const { rerender } = renderHook(({ key }) => useSessionStats('/ws', key), {
      initialProps: { key: 0 },
    });
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledTimes(1));
    rerender({ key: 5 });
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledTimes(2));
  });
});
