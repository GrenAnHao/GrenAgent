// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval, messageError } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
  messageError: vi.fn(),
}));

vi.mock('../../../../lib/pi', () => ({ pi: { setApproval } }));

vi.mock('@lobehub/ui', () => ({
  Icon: () => null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    value,
    onChange,
    disabled,
    options,
  }: {
    value?: string;
    onChange?: (v: string) => void;
    disabled?: boolean;
    options?: Array<{ label: string; value: string }>;
  }) => (
    <div data-testid="approval-select" data-value={value}>
      {options?.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange?.(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));

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
      'data-testid'?: string;
    }) =>
      open ? (
        <div data-testid={testId}>
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

import { APPROVAL_LABELS } from '../../../../stores/approvalStore';
import { useApprovalStore } from '../../../../stores/approvalStore';
import { useModeStore } from '../../../../stores/modeStore';
import {
  __resetFullAccessConfirmForTest,
  dismissFullAccessConfirm,
  useFullAccessConfirmStore,
} from '../../../../stores/fullAccessConfirmStore';
import { FullAccessConfirmModal } from '../FullAccessConfirmModal';
import ApprovalAction from './ApprovalAction';

function renderApproval() {
  return render(
    <>
      <ApprovalAction />
      <FullAccessConfirmModal />
    </>,
  );
}

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  useModeStore.setState({ byWorkspace: {} });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
  messageError.mockReset();
});

afterEach(() => {
  dismissFullAccessConfirm();
  cleanup();
});

describe('ApprovalAction', () => {
  it('选「替我审批」立刻 setApproval("/ws","auto")，不出现确认窗，approvalStore 为 auto', async () => {
    renderApproval();

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.auto }));

    await waitFor(() => {
      expect(setApproval).toHaveBeenCalledWith('/ws', 'auto');
    });
    expect(screen.queryByTestId('full-access-confirm-modal')).not.toBeInTheDocument();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('auto');
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto');
  });

  it('当前是 auto 时选「完全权限」：出现确认窗，确认前不调用 setApproval，选择器 data-value 仍是 auto', async () => {
    useApprovalStore.setState({ byWorkspace: { '/ws': 'auto' } });
    renderApproval();

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));

    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();
    expect(setApproval).not.toHaveBeenCalled();
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto');
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('auto');
  });

  it('当前是 workspace 时选完全权限，勾选并确认：才 setApproval("/ws","full")，store 为 full', async () => {
    useApprovalStore.setState({ byWorkspace: { '/ws': 'workspace' } });
    renderApproval();

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();
    expect(setApproval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));

    await waitFor(() => {
      expect(setApproval).toHaveBeenCalledWith('/ws', 'full');
    });
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('full');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'full');
  });

  it('当前是 ask 档时选完全权限再取消：不写 IPC，档位仍是 ask', async () => {
    useApprovalStore.setState({ byWorkspace: { '/ws': 'ask' } });
    renderApproval();

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('full-access-cancel'));

    await waitFor(() => {
      expect(useFullAccessConfirmStore.getState().open).toBe(false);
    });
    expect(setApproval).not.toHaveBeenCalled();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('ask');
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'ask');
  });

  it('Ask 模式：选择器禁用，点完全权限不弹窗、不写 IPC', () => {
    useModeStore.setState({ byWorkspace: { '/ws': 'ask' } });
    useApprovalStore.setState({ byWorkspace: { '/ws': 'auto' } });
    renderApproval();

    const fullButton = screen.getByRole('button', { name: APPROVAL_LABELS.full });
    expect(fullButton).toBeDisabled();

    fireEvent.click(fullButton);

    expect(screen.queryByTestId('full-access-confirm-modal')).not.toBeInTheDocument();
    expect(setApproval).not.toHaveBeenCalled();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('auto');
  });
});
