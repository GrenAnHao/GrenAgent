// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace, getCacheWarming, setCacheWarming } = vi.hoisted(() => ({
  getCacheWarming: vi.fn(() => Promise.resolve('streaming')),
  setCacheWarming: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({ OPENAI_API_KEY: 'sk-old' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace, getCacheWarming, setCacheWarming },
}));

import { hydrateSettingsValues, useSettingsForm } from './useSettingsForm';

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

  it('setValue 后在同一同步链里立即 persist 携带最新值（修复开关写不进的竞态）', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    // 模拟接入开关 toggle 的用法：setValue 后不等 re-render，立刻 persist。
    await act(async () => {
      result.current.setValue('WECHAT_OC_ENABLE', '1');
      await result.current.persist();
    });
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ WECHAT_OC_ENABLE: '1' }));
  });

  it('保存自动标题开关值且不重启 sidecar', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('AUTO_TITLE', '0'));

    await act(async () => {
      await result.current.persist();
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ AUTO_TITLE: '0' }));
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('非法的循环保护次数不落盘，并留下错误', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('LOOP_GUARD_THRESHOLDS', '3,3'));

    await act(async () => {
      await result.current.persist();
    });

    expect(setSettings).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/重复/);
    expect(result.current.dirty).toBe(true);
  });
});

describe('useSettingsForm cache warming', () => {
  it('外部设置刷新保留已加载 SDK 模式，不把未保存选择伪装成已保存', async () => {
    const { result } = renderHook(() => useSettingsForm({ cacheWarming: true }));
    await waitFor(() => expect(result.current.values.PI_CACHE_WARMING).toBe('streaming'));
    act(() => result.current.setValue('PI_CACHE_WARMING', 'off'));
    act(() => hydrateSettingsValues({ AUTO_TITLE: '0' }));
    expect(result.current.values.PI_CACHE_WARMING).toBe('streaming');
    expect(result.current.dirty).toBe(false);
  });
  it('回显 SDK 有效模式；其他设置保存不会写 SDK 模式或复制到 runtime settings', async () => {
    const { result } = renderHook(() => useSettingsForm({ cacheWarming: true }));
    await waitFor(() => expect(result.current.values.PI_CACHE_WARMING).toBe('streaming'));
    act(() => result.current.setValue('AUTO_TITLE', '0'));
    await act(() => result.current.persist());
    expect(setCacheWarming).not.toHaveBeenCalled();
    expect(setSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ PI_CACHE_WARMING: expect.anything() }));
  });

  it('只有显式修改缓存预热才保存 SDK 模式；成功后再次保存不重复写', async () => {
    const { result } = renderHook(() => useSettingsForm({ cacheWarming: true }));
    await waitFor(() => expect(result.current.values.PI_CACHE_WARMING).toBe('streaming'));
    act(() => result.current.setValue('PI_CACHE_WARMING', 'off'));
    await act(() => result.current.persist());
    expect(setCacheWarming).toHaveBeenCalledWith('off');
    expect(setSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ PI_CACHE_WARMING: expect.anything() }));
    await act(() => result.current.persist());
    expect(setCacheWarming).toHaveBeenCalledTimes(1);
  });

  it('模式保存失败保留 dirty 与错误，可重试', async () => {
    setCacheWarming.mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() => useSettingsForm({ cacheWarming: true }));
    await waitFor(() => expect(result.current.values.PI_CACHE_WARMING).toBe('streaming'));
    act(() => result.current.setValue('PI_CACHE_WARMING', 'idle'));
    await act(() => result.current.persist());
    expect(result.current.error).toBe('write failed');
    expect(result.current.dirty).toBe(true);
    await act(() => result.current.persist());
    expect(result.current.dirty).toBe(false);
  });
});
