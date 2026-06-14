import { useCallback, useMemo, useState, memo } from 'react';
import { ActionIcon, Empty, Flexbox, Text } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderPlus, MessageSquarePlus, PanelLeftClose } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { PanelHeader } from '../../components/PanelHeader';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useProjectGroups, type ProjectGroup as Group } from './useProjectGroups';
import { useConversations } from './useConversations';
import { SidebarActions } from './SidebarActions';
import { ProjectGroup } from './ProjectGroup';
import { SessionItem } from './SessionItem';

const styles = createStaticStyles(({ css }) => ({
  sec: css`
    padding: 12px 14px 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
  secRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 8px 4px 14px;
  `,
  secLabel: css`
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
  runningSessionPaths: Set<string>;
  onNewConversation: () => void;
  onOpenProject: () => void;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onDeleteConversation: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onToggleSidebar: () => void;
}

interface GroupListProps {
  groups: Group[];
  runningSessionPaths: Set<string>;
  activeSessionPath: string | null;
  renamingPath: string | null;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onRequestRename: (path: string) => void;
}

const GroupList = memo(function GroupList({
  groups,
  runningSessionPaths,
  activeSessionPath,
  renamingPath,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onRemoveProject,
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
          runningSessionPaths={runningSessionPaths}
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
          onRemoveProject={onRemoveProject}
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
  const conversations = useConversations();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
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
    runningSessionPaths: props.runningSessionPaths,
    activeSessionPath,
    renamingPath,
    onNewSession: props.onNewSession,
    onOpenSession: props.onOpenSession,
    onDeleteSession: props.onDeleteSession,
    onRemoveProject: props.onRemoveProject,
    onSubmitRename: handleSubmitRename,
    onRequestRename: handleRequestRename,
    groups: [],
  };

  const newProjectMenu = {
    items: [
      { key: 'blank', label: '新建空白项目' },
      { key: 'existing', label: '使用现有文件夹' },
    ],
    onClick: () => props.onOpenProject(),
  };

  const showLoading =
    (isLoading || allSessionsLoading) && groups.length === 0 && conversations.length === 0;
  const showEmpty =
    !isLoading && !allSessionsLoading && groups.length === 0 && conversations.length === 0;

  return (
    <Flexbox height="100%" style={{ minHeight: 0, background: 'var(--gren-sidebar-bg, transparent)' }}>
      <PanelHeader
        title="Pi Agent"
        actions={<ActionIcon icon={PanelLeftClose} size="small" title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions />
      <div className={styles.scroll}>
        {showLoading && (
          <Flexbox align="center" justify="center" style={{ padding: 24 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              加载会话…
            </Text>
          </Flexbox>
        )}
        {showEmpty && <Empty description="暂无对话或项目" />}

        <div className={styles.secRow}>
          <span className={styles.secLabel}>对话</span>
          <ActionIcon
            icon={MessageSquarePlus}
            size="small"
            title="新建对话 (Ctrl+Alt+N)"
            onClick={props.onNewConversation}
          />
        </div>
        {conversations.map((c) => (
          <SessionItem
            key={c.cwd}
            title={c.name}
            active={activeSessionPath === c.sessionPath}
            running={props.runningSessionPaths.has(c.sessionPath)}
            pinned={false}
            editing={renamingPath === c.sessionPath}
            onClick={() => props.onOpenSession(c.cwd, c.sessionPath)}
            onPinToggle={() => {}}
            onRequestRename={() => setRenamingPath(c.sessionPath)}
            onRename={(name) => handleSubmitRename(c.cwd, c.sessionPath, name)}
            onDelete={() => props.onDeleteConversation(c.cwd)}
          />
        ))}

        <div className={styles.secRow}>
          <span className={styles.secLabel}>项目</span>
          <Dropdown menu={newProjectMenu} trigger={['click']}>
            <span>
              <ActionIcon icon={FolderPlus} size="small" title="新建项目" />
            </span>
          </Dropdown>
        </div>
        {pinnedGroups.length > 0 && <div className={styles.sec}>置顶</div>}
        <GroupList {...listProps} groups={pinnedGroups} />
        <GroupList {...listProps} groups={normalGroups} />
      </div>
    </Flexbox>
  );
});
