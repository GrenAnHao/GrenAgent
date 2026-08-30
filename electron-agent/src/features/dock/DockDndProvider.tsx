import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Icon } from '@lobehub/ui';
import { cx, useTheme } from 'antd-style';
import { Globe, X } from 'lucide-react';
import { useDockStore, type DockTab } from '../../stores/dockStore';
import { dockTabStyles, resolveTone, toneColor } from './dockTabStyles';
import { planDrop, restrictToWindowBelowTitlebar } from './dockDnd';

type AppTheme = ReturnType<typeof useTheme>;

/** 浮层 portal 到 body 后脱离主题容器，色值需用解析后的实色内联。 */
function DockTabOverlay({ tab, theme }: { tab: DockTab; theme: AppTheme }) {
  return (
    <div
      className={cx(dockTabStyles.tab, dockTabStyles.tabActive)}
      style={{
        background: theme.colorBgElevated,
        borderColor: 'transparent',
        boxShadow: theme.boxShadowSecondary,
        color: theme.colorText,
        cursor: 'grabbing',
        opacity: 1,
      }}
    >
      {tab.kind === 'page' ? (
        <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
      ) : (
        <span className={dockTabStyles.statusDot} style={{ background: toneColor(theme, resolveTone(tab)) }} />
      )}
      <span className={dockTabStyles.tabTitle}>{tab.title}</span>
      {tab.closable ? (
        <span className={dockTabStyles.tabClose} style={{ color: theme.colorTextTertiary }}>
          <X size={12} />
        </span>
      ) : (
        <span className={dockTabStyles.tabCloseSpacer} />
      )}
    </div>
  );
}

export function DockDndProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const tabs = useDockStore((s) => s.tabs);
  const reorderTabs = useDockStore((s) => s.reorderTabs);
  const moveTabRegion = useDockStore((s) => s.moveTabRegion);
  const setActive = useDockStore((s) => s.setActive);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const draggingTab = draggingId ? tabs.find((t) => t.id === draggingId) ?? null : null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggingId(null);
    if (!over) return;
    const plan = planDrop(tabs, String(active.id), String(over.id));
    if (!plan) return;
    if (plan.type === 'reorder') {
      reorderTabs(plan.region, plan.from, plan.to);
      setActive(plan.region, String(active.id));
    } else {
      moveTabRegion(plan.id, plan.region, plan.insertIndex);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToWindowBelowTitlebar]}
      onDragStart={(e) => setDraggingId(String(e.active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            <DragOverlay adjustScale={false} dropAnimation={null} zIndex={9999}>
              {draggingTab ? <DockTabOverlay tab={draggingTab} theme={theme} /> : null}
            </DragOverlay>,
            document.body,
          )
        : null}
    </DndContext>
  );
}
