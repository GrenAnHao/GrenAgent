import { memo, useCallback, useMemo } from 'react';
import { App } from 'antd';
import { ProjectItem } from './ProjectItem';
import type { ProjectGroup } from './useProjectGroups';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import { syncBackIsolated } from '../isolatedWorkspace/actions';
import { useGroupAttention } from '../../stores/sessionAttention';

interface ProjectHeaderRowProps {
  group: ProjectGroup;
  expanded: boolean;
  /** 侧栏的运行中集合。折叠时用来算分组头的汇总角标。 */
  runningSessionPaths?: ReadonlySet<string>;
  onToggleExpand: (cwd: string, defaultCollapsed: boolean) => void;
  onNewInProject: (cwd: string) => void;
  onPinProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onRenameProject: (group: ProjectGroup) => void;
  onHideProject: (cwd: string) => void;
  onClearProjectSessions: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
}

const NO_RUNNING: ReadonlySet<string> = new Set();

export const ProjectHeaderRow = memo(function ProjectHeaderRow({
  group,
  expanded,
  runningSessionPaths,
  onToggleExpand,
  onNewInProject,
  onPinProject,
  onRevealProject,
  onRenameProject,
  onHideProject,
  onClearProjectSessions,
  onRemoveProject,
}: ProjectHeaderRowProps) {
  const cwd = group.cwd;
  const iso = group.isolated;
  const kind = useIsolatedWorkspaceStore((s) => s.kinds[cwd]);
  const { message } = App.useApp();
  const handleToggle = useCallback(() => onToggleExpand(cwd, !group.isCurrent), [onToggleExpand, cwd, group.isCurrent]);
  const handleNew = useCallback(() => onNewInProject(cwd), [onNewInProject, cwd]);
  const handlePin = useCallback(() => onPinProject(cwd), [onPinProject, cwd]);
  const handleReveal = useCallback(() => onRevealProject(cwd), [onRevealProject, cwd]);
  const handleRename = useCallback(() => onRenameProject(group), [onRenameProject, group]);
  const handleHide = useCallback(() => onHideProject(cwd), [onHideProject, cwd]);
  const handleClearSessions = useCallback(() => onClearProjectSessions(cwd), [onClearProjectSessions, cwd]);
  const handleRemove = useCallback(() => onRemoveProject(cwd), [onRemoveProject, cwd]);
  const handleNewIsolated = useCallback(() => useIsolatedWorkspaceStore.getState().openCreate(cwd), [cwd]);
  const handleManage = useCallback(
    () => useIsolatedWorkspaceStore.getState().openManage(iso ? iso.parentCwd : cwd, iso?.id),
    [cwd, iso],
  );
  const handleSyncBack = useCallback(() => {
    if (iso) void syncBackIsolated(iso.parentCwd, iso.id, message);
  }, [iso, message]);

  const sessionPaths = useMemo(() => group.sessions.map((s) => s.path), [group.sessions]);
  const attention = useGroupAttention(sessionPaths, runningSessionPaths ?? NO_RUNNING, !expanded);

  const missing = Boolean(iso) && kind === 'missing';
  // 普通项目才能建独立工作区（独立工作区里不能再建）；独立工作区本身给回传和删除，已删除的只剩管理。
  const isolatedActions = !iso
    ? { onNewIsolated: handleNewIsolated, onManageIsolated: handleManage }
    : missing
      ? { onManageIsolated: handleManage }
      : { onSyncBack: handleSyncBack, onDeleteIsolated: handleManage };

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
      onClearSessions={handleClearSessions}
      onRemove={handleRemove}
      {...(iso ? { isolated: { nested: iso.parentListed, missing } } : {})}
      {...isolatedActions}
      {...(attention ? { attention } : {})}
    />
  );
});
