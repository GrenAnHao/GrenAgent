// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval, messageError } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
  messageError: vi.fn(),
}));

vi.mock('../../../lib/pi', () => ({ pi: { setApproval } }));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: { ...actual.App, useApp: () => ({ message: { error: messageError } }) },
    Modal: ({
      open,
      children,
      onOk,
      onCancel,
      okText,
      cancelText,
      okButtonProps,
      cancelButtonProps,
      confirmLoading,
      title,
      centered,
      'data-testid': testId,
    }: {
      open?: boolean;
      children?: ReactNode;
      onOk?: () => void;
      onCancel?: () => void;
      okText?: ReactNode;
      cancelText?: ReactNode;
      okButtonProps?: { disabled?: boolean };
      cancelButtonProps?: { disabled?: boolean };
      confirmLoading?: boolean;
      title?: ReactNode;
      centered?: boolean;
      'data-testid'?: string;
    }) =>
      open ? (
        <div data-testid={testId} data-centered={centered ? 'true' : undefined}>
          <div>{title}</div>
          {children}
          <button
            type="button"
            data-testid="full-access-cancel"
            disabled={cancelButtonProps?.disabled}
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            data-testid="full-access-ok"
            disabled={okButtonProps?.disabled || confirmLoading}
            onClick={onOk}
          >
            {okText}
          </button>
        </div>
      ) : null,
    Checkbox: ({
      children,
      checked,
      disabled,
      onChange,
    }: {
      children?: ReactNode;
      checked?: boolean;
      disabled?: boolean;
      onChange?: (e: { target: { checked: boolean } }) => void;
    }) => (
      <label>
        <input
          type="checkbox"
          aria-label={typeof children === 'string' ? children : undefined}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.({ target: { checked: e.target.checked } })}
        />
        {children}
      </label>
    ),
    Alert: ({ title, type }: { title?: ReactNode; type?: string }) => (
      <div data-testid="full-access-alert" data-type={type}>
        {title}
      </div>
    ),
  };
});

import { useSessionStore } from '../../../store/session';
import { useApprovalStore } from '../../../stores/approvalStore';
import {
  __resetFullAccessConfirmForTest,
  dismissFullAccessConfirm,
  enableFullAccess,
  useFullAccessConfirmStore,
} from '../../../stores/fullAccessConfirmStore';
import { FullAccessConfirmModal } from './FullAccessConfirmModal';

function renderModal() {
  return render(<FullAccessConfirmModal />);
}

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  useSessionStore.setState({ activeWorkspace: '/ws' });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
  messageError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('FullAccessConfirmModal', () => {
  it('打开时确认钮禁用；勾选后可点；未勾选 click 启用不会调 setApproval', async () => {
    const pending = enableFullAccess('/ws');
    renderModal();

    expect(screen.getByTestId('full-access-confirm-modal')).toBeInTheDocument();
    expect(screen.getByTestId('full-access-confirm-modal')).toHaveAttribute('data-centered', 'true');
    expect(screen.getByTestId('full-access-ok')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    expect(screen.getByTestId('full-access-ok')).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    expect(screen.getByTestId('full-access-ok')).toBeDisabled();
    fireEvent.click(screen.getByTestId('full-access-ok'));
    expect(setApproval).not.toHaveBeenCalled();

    dismissFullAccessConfirm();
    await pending;
  });

  it('取消不写 IPC，并关掉弹窗', async () => {
    const pending = enableFullAccess('/ws');
    renderModal();

    fireEvent.click(screen.getByTestId('full-access-cancel'));
    await pending;

    expect(setApproval).not.toHaveBeenCalled();
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('重新打开时勾选被清空', async () => {
    renderModal();
    let pending = enableFullAccess('/ws');

    fireEvent.click(await screen.findByLabelText('我已了解风险，并愿意继续'));
    expect(screen.getByLabelText('我已了解风险，并愿意继续')).toBeChecked();

    fireEvent.click(screen.getByTestId('full-access-cancel'));
    await pending;

    pending = enableFullAccess('/ws');
    await screen.findByTestId('full-access-confirm-modal');
    expect(screen.getByLabelText('我已了解风险，并愿意继续')).not.toBeChecked();
    expect(screen.getByTestId('full-access-ok')).toBeDisabled();

    dismissFullAccessConfirm();
    await pending;
  });

  it('勾选并启用后调用 setApproval；然后对另一个 workspace IPC 失败时弹窗仍在', async () => {
    let pending = enableFullAccess('/ws');
    const { unmount } = renderModal();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));
    await pending;

    expect(setApproval).toHaveBeenCalledWith('/ws', 'full', null);
    expect(useFullAccessConfirmStore.getState().open).toBe(false);

    unmount();
    setApproval.mockRejectedValueOnce(new Error('RUNTIME_CONFIG_UNAVAILABLE'));
    useSessionStore.getState().setActiveWorkspace('/other');

    pending = enableFullAccess('/other');
    renderModal();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));
    await vi.waitFor(() => expect(messageError).toHaveBeenCalledWith('RUNTIME_CONFIG_UNAVAILABLE'));

    expect(setApproval).toHaveBeenLastCalledWith('/other', 'full', null);
    expect(useFullAccessConfirmStore.getState()).toMatchObject({ open: true, busy: false });
    expect(screen.getByLabelText('我已了解风险，并愿意继续')).toBeChecked();

    dismissFullAccessConfirm();
    await pending;
  });

  it('活动工作区变了且未 busy 时按取消关闭', async () => {
    const pending = enableFullAccess('/ws');
    renderModal();

    useSessionStore.setState({ activeWorkspace: '/other' });
    await vi.waitFor(() => expect(useFullAccessConfirmStore.getState().open).toBe(false));
    await pending;

    expect(setApproval).not.toHaveBeenCalled();
  });

  it('IPC 挂起期间切换工作区后失败则关闭弹窗', async () => {
    let rejectIpc: (err: Error) => void = () => {};
    setApproval.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectIpc = reject;
        }),
    );

    const pending = enableFullAccess('/ws');
    renderModal();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));
    await vi.waitFor(() => expect(useFullAccessConfirmStore.getState().busy).toBe(true));

    useSessionStore.setState({ activeWorkspace: '/other' });
    expect(useFullAccessConfirmStore.getState().open).toBe(true);

    rejectIpc(new Error('RUNTIME_CONFIG_UNAVAILABLE'));
    await vi.waitFor(() => expect(messageError).toHaveBeenCalledWith('RUNTIME_CONFIG_UNAVAILABLE'));
    await vi.waitFor(() => expect(useFullAccessConfirmStore.getState().open).toBe(false));

    expect(useApprovalStore.getState().byWorkspace['/ws']).toBeUndefined();
    await pending;
  });
});
