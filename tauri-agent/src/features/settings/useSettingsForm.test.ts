import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ OPENAI_API_KEY: 'sk-old' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { useSettingsForm } from './useSettingsForm';

afterEach(() => vi.clearAllMocks());

describe('useSettingsForm', () => {
  it('loads existing settings', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
  });

  it('setValue updates local state', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('OPENAI_API_KEY', 'sk-new'));
    expect(result.current.values.OPENAI_API_KEY).toBe('sk-new');
  });

  it('save persists and restarts sidecar', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('IMAGE_MODEL', 'gpt-image-1'));
    await act(async () => {
      await result.current.save();
    });
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ IMAGE_MODEL: 'gpt-image-1' }));
    expect(closeWorkspace).toHaveBeenCalledWith('/ws');
    expect(openWorkspace).toHaveBeenCalledWith('/ws');
  });

  it('setValue marks dirty; persist saves without restart', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('IMAGE_MODEL', 'x'));
    expect(result.current.dirty).toBe(true);
    expect(setSettings).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.persist();
    });
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ IMAGE_MODEL: 'x' }));
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
  });
});
