import type { ActionKey } from './config';

export interface ToolbarOverflowResult {
  /** 内联展示的控件（按原始显示顺序）。 */
  visible: ActionKey[];
  /** 收进"更多"溢出菜单的控件（按原始显示顺序，与工具栏保持一致）。 */
  collapsed: ActionKey[];
}

const DEFAULT_WIDTH = 28;

/**
 * 纯函数：按容器宽度决定哪些控件内联展示、哪些收进溢出菜单。
 * 仿 layoutStore 的 resolvePanelVisibility——只在空间不足时按优先级折叠，
 * 宽度恢复后纯派生地还原，不持有任何状态。
 *
 * - containerWidth<=0（尚未量到）：直接全部展示，避免首帧误折叠。
 * - 全部能放下：不折叠，也不显示"更多"按钮。
 * - 放不下：按 priority 顺序逐个收起（不在 priority 中的为主控件，永不折叠），
 *   每收一个就把"更多"按钮宽度计入预留，直到能放下或无可折叠项为止。
 */
export function resolveToolbarOverflow(
  containerWidth: number,
  actions: ActionKey[],
  priority: ActionKey[],
  widths: Partial<Record<ActionKey, number>>,
  moreWidth: number,
): ToolbarOverflowResult {
  if (containerWidth <= 0) return { visible: actions, collapsed: [] };

  const widthOf = (k: ActionKey) => widths[k] ?? DEFAULT_WIDTH;
  const sum = (keys: ActionKey[]) => keys.reduce((acc, k) => acc + widthOf(k), 0);

  if (sum(actions) <= containerWidth) return { visible: actions, collapsed: [] };

  const collapsed = new Set<ActionKey>();
  for (const key of priority) {
    if (!actions.includes(key)) continue;
    collapsed.add(key);
    const visibleWidth = sum(actions.filter((k) => !collapsed.has(k)));
    if (visibleWidth + moreWidth <= containerWidth) break;
  }

  return {
    visible: actions.filter((k) => !collapsed.has(k)),
    collapsed: actions.filter((k) => collapsed.has(k)),
  };
}
