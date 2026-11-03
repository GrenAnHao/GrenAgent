// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setMode, setSessionDefaults, messageWarning, messageError, sessionState } = vi.hoisted(() => ({
  setMode: vi.fn(() => Promise.resolve({ ok: true, mode: 'ultra', sessionPath: '/ws/.pi/sessions/a.jsonl' })),
  setSessionDefaults: vi.fn(() => Promise.resolve({ revision: 1 })),
  messageWarning: vi.fn(),
  messageError: vi.fn(),
  sessionState: {
    activeSessionPath: '/ws/.pi/sessions/a.jsonl' as string | null,
    draftConversationCwd: null as string | null,
    draftConversationId: null as string | null,
  },
}));

vi.mock('../../../../lib/pi', () => ({
  pi: {
    setMode,
    getState: vi.fn(() =>
      Promise.resolve({
        sessionFile: '/ws/.pi/sessions/a.jsonl',
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
    setSessionDefaults,
    getSettings: vi.fn(() => Promise.resolve({})),
  },
}));

vi.mock('@lobehub/ui', () => ({
  Icon: ({ icon }: { icon?: { displayName?: string; name?: string } | null }) =>
    icon ? <span data-icon={icon.displayName ?? icon.name ?? 'icon'} /> : null,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    value,
    onChange,
    options,
    optionRender,
    prefix,
    disabled,
  }: {
    value?: string;
    onChange?: (v: string) => void;
    options?: Array<{ label: string; value: string }>;
    optionRender?: (opt: { label: string; value: string }) => ReactNode;
    prefix?: unknown;
    disabled?: boolean;
  }) => (
    <div data-testid="mode-select" data-value={value} data-disabled={disabled ? 'true' : 'false'}>
      <span data-testid="mode-prefix">{prefix ? 'has-icon' : 'no-icon'}</span>
      {options?.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          data-testid={`mode-option-${opt.value}`}
          onClick={() => onChange?.(opt.value)}
        >
          <span data-testid={`mode-option-body-${opt.value}`}>{optionRender?.(opt)}</span>
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: {
      ...actual.App,
      useApp: () => ({ message: { warning: messageWarning, error: messageError, success: vi.fn() } }),
    },
  };
});

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
  useOptionalAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));

vi.mock('../../../../store/session', () => {
  const snapshot = () => ({ ...sessionState });
  const useSessionStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) => selector(snapshot());
  useSessionStore.getState = snapshot;
  return { useSessionStore };
});

vi.mock('../../../settings/availableModelsCache', () => ({
  useAvailableModelsState: () => ({ models: [], loading: false }),
  loadAvailableModels: () => Promise.resolve([]),
  getCachedAvailableModels: () => [],
}));

import ModeAction, { MODE_ICONS, readBlocked } from './ModeAction';
import { AGENT_MODES, useModeStore } from '../../../../stores/modeStore';
import { useApprovalStore } from '../../../../stores/approvalStore';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from '../../../../stores/sessionPreferencesStore';

const prefs = (patch: Record<string, unknown> = {}) => ({
  model: { provider: 'anthropic', id: 'm' },
  thinkingLevel: 'medium',
  mode: 'agent',
  approval: 'auto',
  revision: 2,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPreferencesForTests();
  useModeStore.setState({ byWorkspace: {}, bySession: {} });
  useApprovalStore.setState({ byWorkspace: {}, bySession: {} });
  sessionState.activeSessionPath = '/ws/.pi/sessions/a.jsonl';
  sessionState.draftConversationCwd = null;
  sessionState.draftConversationId = null;
  setMode.mockResolvedValue({ ok: true, mode: 'ultra', sessionPath: '/ws/.pi/sessions/a.jsonl', preferences: prefs({ mode: 'ultra' }) });
});

afterEach(cleanup);

describe('ModeAction ultra entry', () => {
  it('gives every selectable mode its own icon, Ultra included', () => {
    const icons = AGENT_MODES.map((mode) => MODE_ICONS[mode]);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(AGENT_MODES.length);
    expect(MODE_ICONS.ultra).not.toBe(MODE_ICONS.agent);
  });

  it('lists the five supported modes with Ultra and without Brainstorm', async () => {
    useSessionPreferencesStore.getState().applyServer('/ws/.pi/sessions/a.jsonl', prefs({ mode: 'ultra' }));
    render(<ModeAction />);
    expect(AGENT_MODES).toContain('ultra');
    const option = screen.getByTestId('mode-option-ultra');
    expect(option.textContent).toContain('Ultra');
    expect(option.querySelector('[data-icon]')).not.toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.dataset.testid)).toEqual([
      'mode-option-agent',
      'mode-option-ask',
      'mode-option-debug',
      'mode-option-plan',
      'mode-option-ultra',
    ]);
    expect(screen.queryByTestId('mode-option-brainstorm')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('ultra'));
    expect(screen.getByTestId('mode-prefix').textContent).toBe('has-icon');
  });
});

