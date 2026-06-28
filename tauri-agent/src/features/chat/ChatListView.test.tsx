import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import type { ChatMessage } from '../../stores/agentReducer';

// virtua 在 jsdom 无真实测高 → VList 首屏渲染 0 条，内容/footer 进不了 DOM。
// mock 成直通容器（带假 handle 防 scrollToIndex 崩），以验证渲染管线与「准备响应中」footer。
vi.mock('virtua', async () => {
  const React = await import('react');
  return {
    VList: React.forwardRef(function MockVList({ children, ...props }: any, ref: any) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: () => {},
        scrollOffset: 0,
        viewportSize: 0,
        scrollSize: 0,
      }));
      return React.createElement('div', props, children);
    }),
  };
});

// AgentStoreContext mock：直通假 useAgentStore（zustand-like 选择器）。excluded 供气泡上下文控制动作订阅。
const mockState: { messages: ChatMessage[]; isStreaming: boolean; excluded: Set<number> } = {
  messages: [],
  isStreaming: false,
  excluded: new Set(),
};
vi.mock('../../stores/AgentStoreContext', () => {
  const store = { useStore: (selector: any) => selector(mockState) };
  return {
    useAgentStore: () => store,
    useAgentStoreContext: () => ({ workspace: '/test', store }),
    useOptionalAgentStoreContext: () => ({ workspace: '/test', store }),
    AgentStoreProvider: ({ children }: any) => <>{children}</>,
  };
});

import { ChatListView } from './ChatListView';

afterEach(() => {
  cleanup();
  mockState.messages = [];
  mockState.isStreaming = false;
  mockState.excluded = new Set();
});

function setMessages(msgs: ChatMessage[]) {
  mockState.messages = msgs;
}

function makeFixture(): ChatMessage[] {
  return [
    { kind: 'user', id: 'u1', text: 'hi' } as ChatMessage,
    {
      kind: 'assistant',
      id: 'a1',
      text: 'ok',
      thinking: '',
      streaming: false,
    } as ChatMessage,
    {
      kind: 'tool',
      id: 't1',
      toolCallId: 'tc1',
      toolName: 'grep',
      args: {},
      result: {},
      status: 'done',
    } as ChatMessage,
    { kind: 'notice', id: 'n1', customType: 'knowledge-rag', content: '已注入 3 条' } as ChatMessage,
  ];
}

describe('ChatListView', { timeout: 30_000 }, () => {
  it('渲染自研滚动容器（无 lobe ChatList 包装）', () => {
    setMessages(makeFixture());
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );

    const scroll = document.querySelector('[data-testid="chat-scroll"]');
    expect(scroll).not.toBeNull();
    // 渲染管线连通：用户气泡文本出现在容器内。
    expect(scroll!.textContent).toContain('hi');
  });

  it('messages 为空时仍渲染滚动容器', () => {
    setMessages([]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(document.querySelector('[data-testid="chat-scroll"]')).not.toBeNull();
  });

  it('streaming 且助手尚无内容时显示「准备响应中…」加载态', () => {
    mockState.isStreaming = true;
    setMessages([{ kind: 'user', id: 'u1', text: 'hi' } as ChatMessage]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(screen.getByText('准备响应中…')).toBeTruthy();
  });

  it('助手已有正文时不显示加载态', () => {
    mockState.isStreaming = true;
    setMessages([
      { kind: 'user', id: 'u1', text: 'hi' } as ChatMessage,
      { kind: 'assistant', id: 'a1', text: '回答中', thinking: '', streaming: true } as ChatMessage,
    ]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(screen.queryByText('准备响应中…')).toBeNull();
  });
});
