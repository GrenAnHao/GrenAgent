import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@lobehub/ui', () => ({
  Icon: () => null,
  Popover: ({
    children,
    content,
    onOpenChange,
  }: {
    children: ReactNode;
    content: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <span onClick={() => onOpenChange?.(true)}>{children}</span>
      {content}
    </div>
  ),
}));

const { piMock, messageError, messageSuccess, sessionState, modelsState } = vi.hoisted(() => ({
  piMock: {
    getState: vi.fn(),
    getSessionDefaults: vi.fn(),
    setSessionDefaults: vi.fn(),
    getSettings: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setFastMode: vi.fn(),
  },
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
  sessionState: {
    draftConversationCwd: null as string | null,
    draftConversationId: null as string | null,
    activeSessionPath: null as string | null,
  },
  modelsState: {
    list: [] as Array<Record<string, unknown>>,
  },
}));

const DEFAULT_MODELS: Array<Record<string, unknown>> = [
  { id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: true,
    thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' } },
  {
    id: 'g',
    name: 'GPT',
    provider: 'openai',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
  },
  { id: 'plain', name: 'Plain', provider: 'openai', api: 'openai-completions', reasoning: false },
];

vi.mock('../../../../lib/pi', () => ({ pi: piMock }));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
  useOptionalAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));
vi.mock('../../../../store/session', () => {
  const snapshot = () => ({
    draftConversationCwd: sessionState.draftConversationCwd,
    draftConversationId: sessionState.draftConversationId,
    activeSessionPath: sessionState.activeSessionPath,
  });
  const useSessionStore = (sel: (s: ReturnType<typeof snapshot>) => unknown) => sel(snapshot());
  useSessionStore.getState = snapshot;
  return { useSessionStore };
});
vi.mock('../../../settings/availableModelsCache', () => ({
  useAvailableModelsState: () => ({ models: modelsState.list, loading: false }),
  loadAvailableModels: () => Promise.resolve(modelsState.list),
  getCachedAvailableModels: () => modelsState.list,
}));
vi.mock('../../../settings/providerListCache', () => ({
  loadProviderList: () => Promise.resolve([{ id: 'anthropic', name: 'Anthropic' }, { id: 'openai', name: 'OpenAI' }]),
}));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: { ...actual.App, useApp: () => ({ message: { error: messageError, success: messageSuccess, warning: vi.fn() } }) },
    Segmented: ({
      value,
      options,
      onChange,
      disabled,
    }: {
      value?: string;
      options?: Array<{ label: ReactNode; value: string }>;
      onChange?: (v: string) => void;
      disabled?: boolean;
    }) => (
      <div data-testid="model-level-segmented" data-value={value} data-disabled={disabled ? 'true' : 'false'}>
        {options?.map((opt) => (
          <button key={opt.value} type="button" disabled={disabled} onClick={() => onChange?.(opt.value)}>
            {opt.label}
          </button>
        ))}
      </div>
    ),
  };
});

import { useSessionPreferencesStore, resetSessionPreferencesForTests } from '../../../../stores/sessionPreferencesStore';
import { useFastModeStore } from '../../../../stores/fastModeStore';
import ModelThinkingAction, {
  peekComposerLevel,
  peekComposerModel,
  resetModelThinkingCacheForTests,
} from './ModelThinkingAction';

const prefs = (patch: Record<string, unknown> = {}) => ({
  model: { provider: 'anthropic', id: 'm' },
  thinkingLevel: 'medium',
  mode: 'agent',
  approval: 'auto',
  revision: 3,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPreferencesForTests();
  resetModelThinkingCacheForTests();
  sessionState.draftConversationCwd = null;
  sessionState.draftConversationId = null;
  sessionState.activeSessionPath = null;
  modelsState.list = DEFAULT_MODELS.map((item) => ({ ...item }));
  piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs() });
  piMock.getSessionDefaults.mockResolvedValue(prefs({ revision: 0 }));
  piMock.getSettings.mockResolvedValue({});
  piMock.setModel.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setThinkingLevel.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setFastMode.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setSessionDefaults.mockImplementation(async (_ws: string, saved: unknown) => saved);
});

afterEach(cleanup);

