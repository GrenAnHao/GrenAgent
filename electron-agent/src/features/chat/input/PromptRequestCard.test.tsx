import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  respond.mockClear();
  useUiPromptStore.setState({ byWorkspace: {} });
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

  it('ignores generic selects now handled by the overlay', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1c', method: 'select', title: '选一个', options: ['红', '蓝'] },
    });
    const { container } = render(<PromptRequestCard />);
    expect(container.firstChild).toBeNull();
  });
});
