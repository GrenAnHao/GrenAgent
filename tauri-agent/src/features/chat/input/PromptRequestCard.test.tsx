import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../lib/pi', () => ({ extensionUiRespond: respond }));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

import { PromptRequestCard } from './PromptRequestCard';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

afterEach(() => {
  cleanup();
  respond.mockClear();
  useUiPromptStore.setState({ byWorkspace: {} });
});

describe('PromptRequestCard', () => {
  it('renders nothing without a pending request', () => {
    const { container } = render(<PromptRequestCard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders approval actions as one-click buttons, not a 请选择 quiz', async () => {
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
    await waitFor(() => expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeUndefined());
  });

  it('submits 总是允许 immediately for the three-way approval card', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1b', method: 'select', title: '请求批准：bash', options: ['允许本次', '总是允许', '拒绝'] },
    });
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByTestId('prompt-request-approval-allow-always'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1b', value: '总是允许' });
    await waitFor(() => expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeUndefined());
  });

  it('keeps generic selects on QuestionSelector', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1c', method: 'select', title: '选一个', options: ['红', '蓝'] },
    });
    render(<PromptRequestCard />);
    expect(screen.getByTestId('prompt-request-select')).toBeTruthy();
    expect(screen.getByText('请选择')).toBeTruthy();
    expect(screen.queryByTestId('prompt-request-approval')).toBeNull();
  });

  it('responds to confirm with { confirmed: true }', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u2', method: 'confirm', title: '项目信任', message: '信任此工作区？' },
    });
    render(<PromptRequestCard />);
    expect(screen.getByText('信任此工作区？')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prompt-request-confirm'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u2', confirmed: true });
    await waitFor(() => expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeUndefined());
  });

  it('keeps the confirm request visible and reports a response failure', async () => {
    respond.mockRejectedValueOnce(new Error('sidecar unavailable'));
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u5', method: 'confirm', title: '确认添加 MCP', message: '继续？' },
    });
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByTestId('prompt-request-confirm'));
    expect(await screen.findByText('提交失败：sidecar unavailable')).toBeTruthy();
    expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeDefined();
  });

  it('responds to input with { value } from the textarea', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u3', method: 'input', title: '输入名称', placeholder: 'name' },
    });
    render(<PromptRequestCard />);
    fireEvent.change(screen.getByTestId('prompt-request-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('prompt-request-submit'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u3', value: 'hello' });
  });

  it('dismisses a select request with { cancelled: true }', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u4', method: 'select', title: '选一个', options: ['A', 'B'] },
    });
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByTestId('prompt-request-select-skip'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u4', cancelled: true });
  });
});
