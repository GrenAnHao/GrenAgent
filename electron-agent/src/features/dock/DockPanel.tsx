import { useCallback, useMemo } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { cx } from 'antd-style';
import { PanelRightClose } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import { useDockStore, type DockRegion, type DockTab, type SubAgentPayload } from '../../stores/dockStore';
import { dockTabStyles, resolveTone } from './dockTabStyles';
import { TabStrip } from './TabStrip';
import { TabBodyStack } from './TabBodyStack';
import { DockLauncher } from './DockLauncher';
import { DockStripAddMenu } from './DockStripAddMenu';
import { DockTabSwitcher } from './DockTabSwitcher';

interface DockPanelProps {
  region: DockRegion;
  onCollapse?: () => void;
}

export function DockPanel({ region, onCollapse }: DockPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const allTabs = useDockStore((s) => s.tabs);
  const activeByRegion = useDockStore((s) => s.activeByRegion);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);

  const subAgentStatus = useMemo(() => {
    const map: Record<string, 'running' | 'done' | 'error'> = {};
    for (const m of messages) {
      if (m.kind === 'tool' && m.toolName === 'spawn_agent') map[m.id] = m.status;
    }
    return map;
  }, [messages]);

  const tabs = useMemo(
    () => allTabs.filter((t) => t.region === region).sort((a, b) => a.order - b.order),
    [allTabs, region],
  );
  const activeId = activeByRegion[region] ?? tabs.at(-1)?.id ?? null;

  const toneOf = useCallback(
    (tab: DockTab) =>
      resolveTone(
        tab,
        tab.kind === 'subagent' ? subAgentStatus[(tab.payload as SubAgentPayload).messageId] : undefined,
      ),
    [subAgentStatus],
  );

  const actions = onCollapse ? (
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

  if (tabs.length === 0) {
    return (
      <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
        {onCollapse ? (
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
        onClose={closeTab}
        leading={<DockTabSwitcher region={region} tabs={tabs} onActivate={(id) => setActive(region, id)} onClose={closeTab} />}
        trailing={<DockStripAddMenu region={region} />}
        actions={actions}
      />
      <TabBodyStack tabs={tabs} activeId={activeId} emptyHint="" />
    </Flexbox>
  );
}
