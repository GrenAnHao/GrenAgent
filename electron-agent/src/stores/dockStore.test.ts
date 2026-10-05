import { beforeEach, describe, expect, it } from 'vitest';
import {
  useDockStore,
  defaultTerminalTitle,
  subAgentTabId,
  MAX_CLOSED_TABS,
  resolveVisibleActive,
  visibleRegionTabs,
  type DockSessionView,
} from './dockStore';
import { useSessionStore } from '../store/session';
import { useLayoutStore } from './layoutStore';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('dockStore', () => {
  beforeEach(reset);

  it('openPage adds a right page tab, activates it, opens the right panel, and dedupes by url', () => {
    useDockStore.getState().openPage({ url: 'https://a', content: 'first' });
    let tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('page:https://a');
    expect(tabs[0].region).toBe('right');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://a');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    // same url updates payload instead of adding a tab
    useDockStore.getState().openPage({ url: 'https://a', content: 'second' });
    tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect((tabs[0].payload as { content: string }).content).toBe('second');
  });

  it('openProjectContext reuses one right tab and updates it to the current workspace', () => {
    const store = useDockStore.getState();

    store.openProjectContext('/repo-a');
    store.openProjectContext('/repo-b');

    const tabs = useDockStore.getState().tabs.filter((tab) => tab.id === 'project-context');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: 'projectContext',
      region: 'right',
      title: '项目上下文',
      payload: { workspace: '/repo-b' },
    });
    expect(useDockStore.getState().activeByRegion.right).toBe('project-context');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('closeTab activates the left neighbor of the closed active tab', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.openPage({ url: 'https://3', content: '' });
    s.setActive('right', 'page:https://2');
    s.closeTab('page:https://2');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://1');
  });

  it('moveTabRegion moves a page to bottom and allows moving a terminal to right', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://p', content: '' });
    s.moveTabRegion('page:https://p', 'bottom');
    let tab = useDockStore.getState().tabs.find((t) => t.id === 'page:https://p')!;
    expect(tab.region).toBe('bottom');
    expect(useDockStore.getState().activeByRegion.bottom).toBe('page:https://p');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);

    s.addTab({ id: 'term-1', kind: 'terminal', region: 'bottom', title: 'T', closable: true, payload: { status: 'idle' } });
    s.moveTabRegion('term-1', 'right');
    tab = useDockStore.getState().tabs.find((t) => t.id === 'term-1')!;
    expect(tab.region).toBe('right');
    expect(useDockStore.getState().activeByRegion.right).toBe('term-1');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('reorderTabs reorders within a region by index', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.reorderTabs('right', 0, 1);
    const order = useDockStore.getState().tabs
      .filter((t) => t.region === 'right')
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(order).toEqual(['page:https://2', 'page:https://1']);
  });

  it('openSubAgent opens a closable right tab on demand, activates it, and dedupes by (messageId, subIndex)', () => {
    const s = useDockStore.getState();
    s.openSubAgent({ messageId: 't1', toolCallId: 'c1', subIndex: null, title: '#1 first' });
    let subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['t1']);
    expect(subs[0].closable).toBe(true);
    expect(subs[0].title).toBe('#1 first');
    expect(useDockStore.getState().activeByRegion.right).toBe('t1');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    // re-opening the same unit updates the title instead of adding a tab
    s.openSubAgent({ messageId: 't1', toolCallId: 'c1', subIndex: null, title: '#1 renamed' });
    subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs).toHaveLength(1);
    expect(subs[0].title).toBe('#1 renamed');
  });

  it('openSubAgent gives each parallel/chain unit its own tab id and closeTab does not resurrect it', () => {
    const s = useDockStore.getState();
    s.openSubAgent({ messageId: 'm', toolCallId: 'c', subIndex: 0, title: '#1 a' });
    s.openSubAgent({ messageId: 'm', toolCallId: 'c', subIndex: 1, title: '#2 b' });
    let subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual([subAgentTabId('m', 0), subAgentTabId('m', 1)]);
    expect(subs.map((t) => t.id)).toEqual(['m#0', 'm#1']);

    s.closeTab('m#0');
    subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['m#1']);
  });

  it('resetWorkspaceTabs drops terminals (keeping one fresh idle) and keeps page tabs', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://keep', content: '' });
    s.addTab({ id: 'term-1', kind: 'terminal', region: 'bottom', title: defaultTerminalTitle(), closable: true, payload: { status: 'running', shellId: 'sh1' } });
    s.resetWorkspaceTabs();
    const tabs = useDockStore.getState().tabs;
    expect(tabs.some((t) => t.id === 'page:https://keep')).toBe(true);
    const terms = tabs.filter((t) => t.kind === 'terminal');
    expect(terms).toHaveLength(1);
    expect((terms[0].payload as { status: string }).status).toBe('idle');
    expect(terms[0].id).not.toBe('term-1');
  });

  it('accepts file and review tabs with stable ids', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'file:right:/repo',
      kind: 'file',
      region: 'right',
      title: '文件',
      closable: true,
      payload: { workspace: '/repo' },
    });
    s.addTab({
      id: 'review:right',
      kind: 'review',
      region: 'right',
      title: '审查',
      closable: true,
      payload: { workspace: '/repo' },
    });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.map((t) => t.kind)).toEqual(['file', 'review']);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('collapses the right dock when its last tab is closed', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://only', content: '' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    s.closeTab('page:https://only');
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('does not collapse a dock that still has tabs', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.closeTab('page:https://2');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://1');
  });

  it('collapses the source dock after moving its last tab away', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://p', content: '' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    s.moveTabRegion('page:https://p', 'bottom');
    expect(useDockStore.getState().tabs.filter((t) => t.region === 'right')).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('collapses the bottom dock when its last tab is closed', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'term-1',
      kind: 'terminal',
      region: 'bottom',
      title: 'T',
      closable: true,
      payload: { status: 'idle' },
    });
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    s.closeTab('term-1');
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });

  it('retargets source active after moving a tab while siblings remain', () => {
    const s = useDockStore.getState();
    s.addTab({ id: 'term-keep', kind: 'terminal', region: 'bottom', title: 'K', closable: true, payload: { status: 'idle' } });
    s.addTab({ id: 'term-move', kind: 'terminal', region: 'bottom', title: 'M', closable: true, payload: { status: 'idle' } });
    expect(useDockStore.getState().activeByRegion.bottom).toBe('term-move');
    s.moveTabRegion('term-move', 'right');
    expect(useDockStore.getState().tabs.find((t) => t.id === 'term-keep')?.region).toBe('bottom');
    expect(useDockStore.getState().activeByRegion.bottom).toBe('term-keep');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('closeTab records a recently closed snapshot and restoreClosedTab reopens it', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://a', content: 'body', title: 'A' });
    s.closeTab('page:https://a');
    const closed = useDockStore.getState().closedTabs;
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      id: 'page:https://a',
      kind: 'page',
      region: 'right',
      title: 'A',
    });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);

    s.restoreClosedTab(closed[0].id, closed[0].closedAt);
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('page:https://a');
    expect((tabs[0].payload as { content: string }).content).toBe('body');
    expect(useDockStore.getState().closedTabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('does not record subagent tabs as recently closed', () => {
    const s = useDockStore.getState();
    s.openSubAgent({ messageId: 't1', toolCallId: 'c1', subIndex: null, title: '#1 first' });
    s.closeTab('t1');
    expect(useDockStore.getState().closedTabs).toHaveLength(0);
  });

  it('records a terminal as idle without shellId and restores it idle', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'term-1',
      kind: 'terminal',
      region: 'bottom',
      title: 'T',
      closable: true,
      payload: { status: 'running', shellId: 'sh1' },
    });
    s.closeTab('term-1');
    expect(useDockStore.getState().closedTabs[0].payload).toEqual({ status: 'idle' });
    const { id, closedAt } = useDockStore.getState().closedTabs[0];
    s.restoreClosedTab(id, closedAt);
    const term = useDockStore.getState().tabs[0];
    expect(term.kind).toBe('terminal');
    expect(term.payload).toEqual({ status: 'idle' });
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('restoreClosedTab activates a live file tab instead of duplicating', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'file:right:/repo',
      kind: 'file',
      region: 'right',
      title: '文件',
      closable: true,
      payload: { workspace: '/repo' },
    });
    s.closeTab('file:right:/repo');
    const closed = useDockStore.getState().closedTabs[0];
    s.addTab({
      id: 'file:right:/repo#2',
      kind: 'file',
      region: 'right',
      title: '文件',
      closable: true,
      payload: { workspace: '/repo' },
    });
    s.restoreClosedTab(closed.id, closed.closedAt);
    const files = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe('file:right:/repo#2');
    expect(useDockStore.getState().activeByRegion.right).toBe('file:right:/repo#2');
    expect(useDockStore.getState().closedTabs).toHaveLength(0);
  });

  it(`keeps at most ${MAX_CLOSED_TABS} recently closed tabs, newest first`, () => {
    const s = useDockStore.getState();
    for (let i = 0; i < MAX_CLOSED_TABS + 1; i++) {
      s.openPage({ url: `https://u${i}`, content: '' });
    }
    for (let i = 0; i < MAX_CLOSED_TABS + 1; i++) {
      s.closeTab(`page:https://u${i}`);
    }
    const closed = useDockStore.getState().closedTabs;
    expect(closed).toHaveLength(MAX_CLOSED_TABS);
    expect(closed[0].id).toBe(`page:https://u${MAX_CLOSED_TABS}`);
    expect(closed.at(-1)?.id).toBe('page:https://u1');
  });
});