describe('ModelThinkingAction reads the session snapshot', () => {
  it('shows the saved model and level for the current session without writing them back', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high' }),
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('GPT'));
    expect(screen.getByTestId('model-trigger').textContent).toContain('· 高');
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('keeps A high and B low with the same model', async () => {
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high' }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'low' }) },
    );
    sessionState.activeSessionPath = '/ws/a.jsonl';
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 高'));

    sessionState.activeSessionPath = '/ws/b.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 低'));
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('picks the model with the original session path and only touches the model field', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.setModel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'medium', mode: 'plan' }),
      revision: 4,
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(await screen.findByText('GPT'));
    await waitFor(() => expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g', '/ws/a.jsonl'));
    // 换模型不改其它三项保存偏好（这里服务端回执把 mode 也带回来了，但我们从不发 mode）。
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      model: { provider: 'openai', id: 'g' },
      mode: 'plan',
    });
  });

  it('picks a level for the current session only', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.setThinkingLevel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ thinkingLevel: 'high' }),
      revision: 5,
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(await screen.findByText('高'));
    await waitFor(() => expect(piMock.setThinkingLevel).toHaveBeenCalledWith('/ws', 'high', '/ws/a.jsonl'));
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('shows a visible error and keeps the saved value when a save fails', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.setThinkingLevel.mockRejectedValue(new Error('SESSION_NOT_LOADED'));
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 中'));
    fireEvent.click(await screen.findByText('高'));
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('medium');
    expect(screen.getByTestId('model-trigger').textContent).toContain('· 中');
  });

  it('disables the controls while the snapshot is loading', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    let resolveState: (value: unknown) => void = () => {};
    piMock.getState.mockReturnValue(new Promise((resolve) => { resolveState = resolve; }));
    render(<ModelThinkingAction />);
    expect(screen.getByTestId('model-trigger')).toBeDisabled();
    resolveState({ sessionFile: '/ws/a.jsonl', preferences: prefs() });
    await waitFor(() => expect(screen.getByTestId('model-trigger')).not.toBeDisabled());
  });

  it('shows off for a non-reasoning model but restores the saved level when switching back', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'openai', id: 'plain' }, thinkingLevel: 'high' }),
    });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('Plain'));
    // 非推理模型有效档位是 off，触发器不显示档位。
    expect(screen.getByTestId('model-trigger').textContent).not.toContain('·');
    // 但保存值仍是 high：弹层里要说明「已保存高，当前模型仅生效关闭」，不能只静默隐藏档位。
    expect(screen.getByTestId('thinking-effective-hint').textContent).toContain('高');
    expect(screen.getByTestId('thinking-effective-hint').textContent).toContain('关闭');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('high');

    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high' }),
    });
    useSessionPreferencesStore.getState().applyServer('/ws/a.jsonl', prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high' }));
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 高'));
    // 保存值与有效值一致时不显示提示。
    expect(screen.queryByTestId('thinking-effective-hint')).toBeNull();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('explains a fallback when the saved level is hidden by the model mapping', async () => {
    modelsState.list = [{
      id: 'g',
      name: 'GPT',
      provider: 'openai',
      api: 'openai-completions',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium' },
    }];
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high' }),
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 中'));
    expect(screen.getByTestId('thinking-effective-hint').textContent).toContain('高');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('high');
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('reports a model that the host marked unavailable instead of silently keeping it', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.setModel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'gone', id: 'flash' } }),
      revision: 4,
      unavailable: ['model'],
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(await screen.findByText('GPT'));
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBe('unavailable');
  });
});

