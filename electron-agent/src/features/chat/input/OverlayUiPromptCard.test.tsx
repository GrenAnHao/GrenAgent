import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond, messages } = vi.hoisted(() => ({
  respond: vi.fn(() => Promise.resolve()),
  messages: [] as Array<{ kind: string; customType?: string; content?: string }>,
}));

vi.mock('../../../lib/pi', () => ({ extensionUiRespond: respond, pi: { resolvePermission: vi.fn() } }));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useAgentStore: () => ({
    useStore: {
      setState: (fn: (s: { messages: typeof messages }) => { messages: typeof messages }) => {
        const next = fn({ messages });
        messages.splice(0, messages.length, ...next.messages);
      },
    },
  }),
}));

import { OverlayUiPromptCard } from './OverlayUiPromptCard';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

afterEach(() => {
  cleanup();
  respond.mockClear();
  messages.splice(0, messages.length);
  useUiPromptStore.setState({ byWorkspace: {}, waiting: {} });
});

function receiptOutcome(index = 0): string | undefined {
  const raw = messages[index]?.content;
  if (!raw) return undefined;
  return (JSON.parse(raw) as { outcome?: string }).outcome;
}

describe('OverlayUiPromptCard', () => {
  it('keeps generic selects on QuestionSelector', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u1c', method: 'select', title: '选一个', options: ['红', '蓝'] },
    });
    render(<OverlayUiPromptCard />);
    expect(screen.getByTestId('prompt-request-select')).toBeTruthy();
    expect(screen.getByText('请选择')).toBeTruthy();
    expect(screen.queryByTestId('prompt-request-approval')).toBeNull();
  });

  it('responds to confirm with { confirmed: true }', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u2', method: 'confirm', title: '项目信任', message: '信任此工作区？' },
    });
    render(<OverlayUiPromptCard />);
    expect(screen.getByText('信任此工作区？')).toBeTruthy();
    fireEvent.click(screen.getByTestId('prompt-request-confirm'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u2', confirmed: true });
  });

  it('says how many requests wait behind it (e.g. subagent approvals counting down)', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'q1', method: 'confirm', title: '确认', message: '继续？' },
    });
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'c1', method: 'select', options: ['允许本次', '拒绝'], timeout: 60_000, subagents: [{ agentId: 'sa-1', label: 'x' }] },
    });
    render(<OverlayUiPromptCard />);
    expect(screen.getByTestId('prompt-request-waiting').textContent).toBe('还有 1 条待处理');
  });

  it('responds to input with { value } from the textarea', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u3', method: 'input', title: '输入名称', placeholder: 'name' },
    });
    render(<OverlayUiPromptCard />);
    fireEvent.change(screen.getByTestId('prompt-request-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('prompt-request-submit'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u3', value: 'hello' });
  });

  it('dismisses a select request with { cancelled: true }', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u4', method: 'select', title: '选一个', options: ['A', 'B'] },
    });
    render(<OverlayUiPromptCard />);
    fireEvent.click(screen.getByTestId('prompt-request-select-skip'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u4', cancelled: true });
  });

  it('appends a receipt notice on confirm and on cancel', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u2', method: 'confirm', title: '项目信任', message: '信任此工作区？' },
    });
    const { unmount } = render(<OverlayUiPromptCard />);
    fireEvent.click(screen.getByTestId('prompt-request-confirm'));
    expect(messages[0]?.customType).toBe('ui-prompt-receipt');
    expect(receiptOutcome(0)).toBe('confirmed');
    unmount();

    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'u4', method: 'select', title: '选一个', options: ['A', 'B'] },
    });
    render(<OverlayUiPromptCard />);
    fireEvent.click(screen.getByTestId('prompt-request-select-skip'));
    expect(messages[1]?.customType).toBe('ui-prompt-receipt');
    expect(receiptOutcome(1)).toBe('cancelled');
  });
});
