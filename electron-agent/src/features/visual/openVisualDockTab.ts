import { isDockOwnerViewed, useDockStore, type DockTab } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { visualKeyOf, type VisualEntry } from '../../stores/visualStore';

const VISUAL_TAB_PREFIX = 'visual:panel:';

/** 每个会话的视觉设计各有一个标签：多个会话并存时不会互相顶掉。 */
export function visualTabId(key: string): string {
  return `${VISUAL_TAB_PREFIX}${key}`;
}

/**
 * 面板预览作为右侧标签打开，不替换整栏。已有则激活并刷新。
 * 标签归属、内容、回写都取自 entry（发起视觉设计的会话），不看当前停在哪个会话。
 */
export function openVisualDockTab(entry: VisualEntry): void {
  const key = visualKeyOf(entry);
  const id = visualTabId(key);
  const owner = { ownerSessionPath: entry.sessionPath, ownerWorkspace: entry.workspace };
  const payload = { sessionId: entry.rev, visualKey: key };
  const dock = useDockStore.getState();
  const existing = dock.tabs.find((tab) => tab.id === id);

  if (!isDockOwnerViewed(owner)) {
    // 发起会话在后台：只把标签记在它名下，不抢当前画面、不展开右面板；
    // 切回那个会话时 switchSessionView 按这里记的激活项和展开态恢复。
    useDockStore.setState((s) => {
      const tabs: DockTab[] = existing
        ? s.tabs.map((tab) => (tab.id === id ? { ...tab, title: '视觉设计', payload, touchedAt: Date.now(), ...owner } : tab))
        : [
            ...s.tabs,
            {
              id,
              kind: 'visual',
              region: 'right',
              title: '视觉设计',
              closable: true,
              order: s.tabs.filter((t) => t.region === 'right').reduce((max, t) => Math.max(max, t.order), -1) + 1,
              payload,
              touchedAt: Date.now(),
              ...owner,
            },
          ];
      return {
        tabs,
        activeBySession: { ...s.activeBySession, [key]: { ...s.activeBySession[key], right: id } },
        rightOpenBySession: { ...s.rightOpenBySession, [key]: true },
      };
    });
    return;
  }

  if (existing) {
    dock.updateTab(id, { title: '视觉设计', payload, touchedAt: Date.now(), ...owner });
    dock.setActive('right', id);
    useLayoutStore.getState().setRightPanelOpen(true);
    return;
  }
  dock.addTab({ id, kind: 'visual', region: 'right', title: '视觉设计', closable: true, payload, ...owner });
}

/** 视觉设计已经结束：「最近关闭」里不再留可恢复的空壳。 */
export function forgetClosedVisualTab(key: string): void {
  const id = visualTabId(key);
  useDockStore.setState((s) => ({ closedTabs: (s.closedTabs ?? []).filter((c) => c.id !== id) }));
}

/** 程序关掉标签（视觉设计已结束），不留恢复项。 */
export function closeVisualDockTab(key: string): void {
  const id = visualTabId(key);
  const dock = useDockStore.getState();
  if (dock.tabs.some((tab) => tab.id === id)) dock.closeTab(id);
  forgetClosedVisualTab(key);
}
