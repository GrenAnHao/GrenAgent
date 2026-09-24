import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond, completeAskUser, writeAskUserDraft, deleteAskUserDraft, getState, mockMessages } = vi.hoisted(() => {
  const mockMessages: Array<{
    kind: string;
    id: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    status: string;
  }> = [];
  return {
    respond: vi.fn(() => Promise.resolve()),
    completeAskUser: vi.fn(() => Promise.resolve('ok' as const)),
    writeAskUserDraft: vi.fn(() => Promise.resolve()),
    deleteAskUserDraft: vi.fn(() => Promise.resolve()),
    getState: vi.fn(() => Promise.resolve({ sessionFile: '/tmp/live.jsonl' })),
    mockMessages,
  };
});
vi.mock('../../lib/pi', () => ({
  extensionUiRespond: respond,
  completeAskUser,
  writeAskUserDraft,
  deleteAskUserDraft,
  pi: { getState },
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/ws',
    store: {
      useStore: (selector: (s: { messages: typeof mockMessages }) => unknown) =>
        selector({ messages: mockMessages }),
    },
  }),
}));

import { InlineQuestionCard } from './InlineQuestionCard';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

afterEach(() => {
  cleanup();
  respond.mockClear();
  completeAskUser.mockClear();
  writeAskUserDraft.mockClear();
  deleteAskUserDraft.mockClear();
  getState.mockReset().mockResolvedValue({ sessionFile: '/tmp/live.jsonl' });
  mockMessages.length = 0;
  useInlineQuestionStore.setState({ byWorkspace: {} });
});

const data = {
  kind: 'questions' as const,
  id: 'q1',
  questions: [
    { id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
  ],
};

describe('InlineQuestionCard', () => {
  it('renders nothing without a request', () => {
    const { container } = render(<InlineQuestionCard />);
    expect(container.firstChild).toBeNull();
  });

  it('submits formatted answer and clears', async () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data, mode: 'live' });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('乙'));
    fireEvent.click(screen.getByTestId('inline-question-continue'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', value: '[我的选择]\n1. T：乙' });
    await waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
    });
  });

  it('includes extra note in the submitted value', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u3',
      data: { ...data, allowExtra: true },
      mode: 'live',
    });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('乙'));
    fireEvent.change(screen.getByTestId('inline-question-extra-text'), { target: { value: '你能看到图片吗' } });
    fireEvent.click(screen.getByTestId('inline-question-continue'));
    expect(respond).toHaveBeenCalledWith('/ws', {
      type: 'extension_ui_response',
      id: 'u3',
      value: '[我的选择]\n1. T：乙\n补充说明：你能看到图片吗',
    });
    await waitFor(() => {
      expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
    });
  });

  it('fills restored draft and completes the tool call on continue', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'q1',
      mode: 'restored',
      toolCallId: 'q1',
      sessionPath: '/tmp/s.jsonl',
      draft: { toolCallId: 'q1', selected: { q1: ['a'] }, customTexts: {}, extraText: '', extraImages: [] },
      data,
    });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByTestId('inline-question-continue'));
    expect(completeAskUser).toHaveBeenCalledWith('/ws', 'q1', '[我的选择]\n1. T：甲', undefined);
    expect(respond).not.toHaveBeenCalled();
  });

  it('writes a live draft using running ask_user and getState sessionFile', async () => {
    mockMessages.push({
      kind: 'tool',
      id: 'tool-1',
      toolCallId: 'tc-live',
      toolName: 'ask_user',
      args: {},
      result: null,
      status: 'running',
    });
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u-live', data, mode: 'live' });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('甲'));
    await waitFor(() => {
      expect(writeAskUserDraft).toHaveBeenCalledWith(
        '/ws',
        expect.objectContaining({
          toolCallId: 'tc-live',
          selected: { q1: ['a'] },
        }),
      );
    });
    expect(getState).toHaveBeenCalledWith('/ws');
  });

  it('does not overwrite a restored draft with empty selection on mount', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'q1',
      mode: 'restored',
      toolCallId: 'q1',
      sessionPath: '/tmp/s.jsonl',
      draft: { toolCallId: 'q1', selected: { q1: ['a'] }, customTexts: {}, extraText: '', extraImages: [] },
      data,
    });
    render(<InlineQuestionCard />);
    await waitFor(() => {
      const calls = writeAskUserDraft.mock.calls as Array<[string, { selected: Record<string, string[]> }]>;
      expect(calls.every(([, d]) => Boolean(d.selected?.q1?.includes('a')))).toBe(true);
      if (calls.length > 0) {
        const last = calls[calls.length - 1]![1];
        expect(last.selected?.q1).toEqual(['a']);
      }
    });
  });

  it('retries getState for a new live request after a null sessionFile', async () => {
    getState.mockResolvedValue({ sessionFile: null });
    mockMessages.push({
      kind: 'tool',
      id: 'tool-1',
      toolCallId: 'tc-1',
      toolName: 'ask_user',
      args: {},
      result: null,
      status: 'running',
    });
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'live-1', data, mode: 'live' });
    const { rerender } = render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('甲'));
    await waitFor(() => {
      expect(getState).toHaveBeenCalled();
    });
    expect(writeAskUserDraft).not.toHaveBeenCalled();

    writeAskUserDraft.mockClear();
    getState.mockClear();
    getState.mockResolvedValue({ sessionFile: '/tmp/second.jsonl' });
    mockMessages.length = 0;
    mockMessages.push({
      kind: 'tool',
      id: 'tool-2',
      toolCallId: 'tc-2',
      toolName: 'ask_user',
      args: {},
      result: null,
      status: 'running',
    });
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'live-2', data, mode: 'live' });
    rerender(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('乙'));
    await waitFor(() => {
      expect(writeAskUserDraft).toHaveBeenCalledWith(
        '/ws',
        expect.objectContaining({
          toolCallId: 'tc-2',
          selected: { q1: ['b'] },
        }),
      );
    });
    expect(getState).toHaveBeenCalledWith('/ws');
  });
});
