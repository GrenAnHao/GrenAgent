import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pi } from '../lib/pi';
import { useSubAgentLiveStore } from '../stores/subagentLiveStore';
import { useSubAgentLive } from './useSubAgentLive';

afterEach(() => {
  vi.restoreAllMocks();
  // store 单例在测试间持久，重置 workspace 数据避免跨用例污染
  useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() });
});

describe('useSubAgentLive', () => {
  it('running + agentId → polls registry and exposes model', async () => {
    vi.spyOn(pi, 'subagentList').mockResolvedValue([
      { id: 'ag1', task: 't', status: 'running', model: 'gpt-5.3-codex', createdAt: 0, updatedAt: 0 },
    ]);
    const { result } = renderHook(() => useSubAgentLive('ws', 'ag1', true));
    await waitFor(() => expect(pi.subagentList).toHaveBeenCalledWith('ws'));
    await waitFor(() => expect(result.current.model).toBe('gpt-5.3-codex'));
  });

  it('not running → never polls', () => {
    const spy = vi.spyOn(pi, 'subagentList').mockResolvedValue([]);
    renderHook(() => useSubAgentLive('ws', 'ag1', false));
    expect(spy).not.toHaveBeenCalled();
  });

  it('null agentId → model is null even when running rows exist', async () => {
    vi.spyOn(pi, 'subagentList').mockResolvedValue([
      { id: 'ag9', task: 'foo', status: 'running', model: 'deepseek-v4', createdAt: 0, updatedAt: 0 },
    ]);
    const { result } = renderHook(() => useSubAgentLive('ws', null, true));
    await waitFor(() => expect(pi.subagentList).toHaveBeenCalled());
    // agentId 为 null 时不做猜测，model 应为 null
    expect(result.current.model).toBeNull();
  });

  it('agentId not in registry → model is null', async () => {
    vi.spyOn(pi, 'subagentList').mockResolvedValue([
      { id: 'a', task: 'x', status: 'running', model: 'm1', createdAt: 0, updatedAt: 0 },
      { id: 'b', task: 'y', status: 'running', model: 'm2', createdAt: 0, updatedAt: 0 },
    ]);
    const { result } = renderHook(() => useSubAgentLive('ws', 'nonexistent', true));
    await waitFor(() => expect(pi.subagentList).toHaveBeenCalled());
    expect(result.current.model).toBeNull();
  });
});