describe('dock persist (重启不还原浏览器标签)', () => {
  beforeEach(reset);

  it('does not persist open or recently closed browser tabs', () => {
    const s = useDockStore.getState();
    s.addTab({
      id: 'browser:1',
      kind: 'browser',
      region: 'right',
      title: '必应',
      closable: true,
      payload: { url: 'https://www.bing.com/', title: '必应' },
    });
    s.addTab({
      id: 'file:right:/repo',
      kind: 'file',
      region: 'right',
      title: '文件',
      closable: true,
      payload: { workspace: '/repo' },
    });
    s.closeTab('browser:1');
    const persisted = useDockStore.persist.getOptions().partialize!(useDockStore.getState());
    expect(persisted.tabs?.some((t) => t.kind === 'browser')).toBe(false);
    expect(persisted.closedTabs?.some((t) => t.kind === 'browser')).toBe(false);
    expect(persisted.tabs?.map((t) => t.id)).toEqual(['file:right:/repo']);
    expect(persisted.activeByRegion?.right).toBe('file:right:/repo');
    expect(useDockStore.getState().closedTabs.some((t) => t.kind === 'browser')).toBe(true);
  });

  it('drops previously persisted browser tabs on rehydrate', () => {
    const merge = useDockStore.persist.getOptions().merge!;
    const merged = merge(
      {
        tabs: [
          {
            id: 'browser:old',
            kind: 'browser',
            region: 'right',
            title: '旧页',
            closable: true,
            order: 0,
            payload: { url: 'https://old.test/', title: '旧页' },
          },
          {
            id: 'file:right:/repo',
            kind: 'file',
            region: 'right',
            title: '文件',
            closable: true,
            order: 1,
            payload: { workspace: '/repo' },
          },
        ],
        closedTabs: [
          {
            id: 'browser:closed',
            kind: 'browser',
            region: 'right',
            title: '关掉的页',
            closable: true,
            payload: { url: 'https://closed.test/' },
            closedAt: 1,
          },
        ],
        activeByRegion: { right: 'browser:old', bottom: null },
      },
      useDockStore.getState(),
    ) as ReturnType<typeof useDockStore.getState>;
    expect(merged.tabs.map((t) => t.id)).toEqual(['file:right:/repo']);
    expect(merged.closedTabs).toEqual([]);
    expect(merged.activeByRegion.right).toBe('file:right:/repo');
  });
});

