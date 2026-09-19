import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()) }));
vi.mock('../../lib/pi', () => ({ extensionUiRespond: respond }));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));

import { InlineQuestionCard } from './InlineQuestionCard';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

afterEach(() => {
  cleanup();
  respond.mockClear();
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

  it('submits formatted answer and clears', () => {
    useInlineQuestionStore.getState().setRequest({ workspace: '/ws', id: 'u1', data });
    render(<InlineQuestionCard />);
    fireEvent.click(screen.getByText('乙'));
    fireEvent.click(screen.getByTestId('inline-question-continue'));
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', value: '[我的选择]\n1. T：乙' });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

    it('includes extra note in the submitted value', () => {
      useInlineQuestionStore.getState().setRequest({
        workspace: '/ws',
        id: 'u3',
        data: { ...data, allowExtra: true },
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
    });
  });
