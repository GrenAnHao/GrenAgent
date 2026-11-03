import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval, setSessionDefaults } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve({ ok: true, sessionPath: '/ws/a.jsonl' })),
  setSessionDefaults: vi.fn(() => Promise.resolve({ revision: 1 })),
}));

vi.mock('../lib/pi', () => ({
  pi: {
    setApproval,
    setSessionDefaults,
    getState: vi.fn(() => Promise.resolve({ sessionFile: '/ws/a.jsonl', preferences: { approval: 'auto', revision: 1 } })),
    getSessionDefaults: vi.fn(() => Promise.resolve({ revision: 0 })),
    getSettings: vi.fn(() => Promise.resolve({})),
  },
}));

import {
  confirmFullAccess,
  dismissFullAccessConfirm,
  enableFullAccess,
  useFullAccessConfirmStore,
  __resetFullAccessConfirmForTest,
} from './fullAccessConfirmStore';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from './sessionPreferencesStore';

const OWNER = '/ws/a.jsonl';
const prefs = (patch: Record<string, unknown> = {}) => ({
  model: { provider: 'anthropic', id: 'm' },
  thinkingLevel: 'medium',
  mode: 'agent',
  approval: 'auto',
  revision: 1,
  ...patch,
});

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  resetSessionPreferencesForTests();
  setApproval.mockReset();
  setApproval.mockResolvedValue({ ok: true, sessionPath: OWNER, preferences: prefs({ approval: 'full' }), revision: 2 });
  setSessionDefaults.mockReset();
  setSessionDefaults.mockResolvedValue({ revision: 1 });
});

describe('enableFullAccess', () => {
  it('当前已是 full 时不打开弹窗、不调 IPC', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'full' }));
    await enableFullAccess('/ws', OWNER);
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('当前不是 full 时打开弹窗并捕获 owner；取消后不写 IPC 也不改档', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'auto' }));
    const pending = enableFullAccess('/ws', OWNER);
    expect(useFullAccessConfirmStore.getState()).toMatchObject({
      open: true,
      workspace: '/ws',
      ownerKey: OWNER,
      busy: false,
    });
    dismissFullAccessConfirm();
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('确认且回执成功后才写 full，且只写捕获的会话', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'auto' }));
    useSessionPreferencesStore.getState().applyServer('/ws/b.jsonl', prefs({ approval: 'readonly' }));
    const pending = enableFullAccess('/ws', OWNER);
    await confirmFullAccess();
    await pending;
    expect(setApproval).toHaveBeenCalledWith('/ws', 'full', OWNER);
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('full');
    // 另一个会话与项目默认都不动。
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.approval).toBe('readonly');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('草稿确认 full 只写本地偏好，不写项目默认、不调 setter', async () => {
    useSessionPreferencesStore.getState().applyServer('draft:one', prefs({ approval: 'auto' }));
    const pending = enableFullAccess('/ws', 'draft:one');
    await confirmFullAccess();
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(setSessionDefaults).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.approval).toBe('full');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('IPC 失败时不改档、弹窗保持打开，错误可见', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'auto' }));
    setApproval.mockRejectedValueOnce(new Error('RUNTIME_CONFIG_UNAVAILABLE'));
    const pending = enableFullAccess('/ws', OWNER);
    await expect(confirmFullAccess()).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
    expect(useSessionPreferencesStore.getState().get(OWNER)?.error).toBe('save');
    expect(useFullAccessConfirmStore.getState()).toMatchObject({ open: true, busy: false });
    dismissFullAccessConfirm();
    await pending;
  });

  it('回执指向别的会话时不应用、不回滚成 full', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'auto' }));
    setApproval.mockResolvedValueOnce({
      ok: true,
      sessionPath: '/ws/b.jsonl',
      preferences: prefs({ approval: 'full' }),
      revision: 5,
    });
    const pending = enableFullAccess('/ws', OWNER);
    await expect(confirmFullAccess()).rejects.toThrow();
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')).toBeUndefined();
    dismissFullAccessConfirm();
    await pending;
  });

  it('弹窗已打开时第二次调用立即返回且不覆盖 owner', async () => {
    useSessionPreferencesStore.getState().applyServer('/ws/a.jsonl', prefs());
    useSessionPreferencesStore.getState().applyServer('/ws/b.jsonl', prefs());
    const first = enableFullAccess('/a', '/ws/a.jsonl');
    const second = enableFullAccess('/b', '/ws/b.jsonl');
    await second;
    expect(useFullAccessConfirmStore.getState().ownerKey).toBe('/ws/a.jsonl');
    dismissFullAccessConfirm();
    await first;
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('busy 时 dismiss 被忽略', async () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ approval: 'auto' }));
    let release: (value: unknown) => void = () => {};
    setApproval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = enableFullAccess('/ws', OWNER);
    const confirming = confirmFullAccess();
    await Promise.resolve();
    expect(useFullAccessConfirmStore.getState().busy).toBe(true);
    dismissFullAccessConfirm();
    expect(useFullAccessConfirmStore.getState().open).toBe(true);
    release({ ok: true, sessionPath: OWNER, preferences: prefs({ approval: 'full' }), revision: 2 });
    await confirming;
    await pending;
  });
});
