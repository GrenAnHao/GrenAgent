import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond, completeAskUser, writeAskUserDraft, deleteAskUserDraft } = vi.hoisted(() => ({
  respond: vi.fn(() => Promise.resolve()),
  completeAskUser: vi.fn(() => Promise.resolve('ok' as const)),
  writeAskUserDraft: vi.fn(() => Promise.resolve()),
  deleteAskUserDraft: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({ extensionUiRespond: respond, completeAskUser, writeAskUserDraft, deleteAskUserDraft }));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));

import { InlineQuestionCard } from './InlineQuestionCard';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

afterEach(() => {
  cleanup();
  respond.mockClear();
  completeAskUser.mockClear();
  writeAskUserDraft.mockClear();
  deleteAskUserDraft.mockClear();
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
});
