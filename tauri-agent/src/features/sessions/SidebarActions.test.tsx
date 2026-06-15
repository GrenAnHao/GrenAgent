import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SidebarActions } from './SidebarActions';
import { useProjectGroups } from './useProjectGroups';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import type { SessionInfo } from '../../lib/pi';

const sessions: SessionInfo[] = [
  {
    id: '1',
    path: '/p/alpha/s1.json',
    cwd: '/projects/alpha',
    timestamp: '2026-01-01T00:00:00Z',
    name: 'alpha chat',
  },
  {
    id: '2',
    path: '/p/beta/s1.json',
    cwd: '/projects/beta',
    timestamp: '2026-01-02T00:00:00Z',
    name: 'beta chat',
  },
];

function Probe() {
  const groups = useProjectGroups();
  return (
    <div>
      <SidebarActions />
      <ul data-testid="list">
        {groups.map((g) => (
          <li key={g.cwd}>{g.name}</li>
        ))}
      </ul>
    </div>
  );
}

describe('会话列表搜索', () => {
  beforeEach(() => {
    useSessionStore.setState({
      allSessions: sessions,
      worksDir: '',
      activeWorkspace: '',
      searchKeyword: '',
    });
    useSidebarPrefsStore.setState({ pinnedProjects: [], hiddenProjects: [], aliases: {} });
  });

  it('输入关键词后过滤会话列表', () => {
    render(<Probe />);
    const list = screen.getByTestId('list');
    expect(within(list).getByText('alpha')).toBeTruthy();
    expect(within(list).getByText('beta')).toBeTruthy();

    fireEvent.click(screen.getByText('搜索会话'));
    const input = screen.getByPlaceholderText('搜索会话 / 项目');
    fireEvent.change(input, { target: { value: 'alpha' } });

    expect(useSessionStore.getState().searchKeyword).toBe('alpha');
    expect(within(list).getByText('alpha')).toBeTruthy();
    expect(within(list).queryByText('beta')).toBeNull();
  });
});
