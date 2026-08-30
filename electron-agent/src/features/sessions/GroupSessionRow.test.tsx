import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GroupSessionRow } from './GroupSessionRow';
import type { SessionInfo } from '../../lib/pi';

const session = { path: '/proj/p1/s.json', name: '组会话甲', cwd: '/proj/p1', timestamp: '' } as SessionInfo;

describe('GroupSessionRow', () => {
  it('fires onOpen with cwd + path', () => {
    const onOpen = vi.fn();
    render(
      <GroupSessionRow
        cwd="/proj/p1"
        session={session}
        active={false}
        running={false}
        pinned={false}
        editing={false}
        onOpen={onOpen}
        onDelete={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
        onPinToggle={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('组会话甲'));
    expect(onOpen).toHaveBeenCalledWith('/proj/p1', '/proj/p1/s.json');
  });

  it('falls back to 新对话 for empty name', () => {
    render(
      <GroupSessionRow
        cwd="/proj/p1"
        session={{ ...session, name: '' } as SessionInfo}
        active={false}
        running={false}
        pinned={false}
        editing={false}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onSubmitRename={vi.fn()}
        onRequestRename={vi.fn()}
        onPinToggle={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByText('新对话')).toBeTruthy();
  });
});
