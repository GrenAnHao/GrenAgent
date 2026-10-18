import { beforeEach, describe, expect, it } from 'vitest';
import { isDockTabVisible, useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSessionStore } from '../../store/session';
import { visualKeyOf, type VisualEntry } from '../../stores/visualStore';
import { closeVisualDockTab, openVisualDockTab, visualTabId } from './openVisualDockTab';

const entryOf = (sessionPath: string, workspace: string, rev: number): VisualEntry => ({
  sessionPath,
  workspace,
  html: '<p>x</p>',
  mode: 'panel',
  rev,
  pending: true,
  requestId: `req-${rev}`,
});

const A = entryOf('C:/ws/a.jsonl', 'C:/ws', 1);
const B = entryOf('C:/other/b.jsonl', 'C:/other', 2);

const view = (e: VisualEntry) => ({ sessionPath: e.sessionPath, workspace: e.workspace });

describe('openVisualDockTab', () => {
  beforeEach(() => {
    useDockStore.setState({
      tabs: [],
      closedTabs: [],
      activeByRegion: { right: null, bottom: null },
      activeBySession: {},
      rightOpenBySession: {},
    });
    useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
    useSessionStore.setState({ activeSessionPath: A.sessionPath, activeWorkspace: A.workspace });
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

  it('opens a preview tab beside existing right tabs, owned by the originating session', () => {
    openVisualDockTab(A);
    const tabs = useDockStore.getState().tabs;
    const id = visualTabId(visualKeyOf(A));
    expect(tabs.map((tab) => tab.id)).toEqual(['term-1', id]);
    expect(tabs[1]).toMatchObject({
      kind: 'visual',
      region: 'right',
      title: '视觉设计',
      closable: true,
      ownerSessionPath: A.sessionPath,
      ownerWorkspace: A.workspace,
      payload: { sessionId: 1, visualKey: visualKeyOf(A) },
    });
    expect(useDockStore.getState().activeByRegion.right).toBe(id);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('reuses the same tab for the same session and refreshes the payload', () => {
    openVisualDockTab(A);
    openVisualDockTab({ ...A, rev: 5 });
    const visual = useDockStore.getState().tabs.filter((tab) => tab.kind === 'visual');
    expect(visual).toHaveLength(1);
    expect(visual[0].payload).toEqual({ sessionId: 5, visualKey: visualKeyOf(A) });
  });

  it('keeps one tab per session; a second session never takes the first one over', () => {
    openVisualDockTab(A);
    useSessionStore.setState({ activeSessionPath: B.sessionPath, activeWorkspace: B.workspace });
    openVisualDockTab(B);
    const visual = useDockStore.getState().tabs.filter((tab) => tab.kind === 'visual');
    expect(visual.map((t) => t.ownerSessionPath)).toEqual([A.sessionPath, B.sessionPath]);
    // 各自只在自己的会话里可见
    expect(visual.map((t) => isDockTabVisible(t, view(A)))).toEqual([true, false]);
    expect(visual.map((t) => isDockTabVisible(t, view(B)))).toEqual([false, true]);
  });

  it('a background session opens its tab quietly: no panel reveal, no activation, remembered for the switch back', () => {
    useSessionStore.setState({ activeSessionPath: B.sessionPath, activeWorkspace: B.workspace });
    useDockStore.setState({ activeByRegion: { right: 'term-1', bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: false });

    openVisualDockTab(A);

    const id = visualTabId(visualKeyOf(A));
    const tab = useDockStore.getState().tabs.find((t) => t.id === id);
    expect(tab).toMatchObject({ ownerSessionPath: A.sessionPath, ownerWorkspace: A.workspace });
    // 当前画面（B）不被打扰
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    expect(useDockStore.getState().activeByRegion.right).toBe('term-1');
    expect(isDockTabVisible(tab!, view(B))).toBe(false);
    // 切回 A 时用的记录
    expect(useDockStore.getState().activeBySession[visualKeyOf(A)]?.right).toBe(id);
    expect(useDockStore.getState().rightOpenBySession[visualKeyOf(A)]).toBe(true);

    useDockStore.getState().switchSessionView(view(B), view(A));
    expect(useDockStore.getState().activeByRegion.right).toBe(id);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('closing a tab of a still-pending design can be restored into the same session, not as a global tab', () => {
    openVisualDockTab(A);
    const id = visualTabId(visualKeyOf(A));
    useDockStore.getState().closeTab(id);
    const closed = useDockStore.getState().closedTabs.find((c) => c.id === id);
    expect(closed).toMatchObject({ ownerSessionPath: A.sessionPath, ownerWorkspace: A.workspace });

    useDockStore.getState().restoreClosedTab(id, closed!.closedAt);
    const restored = useDockStore.getState().tabs.find((t) => t.id === id);
    expect(restored).toMatchObject({ ownerSessionPath: A.sessionPath, ownerWorkspace: A.workspace });
    expect(isDockTabVisible(restored!, view(B))).toBe(false);
  });

  it('close removes only that session\'s preview tab and leaves no restorable husk', () => {
    openVisualDockTab(A);
    useSessionStore.setState({ activeSessionPath: B.sessionPath, activeWorkspace: B.workspace });
    openVisualDockTab(B);
    closeVisualDockTab(visualKeyOf(A));
    expect(useDockStore.getState().tabs.map((tab) => tab.id)).toEqual(['term-1', visualTabId(visualKeyOf(B))]);
    expect(useDockStore.getState().closedTabs.some((c) => c.id === visualTabId(visualKeyOf(A)))).toBe(false);
  });
});
