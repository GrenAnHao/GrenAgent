import { currentDockOwner, useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

export const VISUAL_DOCK_TAB_ID = 'visual:panel';

/** 面板预览作为右侧标签打开，不替换整栏。已有则激活并刷新。 */
export function openVisualDockTab(sessionId: number): void {
  const dock = useDockStore.getState();
  const existing = dock.tabs.find((tab) => tab.id === VISUAL_DOCK_TAB_ID);
  if (existing) {
    // 面板预览属于产生它的会话：归属跟着最新一次打开走。
    dock.updateTab(VISUAL_DOCK_TAB_ID, {
      title: '视觉设计',
      payload: { sessionId },
      touchedAt: Date.now(),
      ...currentDockOwner(),
    });
    dock.setActive('right', VISUAL_DOCK_TAB_ID);
    useLayoutStore.getState().setRightPanelOpen(true);
    return;
  }
  dock.addTab({
    id: VISUAL_DOCK_TAB_ID,
    kind: 'visual',
    region: 'right',
    title: '视觉设计',
    closable: true,
    payload: { sessionId },
    ...currentDockOwner(),
  });
}

export function closeVisualDockTab(): void {
  const dock = useDockStore.getState();
  if (dock.tabs.some((tab) => tab.id === VISUAL_DOCK_TAB_ID)) dock.closeTab(VISUAL_DOCK_TAB_ID);
}
