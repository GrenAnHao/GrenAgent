import { useState } from 'react';
import { ActionIcon, Empty, Flexbox, Icon } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { PanelLeftClose, Settings } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { PanelHeader } from '../../components/PanelHeader';
import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import { useProjectGroups, type ProjectGroup as Group } from './useProjectGroups';
import { SidebarActions } from './SidebarActions';
import { ProjectGroup } from './ProjectGroup';

const useStyles = createStyles(({ token, css }) => ({
  sec: css`
    padding: 12px 14px 4px;
    color: ${token.colorTextTertiary};
    font-size: 10px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  `,
  scroll: css`
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  `,
  foot: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-block-start: 1px solid ${token.colorBorderSecondary};
  `,
  footL: css`
    display: flex;
    align-items: center;
    gap: 8px;
    color: ${token.colorText};
    cursor: pointer;
  `,
}));

export interface SidebarProps {
  runningSessionPath: string | null;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { styles } = useStyles();
  const groups = useProjectGroups();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const prefs = useSidebarPrefsStore();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const pinnedGroups = groups.filter((g) => g.pinned);
  const normalGroups = groups.filter((g) => !g.pinned);

  const renderGroup = (g: Group) => (
    <ProjectGroup
      key={g.cwd}
      group={g}
      expanded={!prefs.isCollapsed(g.cwd, !g.isCurrent)}
      activeSessionPath={activeSessionPath}
      runningSessionPath={props.runningSessionPath}
      renamingPath={renamingPath}
      onToggleExpand={() => prefs.toggleCollapsed(g.cwd, !g.isCurrent)}
      onNewInProject={props.onNewSession}
      onPinProject={prefs.togglePinnedProject}
      onRevealProject={(cwd) => void openPath(cwd)}
      onRenameProject={(cwd) => {
        const next = window.prompt('项目别名（留空恢复默认）', g.name);
        if (next !== null) prefs.setAlias(cwd, next);
      }}
      onHideProject={prefs.hideProject}
      onOpenSession={props.onOpenSession}
      onPinSession={prefs.togglePinnedSession}
      onRequestRename={setRenamingPath}
      onSubmitRename={(path, name) => {
        setRenamingPath(null);
        props.onSubmitRename(g.cwd, path, name);
      }}
      onDeleteSession={props.onDeleteSession}
      isSessionPinned={(path) => prefs.pinnedSessions.includes(path)}
    />
  );

  return (
    <Flexbox height="100%" style={{ minHeight: 0 }}>
      <PanelHeader
        title="Pi Agent"
        actions={<ActionIcon icon={PanelLeftClose} title="收起" onClick={props.onToggleSidebar} />}
      />
      <SidebarActions onNew={() => props.onNewSession(activeWorkspace)} />
      <div className={styles.scroll}>
        {groups.length === 0 && <Empty description="暂无会话" />}
        {pinnedGroups.length > 0 && <div className={styles.sec}>置顶</div>}
        {pinnedGroups.map(renderGroup)}
        {normalGroups.length > 0 && <div className={styles.sec}>项目</div>}
        {normalGroups.map(renderGroup)}
      </div>
      <div className={styles.foot}>
        <span className={styles.footL} onClick={props.onOpenSettings}>
          <Icon icon={Settings} size="small" /> 设置
        </span>
      </div>
    </Flexbox>
  );
}
