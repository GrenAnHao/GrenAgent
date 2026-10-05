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
    optionRender,
    classNames,
  }: {
    value?: string;
    onChange?: (v: string) => void;
    disabled?: boolean;
    options?: Array<{ label: string; value: string }>;
    optionRender?: (opt: { label: string; value: string }) => ReactNode;
    classNames?: { trigger?: string; prefix?: string; value?: string };
  }) => (
    <div
      data-testid="approval-select"
      data-value={value}
      data-trigger-class={classNames?.trigger ?? ''}
      data-prefix-class={classNames?.prefix ?? ''}
    >
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
      {options?.map((opt) => (
        <div key={`render-${opt.value}`} data-testid={`option-render-${opt.value}`}>
          {optionRender?.(opt)}
        </div>
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
import { useSessionStore } from '../../../../store/session';
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
  useApprovalStore.setState({ byWorkspace: {}, bySession: {} });
  useModeStore.setState({ byWorkspace: {}, bySession: {} });
  useSessionStore.setState({ activeSessionPath: null, draftConversationCwd: null });
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
      expect(setApproval).toHaveBeenCalledWith('/ws', 'auto', null);
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
      expect(setApproval).toHaveBeenCalledWith('/ws', 'full', null);
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

  it('下拉里只有「完全权限」一项带错误色', () => {
    renderApproval();
    const fullClass = screen.getByTestId('option-render-full').firstElementChild?.className ?? '';
    expect(fullClass).not.toBe('');
    for (const level of ['readonly', 'ask', 'auto', 'workspace']) {
      expect(screen.getByTestId(`option-render-${level}`).firstElementChild?.className ?? '').toBe('');
    }
  });

  it('当前是完全权限：触发器文字和图标用同一个错误色类；其它档不加', () => {
    useApprovalStore.setState({ byWorkspace: { '/ws': 'full' } });
    const { unmount } = renderApproval();
    const select = screen.getByTestId('approval-select');
    const fullClass = screen.getByTestId('option-render-full').firstElementChild?.className;
    expect(select).toHaveAttribute('data-trigger-class', fullClass);
    expect(select).toHaveAttribute('data-prefix-class', fullClass);
    unmount();

    useApprovalStore.setState({ byWorkspace: { '/ws': 'workspace' } });
    renderApproval();
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-trigger-class', '');
  });

  it('Ask 模式下完全权限没有生效，触发器不标红', () => {
    useModeStore.setState({ byWorkspace: { '/ws': 'ask' } });
    useApprovalStore.setState({ byWorkspace: { '/ws': 'full' } });
    renderApproval();
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-trigger-class', '');
  });

  it('按会话：显示并只改当前会话的档，另一个会话保持自己的档', async () => {
    useApprovalStore.setState({
      byWorkspace: { '/ws': 'auto' },
      bySession: { '/ws/a.jsonl': 'ask', '/ws/b.jsonl': 'readonly' },
    });
    useSessionStore.setState({ activeSessionPath: '/ws/a.jsonl', draftConversationCwd: null });
    renderApproval();
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'ask');

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.workspace }));

    await waitFor(() => {
      expect(setApproval).toHaveBeenCalledWith('/ws', 'workspace', '/ws/a.jsonl');
    });
    expect(useApprovalStore.getState().bySession['/ws/a.jsonl']).toBe('workspace');
    expect(useApprovalStore.getState().bySession['/ws/b.jsonl']).toBe('readonly');
  });
});
