import { isDockOwnerViewed, useDockStore, type DockTab } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { planKeyOf, type PlanOwner } from '../../stores/planStore';

const PLAN_TAB_PREFIX = 'plan:panel:';
const TITLE = '计划';

/** 每个会话一个计划标签：多个会话并存时不会互相顶掉。 */
export function planTabId(key: string): string {
  return `${PLAN_TAB_PREFIX}${key}`;
}

/**
 * 打开（或激活）发起会话的计划面板，落在右侧栏，跟着会话走。
 * 发起会话在后台时只记在它名下，不抢当前画面；切回去时按记下的激活项和展开态恢复。
 */
export function openPlanDockTab(owner: PlanOwner): void {
  const key = planKeyOf(owner);
  const id = planTabId(key);
  const tabOwner = { ownerSessionPath: owner.sessionPath, ownerWorkspace: owner.workspace };
  const payload = { planKey: key };
  const dock = useDockStore.getState();
  const existing = dock.tabs.find((tab) => tab.id === id);

  if (!isDockOwnerViewed(tabOwner)) {
    useDockStore.setState((s) => {
      const tabs: DockTab[] = existing
        ? s.tabs.map((tab) => (tab.id === id ? { ...tab, payload, touchedAt: Date.now(), ...tabOwner } : tab))
        : [
            ...s.tabs,
            {
              id,
              kind: 'plan',
              region: 'right',
              title: TITLE,
              closable: true,
              order: s.tabs.filter((t) => t.region === 'right').reduce((max, t) => Math.max(max, t.order), -1) + 1,
              payload,
              touchedAt: Date.now(),
              ...tabOwner,
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
    dock.updateTab(id, { payload, touchedAt: Date.now(), ...tabOwner });
    dock.setActive('right', id);
    useLayoutStore.getState().setRightPanelOpen(true);
    return;
  }
  dock.addTab({ id, kind: 'plan', region: 'right', title: TITLE, closable: true, payload, ...tabOwner });
}
