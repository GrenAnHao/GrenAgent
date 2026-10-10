import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import type { DockTab } from '../../stores/dockStore';
import type { SubAgentItem } from '../../lib/pi';

const { parent } = vi.hoisted(() => ({ parent: { messages: [] as ChatMessage[] } }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({ useStore: (select: (state: typeof parent) => unknown) => select(parent) }),
  useOptionalAgentStoreContext: () => ({ workspace: '/workspace' }),
}));
vi.mock('../../stores/layoutStore', () => ({
  selectRightPanelVisible: () => true,
  useLayoutStore: () => true,
}));
vi.mock('../panels/SubAgentConversation', () => ({
  SubAgentConversation: ({ status, sessionPath }: { status: string; sessionPath?: string | null }) => <div data-testid="child-status" data-session-path={sessionPath ?? ''}>{status}</div>,
}));

import { SubAgentBody } from './SubAgentBody';
import { useSubAgentLiveStore } from '../../stores/subagentLiveStore';

const tab: DockTab = {
  id: 'child-tab', kind: 'subagent', region: 'right', title: '子代理', closable: true, order: 0,
  payload: { messageId: 'spawn-message', toolCallId: 'spawn-call' },
};

function backgroundSpawn(): ChatMessage {
  return {
    kind: 'tool', id: 'spawn-message', toolName: 'spawn_agent', toolCallId: 'spawn-call',
    args: { task: '检查模块' }, status: 'done',
    result: {
      content: [{ type: 'text', text: 'Background sub-agent started.\nAgent: sa-live' }],
      details: { agentId: 'sa-live', status: 'running' },
    },
  };
}

function registry(status: string, error: string | null = null) {
  const row: SubAgentItem = {
    id: 'sa-live', task: '检查模块', status, model: null, thinkingLevel: null,
    sessionPath: '/sessions/child.jsonl', profile: null, output: null, error, exitCode: null,
    transcript: null, createdAt: 1, updatedAt: 2,
  };
  useSubAgentLiveStore.setState({ itemsByWorkspace: new Map([['/workspace', [row]]]) });
}

beforeEach(() => {
  parent.messages = [backgroundSpawn()];
  useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() });
});
afterEach(() => {
  cleanup();
  useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() });
});

describe('SubAgentBody 后台子代理真实运行态', () => {
  it('父 spawn 工具已返回，登记表尚未加载时仍按正在运行打开详情', () => {
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('running');
  });

  it('父工具 done、登记表 running 时详情保持流式状态', () => {
    registry('running');
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('running');
  });

  it('父后台回执没有 sessionPath 时，由登记表把路径传给详情', () => {
    registry('running');
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').getAttribute('data-session-path')).toBe('/sessions/child.jsonl');
  });

  it('登记表完成后收流，轮询释放并清空登记表也不会重新变成 running', () => {
    registry('running');
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('running');
    act(() => registry('done'));
    expect(screen.getByTestId('child-status').textContent).toBe('done');
    act(() => useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() }));
    expect(screen.getByTestId('child-status').textContent).toBe('done');
    expect(screen.getByTestId('child-status').getAttribute('data-session-path')).toBe('/sessions/child.jsonl');
  });

  it('完成后隐藏再重新激活标签仍沿用该子代理的会话路径', () => {
    registry('done');
    const { rerender } = render(<SubAgentBody tab={tab} active />);
    rerender(<SubAgentBody tab={tab} active={false} />);
    act(() => useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() }));
    rerender(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('done');
    expect(screen.getByTestId('child-status').getAttribute('data-session-path')).toBe('/sessions/child.jsonl');
  });

  it('切到另一个 agentId 后不沿用前一个子代理的路径', () => {
    registry('done');
    const { rerender } = render(<SubAgentBody tab={tab} active />);
    act(() => useSubAgentLiveStore.setState({ itemsByWorkspace: new Map() }));
    const spawn = backgroundSpawn();
    parent.messages = [{ ...spawn, result: { details: { agentId: 'sa-other', status: 'running' } } } as ChatMessage];
    rerender(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('running');
    expect(screen.getByTestId('child-status').getAttribute('data-session-path')).toBe('');
  });

  it.each(['error', 'cancelled'])('登记表 %s 时详情按失败收流', (status) => {
    registry(status);
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('error');
  });

  it('重启打断的后台子代理不当成正常完成', () => {
    registry('done', 'sidecar restarted');
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('error');
  });

  it('前台工具尚未返回时保持 running', () => {
    const spawn = backgroundSpawn();
    parent.messages = [{ ...spawn, status: 'running' } as ChatMessage];
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('running');
  });

  it('已有最终结果时沿用结果终态，不被旧登记表的 running 覆盖', () => {
    registry('running');
    const spawn = backgroundSpawn();
    parent.messages = [{ ...spawn, result: { content: [{ type: 'text', text: '检查完成' }], details: { agentId: 'sa-live', status: 'done' } } } as ChatMessage];
    render(<SubAgentBody tab={tab} active />);
    expect(screen.getByTestId('child-status').textContent).toBe('done');
  });
});
