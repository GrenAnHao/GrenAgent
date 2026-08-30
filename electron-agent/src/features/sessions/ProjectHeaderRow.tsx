import { memo, useCallback } from 'react';
import { ProjectItem } from './ProjectItem';
import type { ProjectGroup } from './useProjectGroups';

interface ProjectHeaderRowProps {
  group: ProjectGroup;
  expanded: boolean;
  onToggleExpand: (cwd: string, defaultCollapsed: boolean) => void;
  onNewInProject: (cwd: string) => void;
  onPinProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onRenameProject: (group: ProjectGroup) => void;
  onHideProject: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
}

export const ProjectHeaderRow = memo(function ProjectHeaderRow({
  group,
  expanded,
  onToggleExpand,
  onNewInProject,
  onPinProject,
  onRevealProject,
  onRenameProject,
  onHideProject,
  onRemoveProject,
}: ProjectHeaderRowProps) {
  const cwd = group.cwd;
  const handleToggle = useCallback(() => onToggleExpand(cwd, !group.isCurrent), [onToggleExpand, cwd, group.isCurrent]);
  const handleNew = useCallback(() => onNewInProject(cwd), [onNewInProject, cwd]);
  const handlePin = useCallback(() => onPinProject(cwd), [onPinProject, cwd]);
  const handleReveal = useCallback(() => onRevealProject(cwd), [onRevealProject, cwd]);
  const handleRename = useCallback(() => onRenameProject(group), [onRenameProject, group]);
  const handleHide = useCallback(() => onHideProject(cwd), [onHideProject, cwd]);
  const handleRemove = useCallback(() => onRemoveProject(cwd), [onRemoveProject, cwd]);

  return (
    <ProjectItem
      name={group.name}
      expanded={expanded}
      pinned={group.pinned}
      onToggle={handleToggle}
      onNew={handleNew}
      onPinToggle={handlePin}
      onReveal={handleReveal}
      onRename={handleRename}
      onHide={handleHide}
      onRemove={handleRemove}
    />
  );
});
