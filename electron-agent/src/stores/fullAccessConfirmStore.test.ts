import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/pi', () => ({ pi: { setApproval } }));

import { useApprovalStore } from './approvalStore';
import {
  confirmFullAccess,
  dismissFullAccessConfirm,
  enableFullAccess,
  useFullAccessConfirmStore,
  __resetFullAccessConfirmForTest,
} from './fullAccessConfirmStore';

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetFullAccessConfirmForTest();
});

describe('enableFullAccess', () => {
  it('当前已是 full 时不打开弹窗、不调 IPC', async () => {
    useApprovalStore.getState().setLevel('/ws', 'full');
    await enableFullAccess('/ws');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('当前不是 full 时打开弹窗；取消后不写 IPC 也不改档', async () => {
    const pending = enableFullAccess('/ws');
    expect(useFullAccessConfirmStore.getState()).toMatchObject({
      open: true,
      workspace: '/ws',
      busy: false,
    });
    dismissFullAccessConfirm();
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBeUndefined();
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('确认且 IPC 成功后才 setLevel 为 full', async () => {
    const pending = enableFullAccess('/ws');
    await confirmFullAccess();
    await pending;
    expect(setApproval).toHaveBeenCalledWith('/ws', 'full');
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('full');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('IPC 失败时不改档、弹窗保持打开', async () => {
    setApproval.mockRejectedValueOnce(new Error('RUNTIME_CONFIG_UNAVAILABLE'));
    const pending = enableFullAccess('/ws');
    await expect(confirmFullAccess()).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBeUndefined();
    expect(useFullAccessConfirmStore.getState()).toMatchObject({ open: true, busy: false });
    dismissFullAccessConfirm();
    await pending;
  });

  it('弹窗已打开时第二次调用立即返回且不覆盖 workspace', async () => {
    const first = enableFullAccess('/a');
    const second = enableFullAccess('/b');
    await second;
    expect(useFullAccessConfirmStore.getState().workspace).toBe('/a');
    dismissFullAccessConfirm();
    await first;
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('busy 时 dismiss 被忽略', async () => {
    let release: () => void = () => {};
    setApproval.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = enableFullAccess('/ws');
    const confirming = confirmFullAccess();
    await Promise.resolve();
    expect(useFullAccessConfirmStore.getState().busy).toBe(true);
    dismissFullAccessConfirm();
    expect(useFullAccessConfirmStore.getState().open).toBe(true);
    release();
    await confirming;
    await pending;
  });
});
