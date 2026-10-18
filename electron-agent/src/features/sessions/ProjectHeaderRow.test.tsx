import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectMenuItems } from './useProjectMenu';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import { ProjectHeaderRow } from './ProjectHeaderRow';
import type { ProjectGroup } from './useProjectGroups';

const group: ProjectGroup = {
  cwd: '/proj/p1',
  name: '项目甲',
  isCurrent: false,
  pinned: false,
  sessions: [],
  lastActivity: '',
};

describe('ProjectHeaderRow', () => {
  it('renders name and toggles expand with cwd + default-collapsed', () => {
    const onToggleExpand = vi.fn();
    render(
      <ProjectHeaderRow
        group={group}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onNewInProject={vi.fn()}
        onPinProject={vi.fn()}
        onRevealProject={vi.fn()}
        onRenameProject={vi.fn()}
        onHideProject={vi.fn()}
        onClearProjectSessions={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('项目甲'));
    // 默认折叠 = !isCurrent = true
    expect(onToggleExpand).toHaveBeenCalledWith('/proj/p1', true);
  });
});

describe('ProjectHeaderRow · isolated workspaces', () => {
  const noop = {
    onToggleExpand: vi.fn(), onNewInProject: vi.fn(), onPinProject: vi.fn(), onRevealProject: vi.fn(), onRenameProject: vi.fn(),
    onHideProject: vi.fn(), onClearProjectSessions: vi.fn(), onRemoveProject: vi.fn(),
  };
  const iso: ProjectGroup = {
    cwd: '/proj/p1/.gren/worktrees/abc12345', name: 'gren/abc12345', isCurrent: false, pinned: false, sessions: [], lastActivity: '',
    isolated: { parentCwd: '/proj/p1', id: 'abc12345', branch: 'gren/abc12345', parentListed: true },
  };
  beforeEach(() => useIsolatedWorkspaceStore.setState({ kinds: {}, dialog: null }));

  it('tags an isolated row and marks it deleted once the probe says missing', () => {
    const { rerender } = render(<ProjectHeaderRow group={iso} expanded={false} {...noop} />);
    expect(screen.getByTestId('isolated-project-row').textContent).toContain('独立');
    useIsolatedWorkspaceStore.setState({ kinds: { [iso.cwd]: 'missing' } });
    rerender(<ProjectHeaderRow group={iso} expanded={false} {...noop} />);
    expect(screen.getByTestId('isolated-project-row').getAttribute('data-isolated-missing')).toBe('true');
    expect(screen.getByTestId('isolated-project-row').textContent).toContain('已删除');
  });
});

describe('buildProjectMenuItems · isolated entries', () => {
  const base = { pinned: false, onPinToggle: vi.fn(), onReveal: vi.fn(), onRename: vi.fn(), onHide: vi.fn(), onClearSessions: vi.fn(), onRemove: vi.fn() };
  const keys = (items: ReturnType<typeof buildProjectMenuItems>) => items.map((i) => (i && 'key' in i ? i.key : 'divider'));

  it('ordinary projects offer create + manage first; isolated ones offer sync back + delete', () => {
    expect(keys(buildProjectMenuItems({ ...base, onNewIsolated: vi.fn(), onManageIsolated: vi.fn() })).slice(0, 3))
      .toEqual(['isolated-new', 'isolated-manage', 'divider']);
    expect(keys(buildProjectMenuItems({ ...base, onSyncBack: vi.fn(), onDeleteIsolated: vi.fn() })).slice(0, 3))
      .toEqual(['isolated-sync-back', 'isolated-delete', 'divider']);
    expect(keys(buildProjectMenuItems(base))[0]).toBe('pin');
  });
});
