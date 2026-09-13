import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// 自定义选择器用 @lobehub/ui 的 Popover + Icon。mock 成直接渲染 children(触发器) + content(面板)，
// 这样面板里的搜索框 / 模型项 / 档位分段都能在测试里直接访问、点击。
vi.mock('@lobehub/ui', () => ({
  Icon: () => null,
  Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <div>
      {children}
      {content}
    </div>
  ),
}));

const { piMock } = vi.hoisted(() => ({
  piMock: {
    // 当前会话停在一个 anthropic 推理模型上：底部档位段应渲染出 off/low/medium/high。
    getState: vi.fn(() =>
      Promise.resolve({
        thinkingLevel: 'off',
        model: { id: 'm', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      }),
    ),
    setModel: vi.fn(() => Promise.resolve()),
    setThinkingLevel: vi.fn(() => Promise.resolve()),
  },
}));

const MODELS = [
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
vi.mock('../../../settings/availableModelsCache', () => ({
  useAvailableModelsState: () => ({ models: MODELS, loading: false }),
  loadAvailableModels: () => Promise.resolve(MODELS),
  getCachedAvailableModels: () => MODELS,
}));
vi.mock('../../../settings/providerListCache', () => ({
  loadProviderList: () =>
    Promise.resolve([
      { id: 'anthropic', name: 'Anthropic' },
      { id: 'openai', name: 'OpenAI' },
    ]),
}));

import ModelThinkingAction, { resetModelThinkingCacheForTests } from './ModelThinkingAction';

beforeEach(() => {
  vi.clearAllMocks();
  resetModelThinkingCacheForTests();
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
});
