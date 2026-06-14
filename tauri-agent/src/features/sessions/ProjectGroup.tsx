import { memo, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown } from 'lucide-react';
import type { ProjectGroup as Group } from './useProjectGroups';
import { ProjectItem } from './ProjectItem';
import { SessionItem } from './SessionItem';

const DEFAULT_VISIBLE = 5;

const styles = createStaticStyles(({ css }) => ({
  more: css`
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 6px;
    padding: 2px 10px 4px 28px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
}));

export interface ProjectGroupProps {
  group: Group;
  expanded: boolean;
  activeSessionPath: string | null;
  runningSessionPaths: Set<string>;
  renamingPath: string | null;
  onToggleExpand: () => void;
  onNewInProject: (cwd: string) => void;
  onPinProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onRenameProject: (cwd: string) => void;
  onHideProject: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onPinSession: (path: string) => void;
  onRequestRename: (path: string) => void;
  onSubmitRename: (path: string, name: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  isSessionPinned: (path: string) => boolean;
}

export const ProjectGroup = memo(function ProjectGroup(p: ProjectGroupProps) {
  const [showAll, setShowAll] = useState(false);
  const g = p.group;
  const visible = showAll ? g.sessions : g.sessions.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = g.sessions.length - visible.length;

  return (
    <>
      <ProjectItem
        name={g.name}
        expanded={p.expanded}
        isCurrent={g.isCurrent}
        pinned={g.pinned}
        onToggle={p.onToggleExpand}
        onNew={() => p.onNewInProject(g.cwd)}
        onPinToggle={() => p.onPinProject(g.cwd)}
        onReveal={() => p.onRevealProject(g.cwd)}
        onRename={() => p.onRenameProject(g.cwd)}
        onHide={() => p.onHideProject(g.cwd)}
        onRemove={() => p.onRemoveProject(g.cwd)}
      />
      {p.expanded &&
        visible.map((s) => (
          <SessionItem
            key={s.path}
            title={s.name || 'Untitled'}
            active={p.activeSessionPath === s.path}
            running={p.runningSessionPaths.has(s.path)}
            pinned={p.isSessionPinned(s.path)}
            editing={p.renamingPath === s.path}
            onClick={() => p.onOpenSession(g.cwd, s.path)}
            onPinToggle={() => p.onPinSession(s.path)}
            onRequestRename={() => p.onRequestRename(s.path)}
            onRename={(name) => p.onSubmitRename(s.path, name)}
            onDelete={() => p.onDeleteSession(g.cwd, s.path)}
          />
        ))}
      {p.expanded && hiddenCount > 0 && (
        <div className={styles.more} onClick={() => setShowAll(true)}>
          <Icon icon={ChevronDown} size="small" /> 查看全部 {g.sessions.length} 条
        </div>
      )}
    </>
  );
});
