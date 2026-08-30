import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listKnowledgeAssets, messagesRef } = vi.hoisted(() => ({
  listKnowledgeAssets: vi.fn(),
  messagesRef: { current: [] as unknown[] },
}));
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
vi.mock('../tencentdb/tencentdbApi', () => ({
  tencentdbApi: {
    listKnowledgeAssets,
    listWikiPages: vi.fn(),
    readWikiPages: vi.fn(),
    searchCodeGraph: vi.fn(),
    searchWiki: vi.fn(),
  },
  useTencentdbConnection: () => ({ status: { state: 'ready' } }),
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
  vi.clearAllMocks();
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

describe('DockPanel (right region)', { timeout: 30_000 }, () => {
  it('shows the empty hint when there is no content', () => {
    renderRight();
    expect(screen.getByText(/暂无内容/)).toBeTruthy();
  });

  it('renders project context as a normal right dock tab', async () => {
    listKnowledgeAssets.mockResolvedValue({ codeGraphs: [], wikis: [], workspace: {} });
    useDockStore.getState().openProjectContext('/repo');

    renderRight();

    expect(screen.getByTestId('dock-tab-project-context')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'repo 项目上下文' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a sub-agent tab on demand and shows its conversation', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'research X' }, result: {}, status: 'running' },
    ];
    useDockStore.getState().openSubAgent({ messageId: 't1', toolCallId: 'c1', subIndex: null, title: '#1 research X' });
    renderRight();
    expect(screen.getByTestId('dock-tab-t1')).toBeTruthy();
    expect(screen.getByTestId('subagent-c1').textContent).toContain('research X');
  });

  it('shows the per-unit task for an opened parallel sub-agent', () => {
    messagesRef.current = [
      {
        kind: 'tool',
        id: 'm',
        toolCallId: 'cm',
        toolName: 'spawn_agent',
        args: { tasks: ['task A', 'task B'] },
        result: { details: { mode: 'parallel', results: [{ task: 'task A', ok: true, output: 'a out' }, { task: 'task B', ok: true, output: 'b out' }] } },
        status: 'done',
      },
    ];
    useDockStore.getState().openSubAgent({ messageId: 'm', toolCallId: 'cm', subIndex: 1, title: '#2 task B' });
    renderRight();
    expect(screen.getByTestId('dock-tab-m#1')).toBeTruthy();
    expect(screen.getByTestId('subagent-cm').textContent).toContain('task B');
  });

  it('switches the active conversation when another tab is clicked', () => {
    messagesRef.current = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'spawn_agent', args: { task: 'first task' }, result: {}, status: 'done' },
      { kind: 'tool', id: 't2', toolCallId: 'c2', toolName: 'spawn_agent', args: { task: 'second task' }, result: {}, status: 'running' },
    ];
    const s = useDockStore.getState();
    s.openSubAgent({ messageId: 't1', toolCallId: 'c1', subIndex: null, title: '#1 first task' });
    s.openSubAgent({ messageId: 't2', toolCallId: 'c2', subIndex: null, title: '#2 second task' });
    renderRight();
    // 默认激活最新（t2）。
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('flex');
    fireEvent.click(screen.getByTestId('dock-tab-t1'));
    expect(screen.getByTestId('dock-body-t1').style.display).toBe('flex');
    expect(screen.getByTestId('dock-body-t2').style.display).toBe('none');
  });
});
