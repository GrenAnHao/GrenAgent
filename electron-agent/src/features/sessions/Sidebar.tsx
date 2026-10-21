import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import { App, Dropdown, Input, Modal } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { FolderPlus, MessageSquarePlus } from 'lucide-react';
import { revealItemInDir } from '../../platform/runtime';
import { VList } from 'virtua';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { cancelHoverPrewarm, PREWARM_AFTER_BOOT_MS, prewarmRecent, startHoverPrewarm } from '../../lib/prewarm';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useConversations } from './useConversations';
import { SidebarActions } from './SidebarActions';
import { ConversationRow } from './ConversationRow';
import { GroupSessionRow } from './GroupSessionRow';
import { ProjectHeaderRow } from './ProjectHeaderRow';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { useSidebarItems, type SidebarItem } from './useSidebarItems';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import type { SessionInfo } from '../../lib/pi';
import { ArchivedSessions } from './ArchivedSessions';

/** 取某侧栏条目对应的工作区 cwd（用于 hover 预热）；分区/标题无 cwd。 */
function cwdOfItem(item: SidebarItem): string | undefined {
  switch (item.type) {
    case 'conversation':
      return item.item.cwd;
    case 'session':
      return item.cwd;
    case 'project':
      return item.group.cwd;
    case 'more':
      return item.cwd;
    default:
      return undefined;
  }
}

