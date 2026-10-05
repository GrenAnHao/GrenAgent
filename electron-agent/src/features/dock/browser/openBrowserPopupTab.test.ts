// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../../stores/dockStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { openBrowserPopupTab } from './openBrowserPopupTab';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('openBrowserPopupTab', () => {
  beforeEach(reset);

  it('opens beside the source tab and activates it', () => {
    useDockStore.getState().addTab({
      id: 'src',
      kind: 'browser',
      region: 'bottom',
      title: '源',
      closable: true,
      payload: { url: 'https://a.test' },
    });
    openBrowserPopupTab({ url: 'https://b.test', disposition: 'new-window', sourceTabId: 'src' });
    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'browser');
    expect(tabs).toHaveLength(2);
    expect(tabs.every((t) => t.region === 'bottom')).toBe(true);
    expect(useDockStore.getState().activeByRegion.bottom).not.toBe('src');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    expect(tabs.some((t) => (t.payload as { url: string }).url === 'https://b.test')).toBe(true);
  });

  it('falls back to the right dock without a source', () => {
    openBrowserPopupTab({ url: 'https://c.test', disposition: 'default' });
    expect(useDockStore.getState().tabs[0]).toMatchObject({ region: 'right', payload: { url: 'https://c.test' } });
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('drops non-http(s) payloads', () => {
    openBrowserPopupTab({ url: 'about:blank', disposition: 'default' });
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });

  it('does not collide ids for two popups in the same turn', () => {
    openBrowserPopupTab({ url: 'https://a.test', disposition: 'default' });
    openBrowserPopupTab({ url: 'https://b.test', disposition: 'default' });
    const ids = useDockStore.getState().tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});
