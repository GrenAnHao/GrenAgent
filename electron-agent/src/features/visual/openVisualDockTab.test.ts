import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { closeVisualDockTab, openVisualDockTab, VISUAL_DOCK_TAB_ID } from './openVisualDockTab';

describe('openVisualDockTab', () => {
  beforeEach(() => {
    useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
    useDockStore.getState().addTab({
      id: 'term-1',
      kind: 'terminal',
      region: 'right',
      title: '终端',
      closable: true,
      payload: { status: 'idle' },
    });
    useLayoutStore.setState({ rightPanelOpen: false });
  });

  it('opens a preview tab beside existing right tabs', () => {
    openVisualDockTab(3);
    const tabs = useDockStore.getState().tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['term-1', VISUAL_DOCK_TAB_ID]);
    expect(tabs[1]).toMatchObject({ kind: 'visual', region: 'right', title: '视觉设计', closable: true });
    expect(useDockStore.getState().activeByRegion.right).toBe(VISUAL_DOCK_TAB_ID);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('reuses the same preview tab', () => {
    openVisualDockTab(1);
    openVisualDockTab(2);
    expect(useDockStore.getState().tabs.filter((tab) => tab.kind === 'visual')).toHaveLength(1);
    expect(useDockStore.getState().tabs.find((tab) => tab.id === VISUAL_DOCK_TAB_ID)?.payload).toEqual({ sessionId: 2 });
  });

  it('close removes only the preview tab', () => {
    openVisualDockTab(1);
    closeVisualDockTab();
    expect(useDockStore.getState().tabs.map((tab) => tab.id)).toEqual(['term-1']);
  });
});