const styles = createStaticStyles(({ css }) => ({
  more: css`
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 6px;
    padding: 2px 10px 4px 28px;
    color: ${cssVar.colorTextTertiary};
    font-size: var(--pi-font-size-secondary, 13px);
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
  onClearProjectSessions: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  /** 归档项目里的一份会话。不给就没有归档功能（菜单项、底部入口都不出）。 */
  onArchiveSession?: (cwd: string, path: string) => void;
  /** 归档一个对话目录下的全部会话。 */
  onArchiveConversation?: (cwd: string) => void;
  onUnarchiveSession?: (session: SessionInfo) => void;
  /** 按第一条用户消息重新生成标题并写回，返回新标题（生成不出时为空串）。不给就没有这个菜单项。 */
  onRegenerateTitle?: (cwd: string, path: string) => Promise<string>;
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const conversations = useConversations();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const isLoading = useSessionStore((s) => s.isLoading);
  const allSessionsLoading = useSessionStore((s) => s.allSessionsLoading);

  const toggleCollapsed = useSidebarPrefsStore((s) => s.toggleCollapsed);
  const toggleSectionCollapsed = useSidebarPrefsStore((s) => s.toggleSectionCollapsed);
  const expandSection = useSidebarPrefsStore((s) => s.expandSection);
  const togglePinnedProject = useSidebarPrefsStore((s) => s.togglePinnedProject);
  const togglePinnedConversation = useSidebarPrefsStore((s) => s.togglePinnedConversation);
  const togglePinnedSession = useSidebarPrefsStore((s) => s.togglePinnedSession);
  const pinnedConversations = useSidebarPrefsStore((s) => s.pinnedConversations);
  const hideProject = useSidebarPrefsStore((s) => s.hideProject);
  const setAlias = useSidebarPrefsStore((s) => s.setAlias);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [aliasEdit, setAliasEdit] = useState<{ cwd: string; name: string } | null>(null);
  const [aliasValue, setAliasValue] = useState('');
  const [showAllCwds, setShowAllCwds] = useState<Set<string>>(new Set());

  const items = useSidebarItems(showAllCwds);
  const { appBooted } = useAgentStoreContext();

  // 独立工作区的组问一次主进程：还在 / 已删除。创建、删除、回传后 revision 变，重问。
  const isolatedCwds = useMemo(
    () => items.flatMap((item) => (item.type === 'project' && item.group.isolated ? [item.group.cwd] : [])).join('\n'),
    [items],
  );
  const isolatedRevision = useIsolatedWorkspaceStore((s) => s.revision);
  useEffect(() => {
    if (!isolatedCwds) return;
    void useIsolatedWorkspaceStore.getState().refreshKinds(isolatedCwds.split('\n'));
  }, [isolatedCwds, isolatedRevision]);

  // 等主界面出来再预热其它项目。冷启动时和当前工作区一起建运行时，会把扩展工厂挤在加载页上。
  const didPrewarmRef = useRef(false);
  useEffect(() => {
    if (!appBooted || didPrewarmRef.current || conversations.length === 0) return;
    didPrewarmRef.current = true;
    prewarmRecent(
      conversations.map((c) => c.cwd),
      4,
      PREWARM_AFTER_BOOT_MS,
      useSessionStore.getState().activeWorkspace,
    );
  }, [appBooted, conversations]);

  const handleSubmitRename = useCallback(
    (cwd: string, path: string, name: string) => {
      setRenamingPath(null);
      props.onSubmitRename(cwd, path, name);
    },
    [props.onSubmitRename],
  );
  const handleRequestRename = useCallback((path: string) => setRenamingPath(path), []);
  const { message } = App.useApp();
  const regenerateTitle = props.onRegenerateTitle;
  const handleRegenerateTitle = useCallback(
    async (cwd: string, path: string) => {
      if (!regenerateTitle) return;
      const key = `regenerate-title:${path}`;
      void message.open({ key, type: 'loading', content: '正在生成标题…', duration: 0 });
      try {
        const title = await regenerateTitle(cwd, path);
        if (title) void message.open({ key, type: 'success', content: `标题已更新：${title}`, duration: 2 });
        else void message.open({ key, type: 'warning', content: '没有生成出合适的标题，保留原标题', duration: 3 });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        void message.open({ key, type: 'error', content: `生成标题失败：${reason}`, duration: 4 });
      }
    },
    [message, regenerateTitle],
  );
  // 用 revealItemInDir 而非 openPath：reveal 在 opener:default 权限内即可用；openPath 需额外
  // opener:allow-open-path 并重建 Tauri，否则调用被权限拦截、点击"在资源管理器中打开"无反应。
  const handleRevealProject = useCallback((cwd: string) => void revealItemInDir(cwd), []);
  const handleRenameProject = useCallback(
    (group: { cwd: string; name: string }) => {
      setAliasValue(group.name);
      setAliasEdit({ cwd: group.cwd, name: group.name });
    },
    [],
  );
  const submitAlias = useCallback(() => {
    if (!aliasEdit) return;
    setAlias(aliasEdit.cwd, aliasValue);
    setAliasEdit(null);
  }, [aliasEdit, aliasValue, setAlias]);
  const handleShowAll = useCallback((cwd: string) => {
    setShowAllCwds((prev) => {
      const next = new Set(prev);
      next.add(cwd);
      return next;
    });
  }, []);

  // 区头里的新建入口先展开本区（同 VS Code 视图标题栏的动作），新建出来的那一行才看得见。
  // Ctrl+Alt+N 等别的入口不动用户的折叠。
  const handleNewConversation = useCallback(() => {
    expandSection('conversations');
    props.onNewConversation();
  }, [expandSection, props.onNewConversation]);
  const newProjectMenu = useMemo(
    () => ({
      items: [
        { key: 'blank', label: '新建空白项目' },
        { key: 'existing', label: '使用现有文件夹' },
      ],
      onClick: () => {
        expandSection('projects');
        props.onOpenProject();
      },
    }),
    [expandSection, props.onOpenProject],
  );

  const renderItem = useCallback(
    (item: SidebarItem) => {
      switch (item.type) {
        case 'section':
          return (
            <SidebarSectionHeader
              id={item.id}
              label={item.label}
              collapsed={item.collapsed}
              onToggle={toggleSectionCollapsed}
              sessionPaths={item.sessionPaths}
              runningSessionPaths={props.runningSessionPaths}
              action={
                item.action === 'new-conversation' ? (
                  <ActionIcon
                    icon={MessageSquarePlus}
                    size="small"
                    title="新建对话 (Ctrl+Alt+N)"
                    data-testid="sidebar-new-conversation"
                    onClick={handleNewConversation}
                  />
                ) : item.action === 'new-project' ? (
                  <Dropdown menu={newProjectMenu} trigger={['click']}>
                    <span data-testid="sidebar-new-project">
                      <ActionIcon icon={FolderPlus} size="small" title="新建项目" />
                    </span>
                  </Dropdown>
                ) : undefined
              }
            />
          );
        case 'conversation':
          return (
            <ConversationRow
              item={item.item}
              active={activeSessionPath === item.item.sessionPath}
              running={props.runningSessionPaths.has(item.item.sessionPath)}
              pinned={pinnedConversations.some((cwd) => pathsEquivalent(cwd, item.item.cwd))}
              editing={renamingPath === item.item.sessionPath}
              onOpen={props.onOpenSession}
              onDelete={props.onDeleteConversation}
              onPinToggle={togglePinnedConversation}
              onSubmitRename={handleSubmitRename}
              onRequestRename={handleRequestRename}
              onReveal={handleRevealProject}
              onArchive={props.onArchiveConversation}
              onRegenerateTitle={props.onRegenerateTitle ? handleRegenerateTitle : undefined}
            />
          );
        case 'project':
          return (
            <ProjectHeaderRow
              group={item.group}
              expanded={item.expanded}
              runningSessionPaths={props.runningSessionPaths}
              onToggleExpand={toggleCollapsed}
              onNewInProject={props.onNewSession}
              onPinProject={togglePinnedProject}
              onRevealProject={handleRevealProject}
              onRenameProject={handleRenameProject}
              onHideProject={hideProject}
              onClearProjectSessions={props.onClearProjectSessions}
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
              onReveal={handleRevealProject}
              onArchive={props.onArchiveSession}
              onRegenerateTitle={props.onRegenerateTitle ? handleRegenerateTitle : undefined}
            />
          );
        case 'more':
          return (
            <div className={styles.more} onClick={() => handleShowAll(item.cwd)}>
              查看剩余 {item.remaining} 条
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
      handleNewConversation,
      newProjectMenu,
      toggleSectionCollapsed,
      props.onOpenSession,
      props.onDeleteConversation,
      props.onNewSession,
      props.onClearProjectSessions,
      props.onRemoveProject,
      props.onDeleteSession,
      props.onArchiveSession,
      props.onArchiveConversation,
      props.onRegenerateTitle,
      handleRegenerateTitle,
      handleSubmitRename,
      handleRequestRename,
      toggleCollapsed,
      togglePinnedProject,
      togglePinnedConversation,
      togglePinnedSession,
      pinnedConversations,
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
            {(item: SidebarItem) => (
              <div
                key={item.key}
                onPointerEnter={() => {
                  // 只有会话行预热：项目行点了只是展开。划过不预热，停住才建，见 HOVER_PREWARM_DWELL_MS。
                  const cwd = item.type === 'conversation' || item.type === 'session' ? cwdOfItem(item) : undefined;
                  if (cwd) startHoverPrewarm(cwd);
                  else cancelHoverPrewarm();
                }}
                onPointerLeave={cancelHoverPrewarm}
                // 点下去就是要打开它，打开会话自己会建运行时，不要再让悬停计时在切换中途触发。
                onPointerDown={cancelHoverPrewarm}
              >
                {renderItem(item)}
              </div>
            )}
          </VList>
        )}
      </div>
      {props.onUnarchiveSession ? (
        <ArchivedSessions onUnarchive={props.onUnarchiveSession} onDelete={props.onDeleteSession} />
      ) : null}
      <Modal
        open={aliasEdit != null}
        title="项目别名"
        okText="确定"
        cancelText="取消"
        centered
        onCancel={() => setAliasEdit(null)}
        onOk={submitAlias}
      >
        <Input
          value={aliasValue}
          placeholder="留空恢复默认"
          onChange={(event) => setAliasValue(event.target.value)}
          onPressEnter={submitAlias}
        />
      </Modal>
    </Flexbox>
  );
});
