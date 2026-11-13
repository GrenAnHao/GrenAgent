import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_VISIBILITY_STORAGE_KEY,
  filterVisibleModels,
  isModelHidden,
  useModelVisibilityStore,
  useVisibleModels,
} from './modelVisibilityStore';

beforeEach(() => {
  localStorage.removeItem(MODEL_VISIBILITY_STORAGE_KEY);
  useModelVisibilityStore.setState({ hidden: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const models = [
  { provider: 'one', id: 'same', fast: true },
  { provider: 'two', id: 'same', fast: false },
  { provider: 'one', id: 'other', fast: true },
];

describe('desktop model visibility', () => {
  it('filters exact provider/id identities without mutating the raw catalog or metadata', () => {
    const visible = filterVisibleModels(models, ['one\0same']);
    expect(visible).toEqual([models[1], models[2]]);
    expect(visible[0]).toBe(models[1]);
    expect(models).toHaveLength(3);
    expect(models[0].fast).toBe(true);
    expect(isModelHidden(['one\0same'], 'one', 'same')).toBe(true);
    expect(isModelHidden(['one\0same'], 'two', 'same')).toBe(false);
  });

  it('persists hiding and restoring without writing any other storage keys', () => {
    localStorage.setItem('models', 'untouched');
    useModelVisibilityStore.getState().setHidden('one', 'same', true);
    expect(JSON.parse(localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY)!)).toEqual({ hidden: ['one\0same'] });
    useModelVisibilityStore.getState().setHidden('two', 'same', true);
    useModelVisibilityStore.getState().setHidden('one', 'same', false);
    expect(useModelVisibilityStore.getState().hidden).toEqual(['two\0same']);
    expect(localStorage.getItem('models')).toBe('untouched');
  });

  it('merges each single-model update into the latest disk preferences, retaining missing identities', () => {
    localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify({ hidden: ['gone\0old', 'two\0same'] }));
    useModelVisibilityStore.getState().setHidden('one', 'same', true);
    expect(useModelVisibilityStore.getState().hidden).toEqual(['gone\0old', 'two\0same', 'one\0same']);
    localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify({ hidden: ['external\0new', 'one\0same'] }));
    useModelVisibilityStore.getState().setHidden('one', 'same', false);
    expect(useModelVisibilityStore.getState().hidden).toEqual(['external\0new']);
  });

  it('publishes memory only after synchronous storage success and exposes save failures', () => {
    useModelVisibilityStore.setState({ hidden: ['two\0same'] });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      expect(useModelVisibilityStore.getState().hidden).toEqual(['two\0same']);
      throw new Error('quota exceeded');
    });
    expect(() => useModelVisibilityStore.getState().setHidden('one', 'same', true)).toThrow('quota exceeded');
    expect(useModelVisibilityStore.getState().hidden).toEqual(['two\0same']);
  });

  it('does not overwrite disk when reading the latest preferences is denied', () => {
    const write = vi.spyOn(localStorage, 'setItem');
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('storage denied'); });
    expect(() => useModelVisibilityStore.getState().setHidden('one', 'same', true)).toThrow('storage denied');
    expect(write).not.toHaveBeenCalled();
    expect(useModelVisibilityStore.getState().hidden).toEqual([]);
  });

  it('reactively produces an empty manual projection and restores it while preserving the raw input', () => {
    const raw = models.slice(0, 1);
    const { result } = renderHook(() => useVisibleModels(raw));
    act(() => useModelVisibilityStore.getState().setHidden('one', 'same', true));
    expect(result.current).toEqual([]);
    expect(raw).toHaveLength(1);
    act(() => useModelVisibilityStore.getState().setHidden('one', 'same', false));
    expect(result.current).toEqual(raw);
  });

  it('reads saved preferences on a fresh module load', async () => {
    localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify({ hidden: ['one\0same'] }));
    vi.resetModules();
    const reloaded = await import('./modelVisibilityStore');
    expect(reloaded.useModelVisibilityStore.getState().hidden).toEqual(['one\0same']);
  });

  it.each(['{bad', 'null', '[]', '{"hidden":[4]}', '{"hidden":["not-an-identity"]}'])(
    'treats damaged preferences as all visible: %s', async (raw) => {
      localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, raw);
      vi.resetModules();
      const reloaded = await import('./modelVisibilityStore');
      expect(reloaded.useModelVisibilityStore.getState().hidden).toEqual([]);
    },
  );
});
