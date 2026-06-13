import { useCallback, useMemo, useState, memo } from 'react';
import { ActionIcon, Empty, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { PanelLeftClose } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { PanelHeader } from '../../components/PanelHeader';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useProjectGroups, type ProjectGroup as Group } from './useProjectGroups';
import { SidebarActions } from './SidebarActions';
import { ProjectGroup } from './ProjectGroup';

const styles = createStaticStyles(({ css }) => ({
  sec: css`
    padding: 12px 14px 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
  scroll: css`
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    contain: strict;
  `,
}));

export interface SidebarProps {
  runningSessionPath: string | null;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onToggleSidebar: () => void;
}

interface GroupListProps {
  groups: Group[];
  runningSessionPath: string | null;
  activeSessionPath: string | null;
  renamingPath: string | null;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
}

const GroupList = memo(function GroupList({
  groups,
  runningSessionPath,
  activeSessionPath,
  renamingPath,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onSubmitRename,
  onRequestRename,
}: GroupListProps) {
  const collapsed = useSidebarPrefsStore((s) => s.collapsed);
  const pinnedSessions = useSidebarPrefsStore((s) => s.pinnedSessions);
  const toggleCollapsed = useSidebarPrefsStore((s) => s.toggleCollapsed);
  const togglePinnedProject = useSidebarPrefsStore((s) => s.togglePinnedProject);
  const togglePinnedSession = useSidebarPrefsStore((s) => s.togglePinnedSession);
  const hideProject = useSidebarPrefsStore((s) => s.hideProject);
  const setAlias = useSidebarPrefsStore((s) => s.setAlias);

  const isCollapsed = useCallback(
    (cwd: string, defaultCollapsed: boolean) => {
      const value = collapsed[cwd];
      return value === undefined ? defaultCollapsed : value;
    },
    [collapsed],
  );

  const isSessionPinned = useCallback(
    (path: string) => pinnedSessions.includes(path),
    [pinnedSessions],
  );

  return (
    <>
      {groups.map((g) => (
        <ProjectGroup
          key={g.cwd}
          group={g}
          expanded={!isCollapsed(g.cwd, !g.isCurrent)}
          activeSessionPath={activeSessionPath}
          runningSessionPath={runningSessionPath}
          renamingPath={renamingPath}
          onToggleExpand={() => toggleCollapsed(g.cwd, !g.isCurrent)}
          onNewInProject={onNewSession}
          onPinProject={togglePinnedProject}
          onRevealProject={(cwd) => void openPath(cwd)}
          onRenameProject={(cwd) => {
            const next = window.prompt('项目别名（留空恢复默认）', g.name);
            if (next !== null) setAlias(cwd, next);
          }}
          onHideProject={hideProject}
          onOpenSession={onOpenSession}
          onPinSession={togglePinnedSession}
          onRequestRename={onRequestRename}
          onSubmitRename={(path, name) => onSubmitRename(g.cwd, path, name)}
          onDeleteSession={onDeleteSession}
          isSessionPinned={isSessionPinned}
        />
      ))}
    </>
  );
});

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const groups = useProjectGroups();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const isLoading = useSessionStore((s) => s.isLoading);
  const allSessionsLoading = useSessionStore((s) => s.allSessionsLoading);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const { pinnedGroups, normalGroups } = useMemo(() => {
    const pinned: Group[] = [];
    const normal: Group[] = [];
    for (const g of groups) {
      if (g.pinned) pinned.push(g);
      else normal.push(g);
    }
    return { pinnedGroups: pinned, normalGroups: normal };
  }, [groups]);

  const handleSubmitRename = useCallback(
    (cwd: string, path: string, name: string) => {
      setRenamingPath(null);
      props.onSubmitRename(cwd, path, name);
    },
    [props.onSubmitRename],
  );

  const handleRequestRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const listProps: GroupListProps = {
    runningSessionPath: props.runningSessionPath,
    activeSessionPath,
    renamingPath,
    onNewSession: props.onNewSession,
    onOpenSession: props.onOpenSession,
    onDeleteSession: props.onDeleteSession,
    onSubmitRename: handleSubmitRename,
    onRequestRename: handleRequestRename,
    groups: [],
  };

  return (
    <Flexbox height="100%" style={{ minHeight: 0, background: 'var(--gren-sidebar-bg, transparent)' }}>
      <PanelHeader
        title="Pi Agent"
        actions={<ActionIcon icon={PanelLeftClose} title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions onNew={() => props.onNewSession(activeWorkspace)} />
      <div className={styles.scroll}>
        {(isLoading || allSessionsLoading) && groups.length === 0 && (
          <Flexbox align="center" justify="center" style={{ padding: 24 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              加载会话…
            </Text>
          </Flexbox>
        )}
        {!isLoading && !allSessionsLoading && groups.length === 0 && (
          <Empty description="暂无会话" />
        )}
        {pinnedGroups.length > 0 && <div className={styles.sec}>置顶</div>}
        <GroupList {...listProps} groups={pinnedGroups} />
        {normalGroups.length > 0 && <div className={styles.sec}>项目</div>}
        <GroupList {...listProps} groups={normalGroups} />
      </div>
    </Flexbox>
  );
});
