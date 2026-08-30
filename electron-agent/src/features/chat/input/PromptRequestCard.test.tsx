import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('responds to a select choice with { value } and clears the store', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1', method: 'select', title: '允许？', options: ['允许', '拒绝'] },
    });
    render(<PromptRequestCard />);
    fireEvent.click(screen.getByText('拒绝'));
    fireEvent.click(screen.getByTestId('prompt-request-select-continue'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', value: '拒绝' });
    expect(useUiPromptStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('responds to confirm with { confirmed: true }', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u2', method: 'confirm', title: '项目信任', message: '信任此工作区？' },
    });
    render(<PromptRequestCard />);
    expect(screen.getByText('信任此工作区？')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prompt-request-confirm'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u2', confirmed: true });
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
