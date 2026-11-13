import { useMemo } from 'react';
import { create } from 'zustand';
import { modelKey } from '../features/chat/input/modelUtils';

export const MODEL_VISIBILITY_STORAGE_KEY = 'pi-model-visibility';

interface ModelVisibilityState {
  hidden: string[];
  setHidden: (provider: string, id: string, hidden: boolean) => void;
}

function parseHidden(raw: string | null): string[] {
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    const hidden = (data as { hidden?: unknown } | null)?.hidden;
    if (!Array.isArray(hidden) || !hidden.every((key) =>
      typeof key === 'string' && key.indexOf('\0') > 0 && key.indexOf('\0') < key.length - 1,
    )) return [];
    return [...new Set(hidden as string[])];
  } catch {
    return [];
  }
}

function initialHidden(): string[] {
  try {
    return parseHidden(localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function isModelHidden(hidden: readonly string[], provider: string, id: string): boolean {
  return hidden.includes(modelKey(provider, id));
}

/** Manual candidates only: never replace the raw runtime/ability catalog with this projection. */
export function filterVisibleModels<T extends { provider: string; id: string }>(models: readonly T[], hidden: readonly string[]): T[] {
  const keys = new Set(hidden);
  return models.filter((model) => !keys.has(modelKey(model.provider, model.id)));
}

export const useModelVisibilityStore = create<ModelVisibilityState>((set) => ({
  hidden: initialHidden(),
  setHidden: (provider, id, hidden) => {
    try {
      // Read before each single-identity edit so another window's unrelated edits survive.
      const latest = parseHidden(localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY));
      const key = modelKey(provider, id);
      const next = latest.filter((item) => item !== key);
      if (hidden) next.push(key);
      // A failed save must not publish a preference that will vanish on reload.
      localStorage.setItem(MODEL_VISIBILITY_STORAGE_KEY, JSON.stringify({ hidden: next }));
      set({ hidden: next });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
}));

export function useVisibleModels<T extends { provider: string; id: string }>(models: readonly T[]): T[] {
  const hidden = useModelVisibilityStore((state) => state.hidden);
  return useMemo(() => filterVisibleModels(models, hidden), [models, hidden]);
}
