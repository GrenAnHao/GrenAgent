import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSessionStats, onPiEvent, listeners } = vi.hoisted(() => ({
  listeners: [] as Array<(env: unknown) => void>,
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
  onPiEvent: vi.fn((listener: (env: unknown) => void) => {
    listeners.push(listener);
    return Promise.resolve(() => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); });
  }),
}));

vi.mock('../lib/pi', () => ({ pi: { getSessionStats }, onPiEvent }));

import { useSessionStats } from './useSessionStats';

afterEach(() => vi.clearAllMocks());

describe('useSessionStats', () => {
  it('挂载时拉取一次 stats', async () => {
    renderHook(() => useSessionStats('/ws'));
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledWith('/ws'));
  });

  it('ignores a pre-compaction response that arrives after a finalized context revision', async () => {
    let resolveOld!: (value: ReturnType<typeof raw>) => void;
    let resolveNew!: (value: ReturnType<typeof raw>) => void;
    const raw = (used: number, revision: number) => ({ sessionId: 's', sessionFile: '/ws/a.jsonl', ownerEpoch: 'host-1', contextRevision: revision,
      userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
      contextUsage: { tokens: used, contextWindow: 1000, percent: used / 10 } });
    getSessionStats.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    getSessionStats.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const { result } = renderHook(() => useSessionStats('/ws', 0, '/ws/a.jsonl'));
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledTimes(1));
    listeners.forEach(listener => listener({ workspace: '/ws', source: 'interactive', sessionPath: '/ws/a.jsonl',
      event: { type: 'compaction_end', contextRevision: 1, ownerEpoch: 'host-1' } }));
    await waitFor(() => expect(getSessionStats).toHaveBeenCalledTimes(2));
    resolveNew(raw(120, 1));
    await waitFor(() => expect(result.current.stats?.contextUsed).toBe(120));
    resolveOld(raw(840, 0));
    await waitFor(() => expect(result.current.stats?.contextUsed).toBe(120));
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
