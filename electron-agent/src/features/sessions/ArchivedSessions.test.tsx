import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../lib/pi';
import { useSessionStore } from '../../store/session';
import { ArchivedSessions } from './ArchivedSessions';

const session = (path: string, name: string, timestamp: string, archived: boolean, cwd = 'D:/repo'): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp,
  name,
  ...(archived ? { archived: true } : {}),
});

beforeEach(() => {
  useSessionStore.setState({
    worksDir: 'C:/agent/works',
    deletedSessionPaths: [],
    allSessions: [
      session('D:/s/old.jsonl', '旧的归档', '2026-10-01T00:00:00Z', true),
      session('D:/s/new.jsonl', '新的归档', '2026-10-05T00:00:00Z', true, 'C:/agent/works/abc'),
      session('D:/s/live.jsonl', '还在侧栏', '2026-10-06T00:00:00Z', false),
    ],
  });
});

afterEach(() => {
  useSessionStore.setState({ allSessions: [], deletedSessionPaths: [] });
});

describe('ArchivedSessions', () => {
  it('renders nothing when no session is archived', () => {
    useSessionStore.setState({ allSessions: [session('D:/s/live.jsonl', 'x', '2026-10-06T00:00:00Z', false)] });
    const { container } = render(<ArchivedSessions onUnarchive={vi.fn()} onDelete={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count and lists archived sessions newest first with their place', () => {
    render(<ArchivedSessions onUnarchive={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('archived-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('archived-entry'));
    const rows = screen.getAllByTestId('archived-row');
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['D:/s/new.jsonl', 'D:/s/old.jsonl']);
    expect(within(rows[0]).getByText(/^对话 · /)).toBeTruthy();
    expect(within(rows[1]).getByText(/^repo · /)).toBeTruthy();
  });

  it('unarchives a row and keeps the dialog open with an empty state after the last one', () => {
    const onUnarchive = vi.fn((s: SessionInfo) => {
      useSessionStore.setState((st) => ({
        allSessions: st.allSessions.map((x) => (x.path === s.path ? { ...x, archived: false } : x)),
      }));
    });
    render(<ArchivedSessions onUnarchive={onUnarchive} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId('archived-entry'));
    for (const button of screen.getAllByTestId('archived-restore')) act(() => fireEvent.click(button));
    expect(onUnarchive).toHaveBeenCalledTimes(2);
    expect(screen.getByText('没有已归档的会话')).toBeTruthy();
  });

  it('asks before deleting and passes cwd and path', () => {
    const onDelete = vi.fn();
    render(<ArchivedSessions onUnarchive={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId('archived-entry'));
    fireEvent.click(screen.getAllByTestId('archived-delete')[1]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('确定删除「旧的归档」吗？此操作不可恢复。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('archived-delete-confirm'));
    expect(onDelete).toHaveBeenCalledWith('D:/repo', 'D:/s/old.jsonl');
  });
});
