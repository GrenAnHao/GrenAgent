import { useCallback, useState, memo } from 'react';
import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderPlus, MessageSquarePlus, PanelLeftClose } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { VList } from 'virtua';
import { PanelHeader } from '../../components/PanelHeader';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useConversations } from './useConversations';
import { SidebarActions } from './SidebarActions';
import { ConversationRow } from './ConversationRow';
import { GroupSessionRow } from './GroupSessionRow';
import { ProjectHeaderRow } from './ProjectHeaderRow';
import { useSidebarItems, type SidebarItem } from './useSidebarItems';

const styles = createStaticStyles(({ css }) => ({
  sec: css`
    padding: 12px 14px 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
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
    font-size: 11px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
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
  listWrap: css`
    flex: 1;
    min-height: 0;
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

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const conversations = useConversations();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const isLoading = useSessionStore((s) => s.isLoading);
  const allSessionsLoading = useSessionStore((s) => s.allSessionsLoading);

  const toggleCollapsed = useSidebarPrefsStore((s) => s.toggleCollapsed);
  const togglePinnedProject = useSidebarPrefsStore((s) => s.togglePinnedProject);
  const togglePinnedSession = useSidebarPrefsStore((s) => s.togglePinnedSession);
  const hideProject = useSidebarPrefsStore((s) => s.hideProject);
  const setAlias = useSidebarPrefsStore((s) => s.setAlias);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [showAllCwds, setShowAllCwds] = useState<Set<string>>(new Set());

  const items = useSidebarItems(showAllCwds);

  const handleSubmitRename = useCallback(
    (cwd: string, path: string, name: string) => {
      setRenamingPath(null);
      props.onSubmitRename(cwd, path, name);
    },
    [props.onSubmitRename],
  );
  const handleRequestRename = useCallback((path: string) => setRenamingPath(path), []);
  const handleRevealProject = useCallback((cwd: string) => void openPath(cwd), []);
  const handleRenameProject = useCallback(
    (group: { cwd: string; name: string }) => {
      const next = window.prompt('项目别名（留空恢复默认）', group.name);
      if (next !== null) setAlias(group.cwd, next);
    },
    [setAlias],
  );
  const handleShowAll = useCallback((cwd: string) => {
    setShowAllCwds((prev) => {
      const next = new Set(prev);
      next.add(cwd);
      return next;
    });
  }, []);

  const newProjectMenu = {
    items: [
      { key: 'blank', label: '新建空白项目' },
      { key: 'existing', label: '使用现有文件夹' },
    ],
    onClick: () => props.onOpenProject(),
  };

  const renderItem = useCallback(
    (item: SidebarItem) => {
      switch (item.type) {
        case 'section':
          return (
            <div className={styles.secRow}>
              <span className={styles.secLabel}>{item.label}</span>
              {item.action === 'new-conversation' ? (
                <ActionIcon
                  icon={MessageSquarePlus}
                  size="small"
                  title="新建对话 (Ctrl+Alt+N)"
                  onClick={props.onNewConversation}
                />
              ) : (
                <Dropdown menu={newProjectMenu} trigger={['click']}>
                  <span>
                    <ActionIcon icon={FolderPlus} size="small" title="新建项目" />
                  </span>
                </Dropdown>
              )}
            </div>
          );
        case 'conversation':
          return (
            <ConversationRow
              item={item.item}
              active={activeSessionPath === item.item.sessionPath}
              running={props.runningSessionPaths.has(item.item.sessionPath)}
              editing={renamingPath === item.item.sessionPath}
              onOpen={props.onOpenSession}
              onDelete={props.onDeleteConversation}
              onSubmitRename={handleSubmitRename}
              onRequestRename={handleRequestRename}
            />
          );
        case 'pinned-label':
          return <div className={styles.sec}>置顶</div>;
        case 'project':
          return (
            <ProjectHeaderRow
              group={item.group}
              expanded={item.expanded}
              onToggleExpand={toggleCollapsed}
              onNewInProject={props.onNewSession}
              onPinProject={togglePinnedProject}
              onRevealProject={handleRevealProject}
              onRenameProject={handleRenameProject}
              onHideProject={hideProject}
              onRemoveProject={props.onRemoveProject}
            />
          );
        case 'session':
          return (
            <GroupSessionRow
              cwd={item.cwd}
              session={item.session}
              active={activeSessionPath === item.session.path}
              running={props.runningSessionPaths.has(item.session.path)}
              pinned={item.pinned}
              editing={renamingPath === item.session.path}
              onOpen={props.onOpenSession}
              onDelete={props.onDeleteSession}
              onSubmitRename={handleSubmitRename}
              onRequestRename={handleRequestRename}
              onPinToggle={togglePinnedSession}
            />
          );
        case 'more':
          return (
            <div className={styles.more} onClick={() => handleShowAll(item.cwd)}>
              查看全部 {item.total} 条
            </div>
          );
        default:
          return null;
      }
    },
    [
      activeSessionPath,
      renamingPath,
      props.runningSessionPaths,
      props.onNewConversation,
      props.onOpenSession,
      props.onDeleteConversation,
      props.onNewSession,
      props.onRemoveProject,
      props.onDeleteSession,
      handleSubmitRename,
      handleRequestRename,
      toggleCollapsed,
      togglePinnedProject,
      togglePinnedSession,
      hideProject,
      handleRevealProject,
      handleRenameProject,
      handleShowAll,
    ],
  );

  // items 永远包含「对话」「项目」两个分区头（含新建入口），因此空状态也要渲染 VList——
  // 不能用 Empty 整体替代，否则分区标题与新建按钮会一起消失（用户无法新建对话/项目）。
  const showLoading =
    (isLoading || allSessionsLoading) && conversations.length === 0 && items.length <= 2;

  return (
    <Flexbox height="100%" style={{ minHeight: 0, background: 'var(--gren-sidebar-bg, transparent)' }}>
      <PanelHeader
        title="Pi Agent"
        actions={<ActionIcon icon={PanelLeftClose} size="small" title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions />
      <div className={styles.listWrap}>
        {showLoading ? (
          <Flexbox align="center" justify="center" style={{ padding: 24 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              加载会话…
            </Text>
          </Flexbox>
        ) : (
          <VList data={items} style={{ height: '100%' }}>
            {(item: SidebarItem) => <div key={item.key}>{renderItem(item)}</div>}
          </VList>
        )}
      </div>
    </Flexbox>
  );
});
