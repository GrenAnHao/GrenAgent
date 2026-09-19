import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import type { DockTab, ReviewPayload } from '../../stores/dockStore';

const messages: ChatMessage[] = [
  { kind: 'assistant', id: 'turn-1', text: 'done', thinking: '', streaming: false },
  {
    kind: 'tool',
    id: 'w-a',
    toolCallId: 'w1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'hello-a' },
    result: { content: [] },
    status: 'done',
  },
  {
    kind: 'tool',
    id: 'w-b',
    toolCallId: 'w2',
    toolName: 'write',
    args: { path: 'b.txt', content: 'hello-b' },
    result: { content: [] },
    status: 'done',
  },
];

const { openPath, updateTab, messagesRef } = vi.hoisted(() => {
  const messagesRef = { current: [] as ChatMessage[] };
  function useStore(selector?: (s: { messages: ChatMessage[] }) => unknown) {
    const state = { messages: messagesRef.current };
    return selector ? selector(state) : state;
  }
  return {
    openPath: vi.fn(),
    updateTab: vi.fn(),
    messagesRef,
    useStore,
  };
});

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: 'D:/ws',
    store: { useStore: (selector?: (s: { messages: ChatMessage[] }) => unknown) => {
      const state = { messages: messagesRef.current };
      return selector ? selector(state) : state;
    } },
  }),
  useOptionalAgentStoreContext: () => ({
    workspace: 'D:/ws',
    store: { useStore: (selector?: (s: { messages: ChatMessage[] }) => unknown) => {
      const state = { messages: messagesRef.current };
      return selector ? selector(state) : state;
    } },
  }),
}));

vi.mock('../../platform/runtime', () => ({ openPath }));

vi.mock('../../stores/dockStore', () => ({
  useDockStore: {
    getState: () => ({ updateTab }),
  },
}));

import { TurnReviewBody } from './TurnReviewBody';

afterEach(() => {
  cleanup();
  updateTab.mockReset();
  openPath.mockReset();
  messagesRef.current = [];
});

function reviewTab(payload: ReviewPayload): DockTab {
  return {
    id: 'review:right',
    kind: 'review',
    region: 'right',
    title: '审查',
    closable: true,
    order: 0,
    payload,
  };
}

describe('TurnReviewBody', () => {
  it('shows empty copy when payload has no turnId', () => {
    messagesRef.current = messages;
    render(<TurnReviewBody tab={reviewTab({ workspace: 'D:/ws' })} active />);
    expect(screen.getByTestId('review-empty').textContent).toContain('从对话里的已编辑进来，查看本轮改动。');
  });

  it('lists files and switches the diff when the second row is clicked', () => {
    messagesRef.current = messages;
    const payload: ReviewPayload = { workspace: 'D:/ws', turnId: 'turn-1', fileIndex: 0 };
    const tab = reviewTab(payload);
    const view = render(<TurnReviewBody tab={tab} active />);

    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(screen.getByTestId('file-diff-block').textContent).toContain('hello-a');

    updateTab.mockImplementation((_id: string, patch: { payload?: ReviewPayload }) => {
      view.rerender(<TurnReviewBody tab={reviewTab({ ...payload, ...patch.payload })} active />);
    });

    fireEvent.click(screen.getByText('b.txt'));
    expect(updateTab).toHaveBeenCalledWith('review:right', {
      payload: { ...payload, fileIndex: 1 },
    });
    expect(screen.getByTestId('file-diff-block').textContent).toContain('hello-b');
  });

  it('shows missing copy when the turn is gone', () => {
    messagesRef.current = messages;
    render(<TurnReviewBody tab={reviewTab({ workspace: 'D:/ws', turnId: 'nope' })} active />);
    expect(screen.getByText('找不到这一轮')).toBeTruthy();
  });

  it('opens the selected workspace file', () => {
    messagesRef.current = messages;
    render(<TurnReviewBody tab={reviewTab({ workspace: 'D:/ws', turnId: 'turn-1', fileIndex: 0 })} active />);
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(openPath).toHaveBeenCalledWith('D:/ws/a.txt');
  });
});
