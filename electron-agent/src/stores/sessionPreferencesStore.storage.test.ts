import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from './sessionPreferencesStore';

/**
 * 两个渲染进程共享同一份 localStorage：每个草稿一条 key。
 * 用同一份 Storage 垫片模拟「另一窗口刚写了别的 draft」，验证本窗口的写/删不会把它抹掉。
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const storage = fakeStorage();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', storage);
  resetSessionPreferencesForTests();
});

describe('cross-window draft persistence', () => {
  it('restores a removed mode from its own draft key without touching another draft', () => {
    const saved = {
      ownerKey: 'draft:old',
      preferences: {
        mode: 'brainstorm', model: { provider: 'relay', id: 'saved' }, thinkingLevel: 'high',
        approval: 'workspace', fastMode: false, revision: 9,
      },
    };
    storage.setItem('pi-session-preferences:draft:old', JSON.stringify(saved));
    useSessionPreferencesStore.getState().patchOptimistic('draft:other', 'mode', 'ask');
    useSessionPreferencesStore.getState().hydrateFromStorage('draft:old');
    expect(useSessionPreferencesStore.getState().get('draft:old')).toMatchObject({
      ownerKey: 'draft:old', preferences: { ...saved.preferences, mode: 'agent' },
      confirmed: { ...saved.preferences, mode: 'agent' },
    });
    expect(useSessionPreferencesStore.getState().peek('draft:other')?.mode).toBe('ask');
    expect(JSON.parse(storage.getItem('pi-session-preferences:draft:old')!)).toEqual(saved);
  });

  it('restores removed modes during initial draft loading', async () => {
    storage.setItem('pi-session-preferences:draft:old', JSON.stringify({
      ownerKey: 'draft:old', preferences: { mode: 'brainstorm', approval: 'readonly', revision: 4 },
    }));
    vi.resetModules();
    const fresh = await import('./sessionPreferencesStore');
    expect(fresh.useSessionPreferencesStore.getState().get('draft:old')).toMatchObject({
      ownerKey: 'draft:old', preferences: { mode: 'agent', approval: 'readonly', revision: 4 },
    });
  });

  it('writes each draft under its own key and leaves another window draft intact', () => {
    // 另一窗口先建了 draft:other 并写下偏好。
    storage.setItem(
      'pi-session-preferences:draft:other',
      JSON.stringify({ ownerKey: 'draft:other', preferences: { thinkingLevel: 'max', revision: 0 } }),
    );

    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');

    expect(JSON.parse(storage.getItem('pi-session-preferences:draft:one') ?? '{}')).toMatchObject({
      ownerKey: 'draft:one',
      preferences: { thinkingLevel: 'high' },
    });
    // 另一窗口的草稿没有被整表覆盖。
    expect(JSON.parse(storage.getItem('pi-session-preferences:draft:other') ?? '{}')).toMatchObject({
      preferences: { thinkingLevel: 'max' },
    });
  });

  it('deleting a draft removes only its own key', () => {
    storage.setItem(
      'pi-session-preferences:draft:other',
      JSON.stringify({ ownerKey: 'draft:other', preferences: { thinkingLevel: 'max', revision: 0 } }),
    );
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');

    useSessionPreferencesStore.getState().remove('draft:one');

    expect(storage.getItem('pi-session-preferences:draft:one')).toBeNull();
    expect(storage.getItem('pi-session-preferences:draft:other')).not.toBeNull();
  });

  it('adopting a draft removes only that draft key', () => {
    storage.setItem(
      'pi-session-preferences:draft:other',
      JSON.stringify({ ownerKey: 'draft:other', preferences: { thinkingLevel: 'max', revision: 0 } }),
    );
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');

    useSessionPreferencesStore.getState().adopt('draft:one', '/ws/created.jsonl');

    expect(storage.getItem('pi-session-preferences:draft:one')).toBeNull();
    expect(storage.getItem('pi-session-preferences:draft:other')).not.toBeNull();
    // 会话条目不落盘。
    expect(storage.getItem('pi-session-preferences:/ws/created.jsonl')).toBeNull();
  });

  it('hydrates another window draft without touching the local draft', () => {
    storage.setItem(
      'pi-session-preferences:draft:other',
      JSON.stringify({ ownerKey: 'draft:other', preferences: { thinkingLevel: 'max', revision: 0 } }),
    );
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');

    useSessionPreferencesStore.getState().hydrateFromStorage('draft:other');

    expect(useSessionPreferencesStore.getState().peek('draft:other')?.thinkingLevel).toBe('max');
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.thinkingLevel).toBe('high');
  });

  it('does not overwrite a local draft that has pending writes with a stale disk copy', () => {
    storage.setItem(
      'pi-session-preferences:draft:one',
      JSON.stringify({ ownerKey: 'draft:one', preferences: { thinkingLevel: 'low', revision: 0 } }),
    );
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');

    useSessionPreferencesStore.getState().hydrateFromStorage('draft:one');

    expect(useSessionPreferencesStore.getState().peek('draft:one')?.thinkingLevel).toBe('high');
  });

  it('tolerates the legacy whole-table key without resurrecting it', () => {
    storage.setItem(
      'pi-session-preferences',
      JSON.stringify([{ ownerKey: 'draft:legacy', preferences: { thinkingLevel: 'max', revision: 0 } }]),
    );
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'high');
    expect(storage.getItem('pi-session-preferences')).not.toBeNull();
    expect(storage.getItem('pi-session-preferences:draft:legacy')).toBeNull();
  });
});
