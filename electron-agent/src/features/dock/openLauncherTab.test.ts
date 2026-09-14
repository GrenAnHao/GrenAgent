import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore, defaultTerminalTitle } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { fileTabId, openLauncherTab, reviewTabId } from './openLauncherTab';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('openLauncherTab', () => {
  beforeEach(reset);

  it('opens browser and terminal as new tabs in the launcher region', () => {
    openLauncherTab({ region: 'bottom', kind: 'browser' });
    openLauncherTab({ region: 'bottom', kind: 'browser' });
    openLauncherTab({ region: 'bottom', kind: 'terminal' });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.filter((t) => t.kind === 'browser')).toHaveLength(2);
    expect(tabs.filter((t) => t.kind === 'terminal')).toHaveLength(1);
    expect(tabs.every((t) => t.region === 'bottom')).toBe(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    expect(tabs.find((t) => t.kind === 'terminal')?.title).toBe(defaultTerminalTitle());
  });

  it('reuses file and review tabs in the same region', () => {
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'review', workspace: '/repo' });
    openLauncherTab({ region: 'right', kind: 'review', workspace: '/repo' });
    const tabs = useDockStore.getState().tabs;
    expect(tabs.filter((t) => t.kind === 'file')).toHaveLength(1);
    expect(tabs.filter((t) => t.kind === 'review')).toHaveLength(1);
    expect(tabs[0].id).toBe(fileTabId('right', '/repo'));
    expect(tabs[1].id).toBe(reviewTabId('right'));
    expect(useDockStore.getState().activeByRegion.right).toBe(reviewTabId('right'));
  });

  it('keeps a separate file tab per region', () => {
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    openLauncherTab({ region: 'bottom', kind: 'file', workspace: '/repo' });
    expect(useDockStore.getState().tabs.map((t) => t.id)).toEqual([
      fileTabId('right', '/repo'),
      fileTabId('bottom', '/repo'),
    ]);
  });

  it('does not add a file tab without workspace', () => {
    openLauncherTab({ region: 'right', kind: 'file' });
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('reuses a file tab after it was moved to the other region', () => {
    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    const original = useDockStore.getState().tabs[0];
    useDockStore.getState().moveTabRegion(original.id, 'bottom');
    openLauncherTab({ region: 'bottom', kind: 'file', workspace: '/repo' });
    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].region).toBe('bottom');
    expect(useDockStore.getState().activeByRegion.bottom).toBe(tabs[0].id);

    openLauncherTab({ region: 'right', kind: 'file', workspace: '/repo' });
    const all = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(all).toHaveLength(2);
    expect(all.filter((t) => t.region === 'right')).toHaveLength(1);
    expect(all.filter((t) => t.region === 'bottom')).toHaveLength(1);
    const ids = all.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('reuses a review tab by region after a move, not by stale id', () => {
    openLauncherTab({ region: 'right', kind: 'review' });
    const original = useDockStore.getState().tabs[0];
    useDockStore.getState().moveTabRegion(original.id, 'bottom');
    openLauncherTab({ region: 'bottom', kind: 'review' });
    expect(useDockStore.getState().tabs.filter((t) => t.kind === 'review')).toHaveLength(1);
    openLauncherTab({ region: 'right', kind: 'review' });
    const reviews = useDockStore.getState().tabs.filter((t) => t.kind === 'review');
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews.map((t) => t.id)).size).toBe(2);
  });
});
