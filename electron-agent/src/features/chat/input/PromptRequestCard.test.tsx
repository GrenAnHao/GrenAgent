import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../lib/pi', () => ({ extensionUiRespond: respond, pi: { resolvePermission: vi.fn() } }));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

import { isApprovalSelect, PromptRequestCard } from './PromptRequestCard';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  respond.mockClear();
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
});

describe('isApprovalSelect', () => {
  it('accepts known approval option sets', () => {
    expect(isApprovalSelect(['允许', '拒绝'])).toBe(true);
    expect(isApprovalSelect(['允许本次', '总是允许', '拒绝'])).toBe(true);
  });

  it('rejects ordinary questions', () => {
    expect(isApprovalSelect(['A', 'B'])).toBe(false);
    expect(isApprovalSelect(['允许', '稍后再说'])).toBe(false);
    expect(isApprovalSelect([])).toBe(false);
    expect(isApprovalSelect(undefined)).toBe(false);
  });
});

describe('PromptRequestCard', () => {
  it('renders nothing without a pending request', () => {
    const { container } = render(<PromptRequestCard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders approval actions as one-click buttons, not a 请选择 quiz', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1', method: 'select', title: '危险命令：rm -rf ./tmp', options: ['允许', '拒绝'] },
    });
    render(<PromptRequestCard />);
    expect(screen.getByTestId('prompt-request-approval')).toBeTruthy();
    expect(screen.getByText('需要批准')).toBeTruthy();
    expect(screen.queryByText('请选择')).toBeNull();
    expect(screen.queryByTestId('prompt-request-select-continue')).toBeNull();
    fireEvent.click(screen.getByTestId('prompt-request-approval-deny'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', value: '拒绝' });
    expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('submits 总是允许 immediately for the three-way approval card', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1b', method: 'select', title: '请求批准：bash', options: ['允许本次', '总是允许', '拒绝'] },
    });
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByTestId('prompt-request-approval-allow-always'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1b', value: '总是允许' });
  });

  it('marks a subagent request, counts down from when it arrived, and shows how many are waiting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const subagents = [{ agentId: 'sa-1', label: 'run tests' }];
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: {
        id: 'c1',
        method: 'select',
        title: '子代理 run tests（sa-1） 请求批准：\n\n  npm test',
        options: ['允许本次', '总是允许', '拒绝'],
        timeout: 60_000,
        subagents,
      },
    });
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'c2', method: 'select', title: '第二条', options: ['允许本次', '拒绝'], timeout: 60_000, subagents },
    });
    render(<PromptRequestCard />);
    expect(screen.getByText('子代理请求批准')).toBeTruthy();
    expect(screen.getByTestId('prompt-request-countdown').textContent).toBe('60 秒后视为拒绝');
    expect(screen.getByTestId('prompt-request-waiting').textContent).toBe('还有 1 条');

    act(() => {
      vi.advanceTimersByTime(51_000);
    });
    expect(screen.getByTestId('prompt-request-countdown').textContent).toBe('9 秒后视为拒绝');

    fireEvent.click(screen.getByTestId('prompt-request-approval-allow-once'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'c1', value: '允许本次' });
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('c2');
    expect(screen.queryByTestId('prompt-request-waiting')).toBeNull();
  });

  it('a double click does not answer the next card that moves into the same place', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const ask = (id: string) =>
      useUiPromptStore.getState().setRequest({
        workspace: '/ws',
        request: { id, method: 'select', title: id, options: ['允许本次', '总是允许', '拒绝'], timeout: 60_000 },
      });
    ask('a');
    ask('b');
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByTestId('prompt-request-approval-allow-always'));
    fireEvent.click(screen.getByTestId('prompt-request-approval-allow-always'));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'a', value: '总是允许' });
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('b');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(screen.getByTestId('prompt-request-approval-deny'));
    expect(respond).toHaveBeenLastCalledWith('/ws', { type: 'extension_ui_response', id: 'b', value: '拒绝' });
  });

  it('a request without timeout has no countdown', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'm1', method: 'select', title: '请求批准：bash', options: ['允许本次', '拒绝'] },
    });
    render(<PromptRequestCard />);
    expect(screen.getByText('需要批准')).toBeTruthy();
    expect(screen.queryByTestId('prompt-request-countdown')).toBeNull();
  });

  it('ignores generic selects now handled by the overlay', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1c', method: 'select', title: '选一个', options: ['红', '蓝'] },
    });
    const { container } = render(<PromptRequestCard />);
    expect(container.firstChild).toBeNull();
  });
});
