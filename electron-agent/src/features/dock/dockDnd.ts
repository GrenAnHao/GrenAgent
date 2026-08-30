import type { Modifier } from '@dnd-kit/core';
import { TITLE_BAR_HEIGHT } from '../../components/titlebarConstants';
import type { DockRegion, DockTab } from '../../stores/dockStore';

/** 限制拖拽浮层留在窗口内，且顶部不越过 titlebar。 */
export const restrictToWindowBelowTitlebar: Modifier = ({ transform, draggingNodeRect, windowRect }) => {
  if (!draggingNodeRect || !windowRect) return transform;
  const value = { ...transform };
  if (draggingNodeRect.top + value.y < TITLE_BAR_HEIGHT) {
    value.y = TITLE_BAR_HEIGHT - draggingNodeRect.top;
  } else if (draggingNodeRect.bottom + value.y > windowRect.height) {
    value.y = windowRect.height - draggingNodeRect.bottom;
  }
  if (draggingNodeRect.left + value.x < 0) {
    value.x = -draggingNodeRect.left;
  } else if (draggingNodeRect.right + value.x > windowRect.width) {
    value.x = windowRect.width - draggingNodeRect.right;
  }
  return value;
};

export type DropPlan =
  | { type: 'reorder'; region: DockRegion; from: number; to: number }
  | { type: 'move'; id: string; region: DockRegion; insertIndex: number };

function regionOf(overId: string, tabs: DockTab[]): DockRegion | null {
  if (overId === 'dock:right') return 'right';
  if (overId === 'dock:bottom') return 'bottom';
  return tabs.find((t) => t.id === overId)?.region ?? null;
}

/**
 * 纯决策：给定拖起 tab 与落点（兄弟 tab id 或 `dock:<region>`），返回应执行的操作。
 * 返回 null 表示忽略（无效落点 / 同位 / 终端拖出底坞）。
 */
export function planDrop(tabs: DockTab[], activeId: string, overId: string): DropPlan | null {
  const activeTab = tabs.find((t) => t.id === activeId);
  if (!activeTab) return null;

  const targetRegion = regionOf(overId, tabs) ?? activeTab.region;
  // 终端钉底坞：不可移入其它坞。
  if (activeTab.kind === 'terminal' && targetRegion !== 'bottom') return null;

  const overTab = tabs.find((t) => t.id === overId) ?? null;

  if (targetRegion === activeTab.region) {
    const inRegion = tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
    const from = inRegion.findIndex((t) => t.id === activeId);
    const to = overTab ? inRegion.findIndex((t) => t.id === overTab.id) : inRegion.length - 1;
    if (from < 0 || to < 0 || from === to) return null;
    return { type: 'reorder', region: targetRegion, from, to };
  }

  const inTarget = tabs.filter((t) => t.region === targetRegion).sort((a, b) => a.order - b.order);
  const insertIndex = overTab ? inTarget.findIndex((t) => t.id === overTab.id) : inTarget.length;
  return { type: 'move', id: activeId, region: targetRegion, insertIndex: insertIndex < 0 ? inTarget.length : insertIndex };
}
