import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ workspaceReady: true, messageCount: 0 }));

vi.mock('../../lib/pi', () => ({ pi: {} }));
vi.mock('../../lib/commandLanes', () => ({ commandLanes: { run: vi.fn() } }));
vi.mock('../../lib/streamingGate', () => ({ awaitStreamingEnd: vi.fn() }));
vi.mock('../../lib/sidebarSessionSync', () => ({ syncSidebarOnSend: vi.fn() }));
vi.mock('./ChatListView', () => ({ ChatListView: () => <div data-testid="chat-list" /> }));
vi.mock('./ChatListSkeleton', () => ({ ChatListSkeleton: () => <div data-testid="chat-skeleton" /> }));
vi.mock('./ChatInput', () => ({ ChatInput: () => <div data-testid="chat-input" /> }));
vi.mock('./EmptyChatPrompt', () => ({
  EmptyChatPrompt: () => <div data-testid="empty-chat-prompt" />,
}));
vi.mock('../../store/session', () => ({
  useSessionStore: (sel: (s: { worksDir: string }) => unknown) => sel({ worksDir: '/home/.pi/agent/works' }),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/home/.pi/agent/works/u1',
    store: {
      useStore: (sel?: (s: { messages: unknown[] }) => unknown) =>
        sel ? sel({ messages: Array(state.messageCount).fill({}) }) : { messages: [] },
      pushUserMessage: vi.fn(),
    },
    setWorkspaceReady: () => {},
    appBooted: true,
    workspaceReady: state.workspaceReady,
  }),
}));

import { ChatView } from './ChatView';

afterEach(cleanup);

describe('ChatView 内容区 gating（骨架屏替代全屏）', () => {
  it('未就绪：内容区显示骨架屏，不显示消息列表', () => {
    state.workspaceReady = false;
    state.messageCount = 0;
    render(<ChatView />);
    expect(screen.getByTestId('chat-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('chat-list')).toBeNull();
  });

  it('已就绪：显示消息列表，不显示骨架屏', () => {
    state.workspaceReady = true;
    state.messageCount = 1;
    render(<ChatView />);
    expect(screen.getByTestId('chat-list')).toBeTruthy();
    expect(screen.queryByTestId('chat-skeleton')).toBeNull();
  });

  it('空对话：居中占位 + 输入区，不渲染消息列表', () => {
    state.workspaceReady = true;
    state.messageCount = 0;
    render(<ChatView />);
    expect(screen.getByTestId('empty-chat-prompt')).toBeTruthy();
    expect(screen.getByTestId('chat-input')).toBeTruthy();
    expect(screen.queryByTestId('chat-list')).toBeNull();
  });
});
