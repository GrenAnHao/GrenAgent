import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';

// 自定义选择器用 @lobehub/ui 的 Popover + Icon。mock 成直接渲染 children(触发器) + content(面板)，
// 这样面板里的搜索框 / 模型项 / 档位分段都能在测试里直接访问、点击。
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

const { piMock, sessionState, modelsState } = vi.hoisted(() => ({
  piMock: {
    getState: vi.fn(() =>
      Promise.resolve({
        thinkingLevel: 'off',
        model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      }),
    ),
    setModel: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
    getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  },
  sessionState: {
    draftConversationCwd: null as string | null,
    activeSessionPath: null as string | null,
  },
  modelsState: {
    list: [
      { id: 'm', name: 'My Model', provider: 'anthropic' },
      {
        id: 'g',
        name: 'GPT',
        provider: 'openai',
        api: 'openai-completions',
        reasoning: true,
        thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
      },
    ] as Array<Record<string, unknown>>,
  },
}));

const DEFAULT_MODELS: Array<Record<string, unknown>> = [
  { id: 'm', name: 'My Model', provider: 'anthropic' },
  {
    id: 'g',
    name: 'GPT',
    provider: 'openai',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
  },
];

vi.mock('../../../../lib/pi', () => ({ pi: piMock }));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', workspaceReady: true }),
}));
vi.mock('../../../../store/session', () => {
  const snapshot = () => ({
    draftConversationCwd: sessionState.draftConversationCwd,
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
  loadProviderList: () =>
    Promise.resolve([
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'openai', name: 'OpenAI' },
    ]),
}));

import { useThinkingMemoryStore } from '../../../../stores/thinkingMemoryStore';
import ModelThinkingAction, {
  clearComposerUserPick,
  commitComposerModelToSession,
  peekComposerModel,
  resetModelThinkingCacheForTests,
} from './ModelThinkingAction';

beforeEach(() => {
  vi.clearAllMocks();
  resetModelThinkingCacheForTests();
  sessionState.draftConversationCwd = null;
  sessionState.activeSessionPath = null;
  modelsState.list = DEFAULT_MODELS.map((item) => ({ ...item }));
  piMock.getSettings.mockResolvedValue({});
  piMock.getState.mockResolvedValue({
    thinkingLevel: 'off',
    model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
  });
});

afterEach(() => {
  cleanup();
});

