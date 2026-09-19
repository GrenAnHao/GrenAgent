import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { dockTabStyles, type DotTone } from './dockTabStyles';
import { SortableDockTab } from './SortableDockTab';
import type { DockRegion, DockTab } from '../../stores/dockStore';

interface TabStripProps {
  region: DockRegion;
  /** 已按 region 过滤并按 order 排序的 tab。 */
  tabs: DockTab[];
  activeId: string | null;
  toneOf: (tab: DockTab) => DotTone;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 标签左侧（标签列表下拉）。 */
  leading?: ReactNode;
  /** 紧挨最后一个标签（新建菜单）。 */
  trailing?: ReactNode;
  /** 右对齐的操作区（折叠按钮）。 */
  actions?: ReactNode;
}

export function TabStrip({
  region,
  tabs,
  activeId,
  toneOf,
  onActivate,
  onClose,
  leading,
  trailing,
  actions,
}: TabStripProps) {
  // 区域级 droppable：拖到 tab 之间空白处也能落入本坞（跨坞互拖需要）。
  const { setNodeRef } = useDroppable({ id: `dock:${region}` });

  return (
    <div className={dockTabStyles.header}>
      {leading != null ? <div className={dockTabStyles.stripChrome}>{leading}</div> : null}
      <div ref={setNodeRef} className={dockTabStyles.tabs} role="tablist" data-testid={`dock-strip-${region}`}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableDockTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              tone={toneOf(tab)}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
            />
          ))}
        </SortableContext>
      </div>
      {trailing != null ? <div className={dockTabStyles.stripChrome}>{trailing}</div> : null}
      {actions != null ? <div className={dockTabStyles.actions}>{actions}</div> : null}
    </div>
  );
}
