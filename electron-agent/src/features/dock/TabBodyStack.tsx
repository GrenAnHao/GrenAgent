import { dockTabStyles } from './dockTabStyles';
import { TabBodyRenderer } from './TabBodyRenderer';
import type { DockTab } from '../../stores/dockStore';

interface TabBodyStackProps {
  tabs: DockTab[];
  activeId: string | null;
  emptyHint: string;
}

/** keep-alive：所有 body 常驻挂载，仅切换显隐（终端 xterm 实例昂贵，不可卸载）。 */
export function TabBodyStack({ tabs, activeId, emptyHint }: TabBodyStackProps) {
  return (
    <div className={dockTabStyles.body}>
      {tabs.length === 0 ? <div className={dockTabStyles.empty}>{emptyHint}</div> : null}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={dockTabStyles.bodyItem}
          style={{ display: tab.id === activeId ? 'flex' : 'none' }}
          data-testid={`dock-body-${tab.id}`}
        >
          <TabBodyRenderer tab={tab} active={tab.id === activeId} />
        </div>
      ))}
    </div>
  );
}