describe('ModelThinkingAction', () => {
  it('点模型项调用 setModel', async () => {
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g');
  });

  it('点底部档位分段调用 setThinkingLevel，不误触选模型', async () => {
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('高'));
    expect(piMock.setThinkingLevel).toHaveBeenCalledWith('/ws', 'high');
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('搜索按名字过滤模型列表（输入只筛、搜不到显示空态）', async () => {
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    const input = screen.getByPlaceholderText('搜索模型');
    fireEvent.change(input, { target: { value: 'gpt' } });
    expect(screen.getByText('GPT')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'zzzznope' } });
    expect(screen.getByText('无匹配模型')).toBeTruthy();
  });

  it('空会话 getState 尚无模型时回退到可用列表，不停留在占位「模型」', async () => {
    piMock.getState.mockResolvedValue({ thinkingLevel: 'off', model: null, sessionFile: '/ws/s.jsonl' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'anthropic', 'm');
  });

  it('getState 报 SESSION_WORKSPACE_MISMATCH 时用列表回退显示，不写回 setModel', async () => {
    piMock.getState.mockRejectedValue(new Error('SESSION_WORKSPACE_MISMATCH'));
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('选模型后立刻用该模型 settings 里的 thinkingLevelMap 渲染档位', async () => {
    let selected = { id: 'm', provider: 'anthropic', api: 'anthropic-messages' };
    piMock.getState.mockImplementation(async () => ({
      thinkingLevel: 'off',
      // 模拟 getState 丢映射：只回 provider/id/api，档位配置必须从可用列表补上。
      model: { id: selected.id, provider: selected.provider, api: selected.api, reasoning: true },
    }));
    piMock.setModel.mockImplementation(async (_ws: string, provider: string, id: string) => {
      selected = { id, provider, api: 'openai-completions' };
    });

    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('GPT'));
    await waitFor(() => {
      expect(screen.getByText('低')).toBeTruthy();
    });
    expect(screen.getByText('中')).toBeTruthy();
    expect(screen.getByText('高')).toBeTruthy();
    expect(screen.queryByText('最低')).toBeNull();
    expect(screen.queryByText('很高')).toBeNull();
    expect(screen.queryByText('最高')).toBeNull();
  });

  it('当前会话模型已不在目录时回退到可用列表并写回 setModel', async () => {
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'flash', provider: 'gone' },
      sessionFile: '/ws/s.jsonl',
    });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'anthropic', 'm');
    });
    expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
  });

  it('会话模型还没回读完时显示加载，而不是占位「模型」', async () => {
    let resolveState: (value: unknown) => void = () => {};
    piMock.getState.mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );
    render(<ModelThinkingAction />);
    expect(screen.getByTestId('model-trigger').textContent).toContain('加载模型');
    resolveState({
      thinkingLevel: 'off',
      model: { id: 'g', provider: 'openai' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
  });

  it('草稿会话使用设置里的默认模型，忽略 getState.model，且不 setModel', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('草稿且设置为空时沿用上次选过的模型', async () => {
    const first = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getState).toHaveBeenCalled();
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g');
    piMock.setModel.mockClear();
    first.unmount();
    clearComposerUserPick('/ws');
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockClear();
    piMock.getSettings.mockResolvedValue({});
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getSettings).toHaveBeenCalled();
    });
    expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿默认模型不在目录时回退列表第一项，不跟上次选过的', async () => {
    const first = render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getState).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('GPT'));
    piMock.setModel.mockClear();
    first.unmount();
    clearComposerUserPick('/ws');
    sessionState.draftConversationCwd = '/ws';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'g', provider: 'openai', api: 'openai-completions', reasoning: true },
    });
    piMock.getSettings.mockClear();
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'gone/flash' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getSettings).toHaveBeenCalled();
    });
    expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    expect(peekComposerModel('/ws')).toEqual({ provider: 'anthropic', id: 'm' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿点选模型不 setModel，peek 为刚选的', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getSettings).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('草稿点选后打开下拉不按设置重放刚选的模型', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(piMock.getSettings).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    piMock.getSettings.mockClear();
    fireEvent.click(screen.getByTestId('model-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.getSettings).not.toHaveBeenCalled();
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('离开草稿不拿 getState 覆盖输入栏缓存', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    piMock.getState.mockClear();
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/s.jsonl',
    });
    piMock.setModel.mockClear();
    sessionState.draftConversationCwd = null;
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.getState).not.toHaveBeenCalled();
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿列表晚到后再套用设置默认模型', async () => {
    modelsState.list = [];
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getSettings).toHaveBeenCalled());
    piMock.getSettings.mockClear();
    modelsState.list = DEFAULT_MODELS.map((item) => ({ ...item }));
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿列表晚到时即使缓存已有列表内模型也套用设置默认', async () => {
    const first = render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getState).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    first.unmount();
    modelsState.list = [];
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    piMock.setModel.mockClear();
    const view = render(<ModelThinkingAction />);
    await waitFor(() => expect(piMock.getSettings).toHaveBeenCalled());
    piMock.getSettings.mockClear();
    modelsState.list = DEFAULT_MODELS.map((item) => ({ ...item }));
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('同工作区从已有会话进入草稿时，StrictMode 下仍套用设置默认模型', async () => {
    const view = render(
      <StrictMode>
        <ModelThinkingAction />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    piMock.setModel.mockClear();
    view.rerender(
      <StrictMode>
        <ModelThinkingAction />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿点选后列表变长不套回设置默认', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    fireEvent.click(await screen.findByText('GPT'));
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    piMock.getSettings.mockClear();
    modelsState.list = [
      ...modelsState.list,
      { id: 'extra', name: 'Extra', provider: 'openai' },
    ];
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
      expect(piMock.getSettings).not.toHaveBeenCalled();
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('草稿点选后组件重挂仍保持点选，不套回设置默认', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    const first = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    first.unmount();
    piMock.getSettings.mockClear();
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.getSettings).not.toHaveBeenCalled();
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('草稿点选后首发建会话，getState 仍是设置默认时保持点选并写回会话', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'anthropic/m' });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    fireEvent.click(await screen.findByText('GPT'));
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    piMock.setModel.mockClear();

    commitComposerModelToSession('/ws', '/ws/created.jsonl');
    sessionState.draftConversationCwd = null;
    sessionState.activeSessionPath = '/ws/created.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/created.jsonl',
    });
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    await waitFor(() => {
      expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g');
    });
    expect(piMock.setModel).not.toHaveBeenCalledWith('/ws', 'anthropic', 'm');
  });

  it('从草稿切回已有会话时恢复该会话模型，不套设置默认', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    piMock.setModel.mockClear();

    sessionState.draftConversationCwd = '/ws';
    sessionState.activeSessionPath = '';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(piMock.setModel).not.toHaveBeenCalled();

    piMock.getState.mockClear();
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    sessionState.draftConversationCwd = null;
    sessionState.activeSessionPath = '/ws/a.jsonl';
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'anthropic', id: 'm' });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('切回已有会话时 getState 变成设置默认，仍恢复该会话模型并写回', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    piMock.setModel.mockClear();

    sessionState.draftConversationCwd = '/ws';
    sessionState.activeSessionPath = '';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });

    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'g', provider: 'openai', api: 'openai-completions', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    sessionState.draftConversationCwd = null;
    sessionState.activeSessionPath = '/ws/a.jsonl';
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'anthropic', id: 'm' });
    await waitFor(() => {
      expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'anthropic', 'm');
    });
    expect(piMock.setModel).not.toHaveBeenCalledWith('/ws', 'openai', 'g');
  });

  it('已有会话 getState 无模型时不套用刚进草稿用过的设置默认', async () => {
    sessionState.draftConversationCwd = '/ws';
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    piMock.setModel.mockClear();

    sessionState.draftConversationCwd = null;
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: null,
      sessionFile: '/ws/a.jsonl',
    });
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });
    await waitFor(() => {
      expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'anthropic', 'm');
    });
    expect(piMock.setModel).not.toHaveBeenCalledWith('/ws', 'openai', 'g');
  });

  it('同工作区切换会话时输入栏跟随目标会话模型', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });

    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'g', provider: 'openai', api: 'openai-completions', reasoning: true },
      sessionFile: '/ws/b.jsonl',
    });
    sessionState.activeSessionPath = '/ws/b.jsonl';
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
  });

  it('切到其它会话但 getState 仍是原会话时，不把记忆模型写进正在执行的 handle', async () => {
    sessionState.activeSessionPath = '/ws/a.jsonl';
    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    const view = render(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('My Model');
    });

    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'g', provider: 'openai', api: 'openai-completions', reasoning: true },
      sessionFile: '/ws/b.jsonl',
    });
    sessionState.activeSessionPath = '/ws/b.jsonl';
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
    });
    piMock.setModel.mockClear();

    piMock.getState.mockResolvedValue({
      thinkingLevel: 'off',
      model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      sessionFile: '/ws/a.jsonl',
    });
    useThinkingMemoryStore.getState().bumpSwitch('/ws');
    view.rerender(<ModelThinkingAction />);
    await waitFor(() => {
      expect(screen.getByTestId('model-trigger').textContent).toContain('GPT');
      expect(peekComposerModel('/ws')).toEqual({ provider: 'openai', id: 'g' });
    });
    expect(piMock.setModel).not.toHaveBeenCalled();
  });
});
