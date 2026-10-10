import { useCallback, useMemo } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { cx } from 'antd-style';
import { PanelRightClose } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import {
  resolveVisibleActive,
  useDockStore,
  visibleRegionTabs,
  type DockRegion,
  type DockTab,
  type SubAgentPayload,
} from '../../stores/dockStore';
import { canCloseDockTab } from './dockCloseGuards';
import { dockTabStyles, resolveTone } from './dockTabStyles';
import { TabStrip } from './TabStrip';
import { TabBodyStack } from './TabBodyStack';
import { DockLauncher } from './DockLauncher';
import { DockStripAddMenu } from './DockStripAddMenu';
import { DockTabSwitcher } from './DockTabSwitcher';
import { RightPanelFillButton } from '../layout/RightPanelFillButton';

interface DockPanelProps {
  region: DockRegion;
  onCollapse?: () => void;
}

export function DockPanel({ region, onCollapse }: DockPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const allTabs = useDockStore((s) => s.tabs);
  const activeByRegion = useDockStore((s) => s.activeByRegion);
  const activeBySession = useDockStore((s) => s.activeBySession);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);
  // 有守卫的标签（文件浏览器有未保存修改）先问用户，答应了再关。
  const requestClose = useCallback(
    (id: string) => {
      void canCloseDockTab(id).then((ok) => {
        if (ok) closeTab(id);
      });
    },
    [closeTab],
  );

  const subAgentStatus = useMemo(() => {
    const map: Record<string, 'running' | 'done' | 'error'> = {};
    for (const m of messages) {
      if (m.kind === 'tool' && m.toolName === 'spawn_agent') map[m.id] = m.status;
    }
    return map;
  }, [messages]);

  // 会话归属 tab（子代理详情等）只在打开它的会话里显示；切走后保留在 store，切回来恢复。
  const view = useMemo(
    () => ({ sessionPath: activeSessionPath || null, workspace: activeWorkspace ?? '' }),
    [activeSessionPath, activeWorkspace],
  );
  const tabs = useMemo(() => visibleRegionTabs(allTabs, region, view), [allTabs, region, view]);
  const activeId = resolveVisibleActive({ activeByRegion, activeBySession }, region, view, tabs);

  const toneOf = useCallback(
    (tab: DockTab) =>
      resolveTone(
        tab,
        tab.kind === 'subagent' ? subAgentStatus[(tab.payload as SubAgentPayload).messageId] : undefined,
      ),
    [subAgentStatus],
  );

  const collapseButton = onCollapse ? (
    <span title="Collapse panel">
      <ActionIcon
        icon={PanelRightClose}
        size="small"
        title="Collapse panel"
        aria-label="Collapse panel"
        onClick={onCollapse}
      />
    </span>
  ) : null;
  const actions = region === 'right' || collapseButton ? (
    <>
      {region === 'right' ? <RightPanelFillButton /> : null}
      {collapseButton}
    </>
  ) : null;

  if (tabs.length === 0) {
    return (
      <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
        {actions ? (
          <div className={dockTabStyles.header}>
            <div className={dockTabStyles.tabs} />
            <div className={dockTabStyles.actions}>{actions}</div>
          </div>
        ) : null}
        <DockLauncher region={region} />
      </Flexbox>
    );
  }

  return (
    <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
      <TabStrip
        region={region}
        tabs={tabs}
        activeId={activeId}
        toneOf={toneOf}
        onActivate={(id) => setActive(region, id)}
        onClose={requestClose}
        leading={<DockTabSwitcher region={region} tabs={tabs} onActivate={(id) => setActive(region, id)} onClose={requestClose} />}
        trailing={<DockStripAddMenu region={region} />}
        actions={actions}
      />
      <TabBodyStack tabs={tabs} activeId={activeId} emptyHint="" />
    </Flexbox>
  );
}
