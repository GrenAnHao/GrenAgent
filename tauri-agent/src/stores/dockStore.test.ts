import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore, defaultTerminalTitle } from './dockStore';
import { useLayoutStore } from './layoutStore';
import type { ChatMessage } from './agentReducer';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

const spawn = (id: string, toolCallId: string, task: string): ChatMessage => ({
  kind: 'tool',
  id,
  toolCallId,
  toolName: 'spawn_agent',
  args: { task },
  result: {},
  status: 'running',
});

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

  it('closeTab activates the left neighbor of the closed active tab', () => {
    const s = useDockStore.getState();
    s.openPage({ url: 'https://1', content: '' });
    s.openPage({ url: 'https://2', content: '' });
    s.openPage({ url: 'https://3', content: '' });
    s.setActive('right', 'page:https://2');
    s.closeTab('page:https://2');
    expect(useDockStore.getState().activeByRegion.right).toBe('page:https://1');
  });

  it('moveTabRegion moves a page to bottom and rejects moving a terminal to right', () => {
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
    expect(tab.region).toBe('bottom'); // rejected
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

  it('syncSubAgentTabs adds tabs for spawn_agent messages and removes vanished ones', () => {
    const s = useDockStore.getState();
    s.syncSubAgentTabs([spawn('t1', 'c1', 'first'), { kind: 'tool', id: 'b', toolCallId: 'cb', toolName: 'bash', args: {}, result: {}, status: 'done' }, spawn('t2', 'c2', 'second')]);
    let subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(subs[0].closable).toBe(false);
    expect(subs[0].title).toBe('#1 first');
    expect(subs[1].title).toBe('#2 second');

    s.syncSubAgentTabs([spawn('t1', 'c1', 'first')]);
    subs = useDockStore.getState().tabs.filter((t) => t.kind === 'subagent');
    expect(subs.map((t) => t.id)).toEqual(['t1']);
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
});
