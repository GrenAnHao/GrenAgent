import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChildOverlayStore } from '../../stores/childOverlayStore';
import { useSessionStore } from '../../store/session';

vi.mock('../chat/ChatView', () => ({
  ChatView: () => <div data-testid="parent-chat-view" />,
}));

vi.mock('../workspace/WorkspaceTabs', () => ({
  WorkspaceTabs: () => null,
}));

vi.mock('../subagents/SubAgentMenuButton', () => ({
  SubAgentMenuButton: () => null,
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    subagentPrompt: vi.fn(),
    subagentInterrupt: vi.fn(),
    subagentCatalogRow: vi.fn(),
    subagentGetSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
  },
  onPiEvent: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('../panels/useChildSessionBinding', () => ({
  useChildSessionBinding: () => [],
}));

vi.mock('../chat/ChatMessageItems', () => ({
  ChatMessageItems: () => <div data-testid="child-overlay-messages" />,
}));

import { MainChatColumn } from './MainChatColumn';

beforeEach(() => {
  useChildOverlayStore.setState({ overlay: null, error: null });
  useSessionStore.setState({ activeSessionPath: null });
});

afterEach(() => {
  cleanup();
  useChildOverlayStore.setState({ overlay: null, error: null });
});

describe('MainChatColumn', () => {
  it('打开 overlay store 后父 ChatView 仍在，且有 subagent-child-overlay', () => {
    useChildOverlayStore.getState().open({
      id: 'sa-1',
      sessionPath: '/child.jsonl',
      parentSessionPath: '/parent.jsonl',
      label: 'first child',
      mode: 'one-shot',
      activity: 'settled',
      tornDown: false,
    });
    render(<MainChatColumn />);
    expect(screen.getByTestId('parent-chat-view')).toBeTruthy();
    expect(screen.getByTestId('subagent-child-overlay')).toBeTruthy();
    expect(screen.getByTestId('parent-chat-view').parentElement?.getAttribute('inert')).not.toBeNull();
  });
});