describe('ModelThinkingAction drafts', () => {
  beforeEach(() => {
    sessionState.draftConversationCwd = '/ws';
    sessionState.draftConversationId = 'draft:one';
  });

  it('initialises from project defaults and writes only local values', async () => {
    piMock.getSessionDefaults.mockResolvedValue(
      prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high', revision: 0 }),
    );
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('GPT'));
    fireEvent.click(await screen.findByText('低'));
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(piMock.setSessionDefaults).not.toHaveBeenCalled();
    expect(peekComposerLevel('/ws')).toBe('low');
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('falls back to the app default model, then the first catalog entry', async () => {
    piMock.getSessionDefaults.mockResolvedValue({ revision: 0 });
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/plain' });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'plain' }));
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('keeps two drafts of the same workspace apart', async () => {
    piMock.getSessionDefaults.mockResolvedValue({
      model: { provider: 'openai', id: 'g' },
      thinkingLevel: 'high',
      mode: 'agent',
      approval: 'auto',
      revision: 0,
    });
    const first = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('GPT'));
    fireEvent.click(await screen.findByText('低'));
    first.unmount();

    sessionState.draftConversationId = 'draft:two';
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('· 高'));
    expect(peekComposerLevel('/ws')).toBe('high');
  });

  it('surfaces a defaults load failure and refuses to look ready', async () => {
    piMock.getSessionDefaults.mockRejectedValue(new Error('Electron command is not registered: agent_get_session_defaults'));
    render(<ModelThinkingAction />);
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    expect(screen.getByTestId('model-trigger')).toBeDisabled();
  });
});

describe('ModelThinkingAction project defaults entry', () => {
  it('saves all four saved values as project defaults from the model popover', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({
        model: { provider: 'openai', id: 'g' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'readonly',
      }),
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('GPT'));
    fireEvent.click(screen.getByTestId('save-project-defaults'));
    await waitFor(() =>
      expect(piMock.setSessionDefaults).toHaveBeenCalledWith('/ws', {
        model: { provider: 'openai', id: 'g' },
        thinkingLevel: 'high',
        mode: 'ask',
        approval: 'readonly',
        // Fast 也是会话偏好：快照里是关闭时，显式默认必须把它一起写出去。
        fastMode: false,
        revision: 0,
      }),
    );
    await waitFor(() => expect(messageSuccess).toHaveBeenCalled());
    // 只写默认，不改当前会话。
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('keeps the failure visible when saving defaults fails', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.setSessionDefaults.mockRejectedValue(new Error('disk full'));
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(screen.getByTestId('save-project-defaults'));
    await waitFor(() => expect(messageError).toHaveBeenCalledWith(expect.stringContaining('disk full')));
  });
});

describe('ModelThinkingAction Fast follows the composer owner', () => {
  const FAST_MODELS = [
    { id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: true,
      thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' } },
  ];

  const openPanel = async () => {
    fireEvent.click(await screen.findByTestId('model-trigger'));
  };

  it('shows the session Fast value and writes it with the original session path', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ fastMode: true }),
    });
    piMock.setFastMode.mockResolvedValue({
      ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs({ fastMode: false, revision: 4 }), revision: 4,
    });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger-fast').textContent).toBe('· 快速'));
    await openPanel();
    const toggle = screen.getByTestId('model-fast-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(piMock.setFastMode).toHaveBeenCalledWith('/ws', false, '/ws/a.jsonl'));
    await waitFor(() => expect(screen.queryByTestId('model-trigger-fast')).toBeNull());
    // 不影响其它四项。
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(piMock.setSessionDefaults).not.toHaveBeenCalled();
  });

  it('keeps A on and B off for the same project and model through a round trip', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: true, revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ fastMode: false, revision: 3 }) },
    );
    sessionState.activeSessionPath = '/ws/a.jsonl';
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger-fast').textContent).toBe('· 快速'));

    sessionState.activeSessionPath = '/ws/b.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.queryByTestId('model-trigger-fast')).toBeNull());
    await openPanel();
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle').getAttribute('aria-pressed')).toBe('false'));

    sessionState.activeSessionPath = '/ws/a.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger-fast').textContent).toBe('· 快速'));
    expect(piMock.setFastMode).not.toHaveBeenCalled();
  });

  it('hides the toggle when the capability is revoked but keeps the saved session value', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ fastMode: true }),
    });
    // 目录刷新后模型不再声明 Fast：控件隐藏，保存值不丢。
    modelsState.list = [{ id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: false }];
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    await openPanel();
    expect(screen.queryByTestId('model-fast-toggle')).toBeNull();
    expect(screen.queryByTestId('model-trigger-fast')).toBeNull();
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
    expect(piMock.setFastMode).not.toHaveBeenCalled();
  });

  it('rolls back visibly when the Fast save fails', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false }) });
    piMock.setFastMode.mockRejectedValue(new Error('SESSION_NOT_LOADED'));
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    await openPanel();
    const toggle = screen.getByTestId('model-fast-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(messageError).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle').getAttribute('aria-pressed')).toBe('false'));
    expect(screen.queryByTestId('model-trigger-fast')).toBeNull();
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(false);
  });

  it('does not let a late Fast receipt overwrite the newly selected session', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false, revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ fastMode: false, revision: 3 }) },
    );
    sessionState.activeSessionPath = '/ws/a.jsonl';
    let resolveWrite: (value: unknown) => void = () => {};
    piMock.setFastMode.mockImplementationOnce(
      () => new Promise((resolve) => { resolveWrite = resolve; }),
    );
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    await openPanel();
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    // 切换会话：A 的回执迟到，必须只落到 A。
    sessionState.activeSessionPath = '/ws/b.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')).toBeDefined());
    resolveWrite({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs({ fastMode: true, revision: 9 }), revision: 9 });
    await waitFor(() => expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true));
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.fastMode).toBe(false);
  });

  it('initialises a draft with Fast off and toggles it locally only', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    sessionState.draftConversationCwd = '/ws';
    sessionState.draftConversationId = 'draft:fast';
    piMock.getSessionDefaults.mockResolvedValue(prefs({ revision: 0 }));
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    expect(useSessionPreferencesStore.getState().peek('draft:fast')?.fastMode).toBe(false);
    await openPanel();
    const toggle = screen.getByTestId('model-fast-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('model-trigger-fast').textContent).toBe('· 快速'));
    expect(useSessionPreferencesStore.getState().peek('draft:fast')?.fastMode).toBe(true);
    expect(piMock.setFastMode).not.toHaveBeenCalled();
    expect(piMock.setSessionDefaults).not.toHaveBeenCalled();
  });
});