describe('dockStore session-owned tabs', () => {
  const A = { sessionPath: '/ws/a.jsonl', workspace: '/ws' };
  const B = { sessionPath: '/ws/b.jsonl', workspace: '/ws' };

  beforeEach(() => {
    reset();
    useDockStore.setState({ activeBySession: {}, rightOpenBySession: {} });
    useSessionStore.setState({ activeSessionPath: A.sessionPath, activeWorkspace: '/ws' });
  });

  /** 模拟一次会话切换（与 useDockSessionSwitch 的行为一致）。 */
  function switchTo(next: DockSessionView) {
    const st = useSessionStore.getState();
    const prev = { sessionPath: st.activeSessionPath || null, workspace: st.activeWorkspace };
    useSessionStore.setState({ activeSessionPath: next.sessionPath ?? '', activeWorkspace: next.workspace });
    useDockStore.getState().switchSessionView(prev, next);
  }

  function visibleRight(view: DockSessionView) {
    const s = useDockStore.getState();
    const tabs = visibleRegionTabs(s.tabs, 'right', view);
    return { ids: tabs.map((t) => t.id), active: resolveVisibleActive(s, 'right', view, tabs) };
  }

  it('records the current session as owner when opening a subagent tab', () => {
    useDockStore.getState().openSubAgent({ messageId: 'm1', toolCallId: 'c1', subIndex: 2, title: '#2 子账号' });
    const tab = useDockStore.getState().tabs[0];
    expect(tab.ownerSessionPath).toBe(A.sessionPath);
    expect(tab.ownerWorkspace).toBe('/ws');
  });

  it('hides A-owned tabs in B, closes the right panel, and restores both when switching back', () => {
    useDockStore.getState().openSubAgent({ messageId: 'm1', toolCallId: 'c1', subIndex: 2, title: '#2 子账号' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    switchTo(B);
    expect(visibleRight(B)).toEqual({ ids: [], active: null });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
    // 隐藏而不是删除
    expect(useDockStore.getState().tabs.map((t) => t.id)).toEqual(['m1#2']);

    switchTo(A);
    expect(visibleRight(A)).toEqual({ ids: ['m1#2'], active: 'm1#2' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('keeps global tabs visible across sessions and leaves the panel open', () => {
    useDockStore.getState().openPage({ url: 'https://a', content: 'x' });
    useDockStore.getState().openSubAgentLog({ agentId: 'sa', task: 't', output: '', status: 'done' });
    expect(visibleRight(A).active).toBe('salog:sa');

    switchTo(B);
    expect(visibleRight(B)).toEqual({ ids: ['page:https://a'], active: 'page:https://a' });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);

    switchTo(A);
    expect(visibleRight(A)).toEqual({ ids: ['page:https://a', 'salog:sa'], active: 'salog:sa' });
  });

  it('closing a session-owned tab only falls back to tabs visible in that session', () => {
    useDockStore.getState().openSubAgent({ messageId: 'mA', toolCallId: 'c', subIndex: null, title: 'A' });
    switchTo(B);
    useDockStore.getState().openPage({ url: 'https://b', content: 'x' });
    useDockStore.getState().openSubAgent({ messageId: 'mB', toolCallId: 'c', subIndex: null, title: 'B' });
    useDockStore.getState().closeTab('mB');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://b');
    expect(useDockStore.getState().tabs.some((t) => t.id === 'mA')).toBe(true);
  });

  it('draft owner (null) is only visible in the draft of the same workspace', () => {
    useSessionStore.setState({ activeSessionPath: '', activeWorkspace: '/ws' });
    useDockStore.getState().openSubAgent({ messageId: 'd', toolCallId: 'c', subIndex: null, title: 'D' });
    expect(useDockStore.getState().tabs[0].ownerSessionPath).toBeNull();
    expect(visibleRight({ sessionPath: null, workspace: '/ws' }).ids).toEqual(['d']);
    expect(visibleRight({ sessionPath: null, workspace: '/other' }).ids).toEqual([]);
    expect(visibleRight(A).ids).toEqual([]);
  });

  it('dropSessionTabs removes only the deleted session tabs', () => {
    useDockStore.getState().openSubAgent({ messageId: 'mA', toolCallId: 'c', subIndex: null, title: 'A' });
    useDockStore.getState().openPage({ url: 'https://g', content: 'x' });
    useDockStore.getState().openSubAgent({
      messageId: 'mB', toolCallId: 'c', subIndex: null, title: 'B', ownerSessionPath: B.sessionPath, ownerWorkspace: '/ws',
    });
    useDockStore.getState().dropSessionTabs('\\WS\\a.jsonl');
    expect(useDockStore.getState().tabs.map((t) => t.id).sort()).toEqual(['mB', 'page:https://g']);
  });
});
