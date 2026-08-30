import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
        onRemoveProject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('项目甲'));
    // 默认折叠 = !isCurrent = true
    expect(onToggleExpand).toHaveBeenCalledWith('/proj/p1', true);
  });
});
