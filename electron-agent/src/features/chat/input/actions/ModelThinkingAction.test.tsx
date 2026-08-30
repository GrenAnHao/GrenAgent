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
  { id: 'g', name: 'GPT', provider: 'openai' },
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

import ModelThinkingAction from './ModelThinkingAction';

beforeEach(() => {
  vi.clearAllMocks();
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
    fireEvent.click(await screen.findByText('high'));
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
});
