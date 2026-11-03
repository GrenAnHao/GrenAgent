// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval, getState, getSessionDefaults, setSessionDefaults, getSettings, messageError } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve({ ok: true, sessionPath: '/ws/a.jsonl' })),
  getState: vi.fn(() =>
    Promise.resolve({
      sessionFile: '/ws/a.jsonl',
      preferences: {
        model: { provider: 'anthropic', id: 'm' },
        thinkingLevel: 'medium',
        mode: 'agent',
        approval: 'auto',
        revision: 2,
      },
    }),
  ),
  getSessionDefaults: vi.fn(() => Promise.resolve({ revision: 0 })),
  setSessionDefaults: vi.fn(() => Promise.resolve({ revision: 1 })),
  getSettings: vi.fn(() => Promise.resolve({})),
  messageError: vi.fn(),
}));

vi.mock('../../../../lib/pi', () => ({
  pi: { setApproval, getState, getSessionDefaults, setSessionDefaults, getSettings },
}));

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
      data-disabled={disabled ? 'true' : 'false'}
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
  useOptionalAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));

vi.mock('../../../../store/session', () => {
  const snapshot = () => ({
    activeSessionPath: '/ws/a.jsonl' as string | null,
    draftConversationCwd: null as string | null,
    draftConversationId: null as string | null,
  });
  const useSessionStore = (sel: (s: ReturnType<typeof snapshot>) => unknown) => sel(snapshot());
  useSessionStore.getState = snapshot;
  return { useSessionStore };
});

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: { ...actual.App, useApp: () => ({ message: { error: messageError, success: vi.fn(), warning: vi.fn() } }) },
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
  };
});

import { APPROVAL_LABELS } from '../../../../stores/approvalStore';
import { useModeStore } from '../../../../stores/modeStore';
import {
  __resetFullAccessConfirmForTest,
  dismissFullAccessConfirm,
  useFullAccessConfirmStore,
} from '../../../../stores/fullAccessConfirmStore';
import { FullAccessConfirmModal } from '../FullAccessConfirmModal';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from '../../../../stores/sessionPreferencesStore';
import ApprovalAction from './ApprovalAction';

const OWNER = '/ws/a.jsonl';

function prefs(patch: Record<string, unknown> = {}) {
  return {
    model: { provider: 'anthropic', id: 'm' },
    thinkingLevel: 'medium',
    mode: 'agent',
    approval: 'auto',
    revision: 2,
    ...patch,
  };
}

function renderApproval() {
  return render(
    <>
      <ApprovalAction />
      <FullAccessConfirmModal />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetFullAccessConfirmForTest();
  resetSessionPreferencesForTests();
  useModeStore.setState({ byWorkspace: {}, bySession: {} });
  setApproval.mockResolvedValue({ ok: true, sessionPath: OWNER, preferences: prefs({ approval: 'workspace' }) });
  getState.mockResolvedValue({ sessionFile: OWNER, preferences: prefs() });
});

afterEach(() => {
  dismissFullAccessConfirm();
  cleanup();
});

describe('ApprovalAction session snapshot', () => {
  it('selects 替我审批 for the current session only, no confirm dialog', async () => {
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.auto }));

    await waitFor(() => expect(setApproval).toHaveBeenCalledWith('/ws', 'auto', OWNER));
    expect(screen.queryByTestId('full-access-confirm-modal')).not.toBeInTheDocument();
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('workspace');
    // 不再写项目默认
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('asks for confirmation before enabling full access and never writes defaults for a draft', async () => {
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));

    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();
    expect(setApproval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));

    await waitFor(() => expect(setApproval).toHaveBeenCalledWith('/ws', 'full', OWNER));
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('cancelling full access writes nothing', async () => {
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('full-access-cancel'));
    await waitFor(() => expect(useFullAccessConfirmStore.getState().open).toBe(false));
    expect(setApproval).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
  });

  it('Ask keeps the saved value visible but disables editing; leaving Ask restores it', async () => {
    getState.mockResolvedValue({ sessionFile: OWNER, preferences: prefs({ mode: 'ask', approval: 'workspace' }) });
    const view = renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'workspace'));
    expect(screen.getByRole('button', { name: APPROVAL_LABELS.full })).toBeDisabled();
    // Ask 下完全权限没有实际生效，不标红。
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-trigger-class', '');
    // 保存值没有被改成 readonly。
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('workspace');

    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ mode: 'agent', approval: 'workspace' }));
    view.rerender(
      <>
        <ApprovalAction />
        <FullAccessConfirmModal />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: APPROVAL_LABELS.full })).not.toBeDisabled(),
    );
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'workspace');
  });

  it('shows a save failure and keeps the confirmed approval', async () => {
    setApproval.mockRejectedValueOnce(new Error('SESSION_NOT_LOADED'));
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.readonly }));
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
    expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto');
  });

  it('keeps A and B approval levels apart', async () => {
    useSessionPreferencesStore.getState().applyServer('/ws/a.jsonl', prefs({ approval: 'ask' }));
    useSessionPreferencesStore.getState().applyServer('/ws/b.jsonl', prefs({ approval: 'readonly' }));
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'ask'));
    // 只改 A
    setApproval.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs({ approval: 'workspace' }) });
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.workspace }));
    await waitFor(() => expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.approval).toBe('workspace'));
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.approval).toBe('readonly');
  });
});

describe('ApprovalAction full access confirmation ownership', () => {
  it('applies the full-access receipt to the captured owner even after switching away', async () => {
    let resolveSet: (value: unknown) => void = () => {};
    setApproval.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSet = resolve; }),
    );
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));
    await waitFor(() => expect(setApproval).toHaveBeenCalled());

    // 确认期间用户切到 B：回执只能落到捕获的 A。
    useSessionPreferencesStore.getState().applyServer('/ws/b.jsonl', prefs({ approval: 'readonly', revision: 1 }));
    resolveSet({ ok: true, sessionPath: OWNER, preferences: prefs({ approval: 'full' }), revision: 3 });

    await waitFor(() => expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('full'));
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.approval).toBe('readonly');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('does not write project defaults when confirming full access from a draft', async () => {
    // 草稿：只有本地 owner，不调 setApproval、不弹确认窗之外的写入。
    renderApproval();
    await waitFor(() => expect(screen.getByTestId('approval-select')).toHaveAttribute('data-value', 'auto'));
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_LABELS.full }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByTestId('full-access-ok'));
    await waitFor(() => expect(setApproval).toHaveBeenCalledWith('/ws', 'full', OWNER));
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });
});
