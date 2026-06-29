import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pi } from '../lib/pi';
import { useSubAgentLive } from './useSubAgentLive';

afterEach(() => vi.restoreAllMocks());

describe('useSubAgentLive', () => {
  it('running + agentId → polls registry and exposes model', async () => {
    vi.spyOn(pi, 'subagentList').mockResolvedValue([
      { id: 'ag1', task: 't', status: 'running', model: 'gpt-5.3-codex', transcript: '', createdAt: 0, updatedAt: 0 },
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

  it('no agentId → never polls', () => {
    const spy = vi.spyOn(pi, 'subagentList').mockResolvedValue([]);
    renderHook(() => useSubAgentLive('ws', null, true));
    expect(spy).not.toHaveBeenCalled();
  });
});
