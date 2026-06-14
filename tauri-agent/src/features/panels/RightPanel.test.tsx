import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { messagesRef } = vi.hoisted(() => ({ messagesRef: { current: [] as unknown[] } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: (sel: (s: { messages: unknown[] }) => unknown) => sel({ messages: messagesRef.current }),
  }),
}));
// 用轻量替身渲染会话内容，聚焦验证 tab 行为（气泡组件自身另有覆盖）。
vi.mock('./SubAgentConversation', () => ({
  SubAgentConversation: ({
    task,
    result,
    status,
    'data-testid': testId,
  }: {
    task: string;
    result: { content?: { text?: string }[] } | null;
    status: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId}>
      <span>{task}</span>
      <span>{result?.content?.[0]?.text ?? ''}</span>
      <span>{status}</span>
    </div>
  ),
}));

import { RightPanel } from './RightPanel';
import { useRightPanelStore } from '../../stores/rightPanelStore';

afterEach(() => {
  cleanup();
  messagesRef.current = [];
  useRightPanelStore.setState({ pageTabs: [], activeId: null });
});

describe('RightPanel sub-agent tabs', () => {
  it('shows an empty hint when there is no content', () => {
    render(<RightPanel />);
    expect(screen.getByTestId('subagent-panel').textContent).toContain('暂无内容');
  });

  it('renders a tab per spawn_agent (ignoring other tools) and shows the active conversation', () => {
    messagesRef.current = [
      {
        kind: 'tool',
        id: 't1',
        toolCallId: 'c1',
        toolName: 'spawn_agent',
        args: { task: 'research X' },
        result: { content: [{ type: 'text', text: 'partial output' }] },
        status: 'running',
      },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'bash', args: {}, result: {}, status: 'done' },
    ];
    render(<RightPanel />);
    // 只有 spawn_agent 有 tab；bash 被忽略。
    expect(screen.getByTestId('subagent-tab-c1')).toBeTruthy();
    expect(screen.queryByTestId('subagent-tab-c2')).toBeNull();
    const conv = screen.getByTestId('subagent-c1');
    expect(conv.textContent).toContain('research X');
    expect(conv.textContent).toContain('partial output');
  });

  it('switches active conversation when another tab is clicked', () => {
    messagesRef.current = [
      {
        kind: 'tool',
        id: 't1',
        toolCallId: 'c1',
        toolName: 'spawn_agent',
        args: { task: 'first task' },
        result: { content: [{ type: 'text', text: 'out one' }] },
        status: 'done',
      },
      {
        kind: 'tool',
        id: 't2',
        toolCallId: 'c2',
        toolName: 'spawn_agent',
        args: { task: 'second task' },
        result: { content: [{ type: 'text', text: 'out two' }] },
        status: 'running',
      },
    ];
    render(<RightPanel />);
    // 默认选中最新（c2）。
    expect(screen.getByTestId('subagent-c2').textContent).toContain('second task');
    fireEvent.click(screen.getByTestId('subagent-tab-c1'));
    expect(screen.getByTestId('subagent-c1').textContent).toContain('first task');
  });
});
