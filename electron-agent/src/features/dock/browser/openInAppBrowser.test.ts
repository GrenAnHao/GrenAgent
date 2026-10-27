import { beforeEach, describe, expect, it } from 'vitest';
import { useDockStore } from '../../../stores/dockStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { useSessionStore } from '../../../store/session';
import { openInAppBrowser } from './openInAppBrowser';

beforeEach(() => {
  localStorage.clear();
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false });
  useSessionStore.setState({ activeSessionPath: '/s/a.jsonl', activeWorkspace: '/repo' });
});

describe('openInAppBrowser', () => {
  it('新开右侧浏览器标签：标题是主机名，展开右栏并激活', () => {
    expect(openInAppBrowser('https://example.com/docs?a=1')).toBe(true);
    const { tabs, activeByRegion } = useDockStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: 'browser',
      region: 'right',
      title: 'example.com',
      payload: { url: 'https://example.com/docs?a=1' },
    });
    expect(activeByRegion.right).toBe(tabs[0].id);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('同一个地址已经开着：切过去，不重复开', () => {
    openInAppBrowser('https://example.com/a');
    openInAppBrowser('https://other.test/');
    const first = useDockStore.getState().tabs[0].id;
    expect(useDockStore.getState().activeByRegion.right).not.toBe(first);
    openInAppBrowser('https://example.com/a');
    expect(useDockStore.getState().tabs).toHaveLength(2);
    expect(useDockStore.getState().activeByRegion.right).toBe(first);
  });

  it('不同地址各开一个标签', () => {
    openInAppBrowser('https://example.com/a');
    openInAppBrowser('https://example.com/b');
    expect(useDockStore.getState().tabs).toHaveLength(2);
  });

  it('非 http(s) 不开', () => {
    expect(openInAppBrowser('javascript:alert(1)')).toBe(false);
    expect(openInAppBrowser('file:///etc/passwd')).toBe(false);
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });
});