describe('ModeAction session isolation', () => {
  it('shows the session snapshot and never writes it back on load', async () => {
    useSessionPreferencesStore.getState().applyServer('/ws/.pi/sessions/a.jsonl', prefs({ mode: 'plan' }));
    render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('plan'));
    expect(setMode).not.toHaveBeenCalled();
  });

  it('sends the mode with the original session path and does not touch project defaults', async () => {
    render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('agent'));
    fireEvent.click(screen.getByTestId('mode-option-ultra'));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('/ws', 'ultra', '/ws/.pi/sessions/a.jsonl'));
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
    expect(useModeStore.getState().byWorkspace['/ws']).toBeUndefined();
    await waitFor(() =>
      expect(useSessionPreferencesStore.getState().peek('/ws/.pi/sessions/a.jsonl')?.mode).toBe('ultra'),
    );
  });

  it('keeps each session mode separate (A plan, B ask)', async () => {
    useSessionPreferencesStore.getState().applyServer('/ws/.pi/sessions/a.jsonl', prefs({ mode: 'plan' }));
    useSessionPreferencesStore.getState().applyServer('/ws/.pi/sessions/b.jsonl', prefs({ mode: 'ask' }));
    const view = render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('plan'));
    sessionState.activeSessionPath = '/ws/.pi/sessions/b.jsonl';
    view.rerender(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('ask'));
  });

  it('rolls back and warns when the Plan guard refuses the switch', async () => {
    const { pi } = await import('../../../../lib/pi');
    // 后端快照就是 plan：ensure 每次都会重新读后端，测试预置值必须与权威快照一致。
    (pi.getState as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      sessionFile: '/ws/.pi/sessions/a.jsonl',
      preferences: prefs({ mode: 'plan' }),
    });
    setMode.mockResolvedValueOnce({
      ok: false,
      blocked: 'PLAN_UNCONFIRMED',
      mode: 'plan',
      message: '当前会话有尚未确认的计划，不能直接切到执行模式。',
      sessionPath: '/ws/.pi/sessions/a.jsonl',
    });
    render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('plan'));
    fireEvent.click(screen.getByTestId('mode-option-ultra'));
    await waitFor(() => expect(messageWarning).toHaveBeenCalledWith(expect.stringContaining('确认')));
    expect(useSessionPreferencesStore.getState().peek('/ws/.pi/sessions/a.jsonl')?.mode).toBe('plan');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('shows a save failure and keeps the confirmed mode', async () => {
    setMode.mockRejectedValueOnce(new Error('SESSION_NOT_LOADED'));
    render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('agent'));
    fireEvent.click(screen.getByTestId('mode-option-ask'));
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    expect(useSessionPreferencesStore.getState().peek('/ws/.pi/sessions/a.jsonl')?.mode).toBe('agent');
  });

  it('disables the selector while the snapshot is loading', async () => {
    const { pi } = await import('../../../../lib/pi');
    let resolveState: (value: unknown) => void = () => {};
    (pi.getState as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(
      new Promise((resolve) => { resolveState = resolve; }),
    );
    render(<ModeAction />);
    expect(screen.getByTestId('mode-select').dataset.disabled).toBe('true');
    resolveState({ sessionFile: '/ws/.pi/sessions/a.jsonl', preferences: prefs() });
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.disabled).toBe('false'));
  });
});

describe('ModeAction drafts', () => {
  beforeEach(() => {
    sessionState.activeSessionPath = null;
    sessionState.draftConversationCwd = '/ws';
    sessionState.draftConversationId = 'draft:one';
  });

  it('writes only the local draft preference and never calls the session setter', async () => {
    render(<ModeAction />);
    await waitFor(() => expect(screen.getByTestId('mode-select').dataset.value).toBe('agent'));
    fireEvent.click(screen.getByTestId('mode-option-plan'));
    await waitFor(() => expect(useSessionPreferencesStore.getState().peek('draft:one')?.mode).toBe('plan'));
    expect(setMode).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });
});

describe('readBlocked with ultra', () => {
  it('recognises ultra in the refusal payload', () => {
    expect(readBlocked({ ok: false, blocked: 'PLAN_UNCONFIRMED', mode: 'ultra', message: 'm' })).toEqual({
      mode: 'ultra',
      message: 'm',
    });
  });
});