describe('ModelThinkingAction ignores the legacy global Fast store', () => {
  it('does not read or write the per-model global store for the toggle', async () => {
    modelsState.list = [{ id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: true,
      thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' } }];
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false }) });
    const load = vi.fn();
    useFastModeStore.setState({ byModel: { 'anthropic m': true }, loaded: true, loading: false, pending: {}, error: null, load });
    render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    expect(screen.queryByTestId('model-trigger-fast')).toBeNull();
    fireEvent.click(screen.getByTestId('model-trigger'));
    expect(screen.getByTestId('model-fast-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    await waitFor(() => expect(piMock.setFastMode).toHaveBeenCalledWith('/ws', true, '/ws/a.jsonl'));
    expect(useFastModeStore.getState().byModel['anthropic m']).toBe(true);
  });
});

describe('ModelThinkingAction Fast write settling', () => {
  const FAST_MODELS = [
    { id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: true,
      thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' } },
  ];

  it('ignores a late failure from the previous session and keeps the new one pending', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false, revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ fastMode: false, revision: 3 }) },
    );
    sessionState.activeSessionPath = '/ws/a.jsonl';
    let rejectA: (reason: unknown) => void = () => {};
    piMock.setFastMode.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectA = reject; }),
    );
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(screen.getByTestId('model-trigger'));
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).toBeDisabled());

    // 切到 B，并在 B 上点一次（B 的写入仍未回执）。
    sessionState.activeSessionPath = '/ws/b.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle').getAttribute('aria-pressed')).toBe('false'));
    let resolveB: (value: unknown) => void = () => {};
    piMock.setFastMode.mockImplementationOnce(
      () => new Promise((resolve) => { resolveB = resolve; }),
    );
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).toBeDisabled());

    // A 的失败迟到：不能把 B 的在途状态清掉，也不能在 B 上弹错。
    rejectA(new Error('SESSION_NOT_LOADED'));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId('model-fast-toggle')).toBeDisabled();
    expect(screen.queryByTestId('model-fast-error')).toBeNull();
    expect(messageError).not.toHaveBeenCalled();
    // B 自己的乐观值在途，A 的失败既不回滚它也不改动它。
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.fastMode).toBe(true);

    resolveB({ ok: true, sessionPath: '/ws/b.jsonl', preferences: prefs({ fastMode: true, revision: 5 }), revision: 5 });
    await waitFor(() => expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.fastMode).toBe(true));
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).not.toBeDisabled());
    expect(screen.queryByTestId('model-fast-error')).toBeNull();
  });

  it('drops a stale attempt even after switching back to the same session', async () => {
    modelsState.list = FAST_MODELS.map((item) => ({ ...item }));
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false }) });
    let rejectFirst: (reason: unknown) => void = () => {};
    piMock.setFastMode.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFirst = reject; }),
    );
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(screen.getByTestId('model-trigger'));
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).toBeDisabled());

    sessionState.activeSessionPath = '/ws/b.jsonl';
    view.rerender(<ModelThinkingAction />);
    sessionState.activeSessionPath = '/ws/a.jsonl';
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).not.toBeDisabled());

    rejectFirst(new Error('SESSION_NOT_LOADED'));
    // 数据层仍会为 A 回滚（那是会话自己的确认值），但 UI 的失败提示/loading 属于那次旧 attempt，不能再弹。
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle').getAttribute('aria-pressed')).toBe('false'));
    expect(screen.queryByTestId('model-fast-error')).toBeNull();
    expect(messageError).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-fast-toggle')).not.toBeDisabled();
  });
});

describe('ModelThinkingAction Fast write settling on unmount', () => {
  it('does not toast a late failure after the composer unmounts', async () => {
    modelsState.list = [{ id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true, fast: true,
      thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' } }];
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs({ fastMode: false }) });
    let rejectFirst: (reason: unknown) => void = () => {};
    piMock.setFastMode.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFirst = reject; }),
    );
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(screen.getByTestId('model-trigger').textContent).toContain('My Model'));
    fireEvent.click(screen.getByTestId('model-trigger'));
    fireEvent.click(screen.getByTestId('model-fast-toggle'));
    await waitFor(() => expect(screen.getByTestId('model-fast-toggle')).toBeDisabled());

    // 布局切换（有会话 → 空草稿）会整块卸载输入栏；迟到的失败不能弹到新页面上。
    view.unmount();
    rejectFirst(new Error('SESSION_NOT_LOADED'));
    await Promise.resolve();
    await Promise.resolve();
    expect(messageError).not.toHaveBeenCalled();
  });
});
