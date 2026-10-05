import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSubAgentLiveStore } from '../../stores/subagentLiveStore';

const { messages } = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({
    workspace: '/repo',
    store: { useStore: { getState: () => ({ messages }) } },
  }),
}));

vi.mock('../../lib/pi', () => ({
  pi: { subagentList: vi.fn().mockResolvedValue([]), subagentCancel: vi.fn() },
}));

import { SubAgentMenuButton } from './SubAgentMenuButton';

const item = { id: 'sa-1', task: '审查改动', status: 'done', createdAt: 1, updatedAt: Date.now() };

beforeEach(() => {
  messages.length = 0;
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, rightPanelFill: false, availableWidth: 0 });
  useSubAgentLiveStore.setState({ itemsByWorkspace: new Map([['/repo', [item]]]) });
  useSubAgentLiveStore.setState({ startPolling: () => () => {} });
});

afterEach(() => {
  cleanup();
});

async function clickCard() {
  render(<SubAgentMenuButton />);
  fireEvent.click(screen.getByTestId('subagent-menu-button'));
  fireEvent.click(await screen.findByTestId('subagent-card-sa-1'));
}

describe('SubAgentMenuButton', () => {
  it('主对话里有对应 spawn_agent：创建并激活子代理 tab，而不是只展开右面板', async () => {
    messages.push({
      kind: 'tool',
      id: 'msg-1',
      toolCallId: 'call-1',
      toolName: 'spawn_agent',
      args: { task: '审查改动' },
      result: { details: { agentId: 'sa-1' } },
      status: 'done',
    });
    await clickCard();
    const tab = useDockStore.getState().tabs.find((t) => t.id === 'msg-1');
    expect(tab?.kind).toBe('subagent');
    expect(useDockStore.getState().activeByRegion.right).toBe('msg-1');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('并行子代理按 details.results 里的 agentId 打开对应子项', async () => {
    messages.push({
      kind: 'tool',
      id: 'msg-2',
      toolCallId: 'call-2',
      toolName: 'spawn_agent',
      args: { tasks: ['a', '审查改动'] },
      result: { details: { results: [{ agentId: 'sa-0' }, { agentId: 'sa-1' }] } },
      status: 'done',
    });
    await clickCard();
    expect(useDockStore.getState().activeByRegion.right).toBe('msg-2#1');
    expect(useDockStore.getState().tabs.some((t) => t.id === 'msg-2#1')).toBe(true);
  });

  it('卡片显示 spawn 参数里的 title，而不是 registry 里的长任务', async () => {
    messages.push({
      kind: 'tool',
      id: 'msg-1',
      toolCallId: 'call-1',
      toolName: 'spawn_agent',
      args: { title: '审改动', task: '你是代码审查代理。请完整审查这次改动，审完再回复。' },
      result: { details: { agentId: 'sa-1' } },
      status: 'done',
    });
    render(<SubAgentMenuButton />);
    fireEvent.click(screen.getByTestId('subagent-menu-button'));
    expect(await screen.findByText('审改动')).toBeTruthy();
  });

  it('主对话里找不到：退回 registry 日志 tab', async () => {
    await clickCard();
    expect(useDockStore.getState().activeByRegion.right).toBe('salog:sa-1');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });
});
