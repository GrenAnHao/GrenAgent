import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from './ConversationRow';
import type { ConversationItem } from './useConversations';

const item: ConversationItem = {
  cwd: '/works/c1',
  sessionPath: '/works/c1/s.json',
  name: '会话甲',
  timestamp: '2026-06-15T00:00:00Z',
  isCurrent: false,
};

describe('ConversationRow', () => {
  it('renders name and fires onOpen with cwd + path', () => {
    const onOpen = vi.fn();
    render(
      <ConversationRow
        item={item}
        active={false}
        running={false}
        pinned={false}
        editing={false}
        onOpen={onOpen}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('会话甲'));
    expect(onOpen).toHaveBeenCalledWith('/works/c1', '/works/c1/s.json');
  });

  it('submits rename with cwd + path + name', () => {
    const onSubmitRename = vi.fn();
    render(
      <ConversationRow
        item={item}
        active={false}
        running={false}
        pinned={false}
        editing
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSubmitRename={onSubmitRename}
        onRequestRename={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitRename).toHaveBeenCalledWith('/works/c1', '/works/c1/s.json', '新名');
  });
});
