import { useCallback, useMemo } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { Dropdown } from 'antd';
import { cx } from 'antd-style';
import { PanelRightClose, Plus } from 'lucide-react';
import { useAgentStore } from '../../stores/AgentStoreContext';
import {
  defaultTerminalTitle,
  useDockStore,
  type DockRegion,
  type DockTab,
  type SubAgentPayload,
} from '../../stores/dockStore';
import { dockTabStyles, resolveTone } from './dockTabStyles';
import { TabStrip } from './TabStrip';
import { TabBodyStack } from './TabBodyStack';

interface DockPanelProps {
  region: DockRegion;
  /** 收起本坞外壳（右坞传入）。 */
  onCollapse?: () => void;
}

export function DockPanel({ region, onCollapse }: DockPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const allTabs = useDockStore((s) => s.tabs);
  const activeByRegion = useDockStore((s) => s.activeByRegion);
  const setActive = useDockStore((s) => s.setActive);
  const closeTab = useDockStore((s) => s.closeTab);
  const addTab = useDockStore((s) => s.addTab);

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
        tab.kind === 'subagent'
          ? subAgentStatus[(tab.payload as SubAgentPayload).messageId]
          : undefined,
      ),
    [subAgentStatus],
  );

  const addTerminal = useCallback(() => {
    addTab({
      id: `terminal-${Date.now()}`,
      kind: 'terminal',
      region: 'bottom',
      title: defaultTerminalTitle(),
      closable: true,
      payload: { status: 'idle' },
    });
  }, [addTab]);

  const actions = (
    <>
      {region === 'bottom' ? (
        <ActionIcon icon={Plus} size="small" title="新建终端" onClick={addTerminal} />
      ) : (
        <Dropdown
          trigger={['click']}
          menu={{ items: [{ key: 'hint', disabled: true, label: '从 fetch_url 卡片或 spawn_agent 打开' }] }}
        >
          <ActionIcon icon={Plus} size="small" title="新建" />
        </Dropdown>
      )}
      {onCollapse ? (
        <ActionIcon icon={PanelRightClose} size="small" title="Collapse panel" onClick={onCollapse} />
      ) : null}
    </>
  );

  const emptyHint =
    region === 'bottom'
      ? '没有打开的终端。点击右上角 + 新建。'
      : '暂无内容。点击工具卡片（如 fetch_url 结果）或用 spawn_agent 委派任务，会在这里以独立 tab 打开。';

  return (
    <Flexbox className={cx('dock-panel', dockTabStyles.container)}>
      <TabStrip
        region={region}
        tabs={tabs}
        activeId={activeId}
        toneOf={toneOf}
        onActivate={(id) => setActive(region, id)}
        onClose={closeTab}
        actions={actions}
      />
      <TabBodyStack tabs={tabs} activeId={activeId} emptyHint={emptyHint} />
    </Flexbox>
  );
}
