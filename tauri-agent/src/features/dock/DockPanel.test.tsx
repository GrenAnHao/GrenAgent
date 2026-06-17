import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { messagesRef } = vi.hoisted(() => ({ messagesRef: { current: [] as unknown[] } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: (sel: (s: { messages: unknown[] }) => unknown) => sel({ messages: messagesRef.current }),
  }),
}));
vi.mock('../panels/SubAgentConversation', () => ({
  SubAgentConversation: ({
    task,
    status,
    'data-testid': testId,
  }: {
    task: string;
    result: unknown;
    status: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId}>
      <span>{task}</span>
      <span>{status}</span>
    </div>
  ),
}));

import { DockPanel } from './DockPanel';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

afterEach(() => {
  cleanup();
  messagesRef.current = [];
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false });
});

function renderRight() {
  // 子代理会话仅在右侧面板打开时渲染（dock body keep-alive，折叠时不解析 transcript）。
  useLayoutStore.setState({ rightPanelOpen: true });
  return render(
    <DndContext>
      <DockPanel region="right" />
    </DndContext>,
  );
}

describe('DockPanel (right region)', () => {
  it('shows the empty hint when there is no content', () => {
    renderRight();
    expect(screen.getByText(/暂无内容/)).toBeTruthy();
  });

  it('renders one tab per spawn_agent (ignoring other tools) and shows the active conversation', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'research X' }, result: {}, status: 'running' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'bash', args: {}, result: {}, status: 'done' },
    ];
    renderRight();
    expect(screen.getByTestId('dock-tab-t1')).toBeTruthy();
    expect(screen.queryByTestId('dock-tab-t2')).toBeNull();
    expect(screen.getByTestId('subagent-c1').textContent).toContain('research X');
  });

  it('switches the active conversation when another tab is clicked', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'first task' }, result: {}, status: 'done' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'spawn_agent', args: { task: 'second task' }, result: {}, status: 'running' },
    ];
    renderRight();
    // 默认激活最新（t2）。
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('flex');
    fireEvent.click(screen.getByTestId('dock-tab-t1'));
    expect(screen.getByTestId('dock-body-t1').style.display).toBe('flex');
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('none');
  });
});
