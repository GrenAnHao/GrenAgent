import { describe, expect, it } from 'vitest';
import {
  canonicalBrowserHistoryUrl,
  displayBrowserHistoryUrl,
  listOpenBrowserTabs,
  MAX_BROWSER_HISTORY,
  MAX_BROWSER_HISTORY_SUGGESTIONS,
  rememberBrowserHistory,
  suggestBrowserHistory,
  typedAddressSuggestion,
  type BrowserHistoryEntry,
  type OpenBrowserTab,
} from './browserHistory';

const now = 1_700_000_000_000;

function entry(url: string, title = url, visitedAt = now): BrowserHistoryEntry {
  return { url, title, visitedAt };
}

function tab(partial: Partial<OpenBrowserTab> & Pick<OpenBrowserTab, 'id' | 'url'>): OpenBrowserTab {
  return {
    region: 'right',
    title: partial.title ?? partial.url,
    ...partial,
  };
}

describe('canonicalBrowserHistoryUrl', () => {
  it('keeps http(s) documents and drops hashes', () => {
    expect(canonicalBrowserHistoryUrl('https://Example.COM/path#hash')).toBe('https://example.com/path');
    expect(canonicalBrowserHistoryUrl('http://127.0.0.1:8080/keys')).toBe('http://127.0.0.1:8080/keys');
    expect(canonicalBrowserHistoryUrl('https://example.com')).toBe('https://example.com/');
  });

  it('rejects non-document URLs', () => {
    expect(canonicalBrowserHistoryUrl('about:blank')).toBeNull();
    expect(canonicalBrowserHistoryUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalBrowserHistoryUrl('chrome-error://chromewebdata/')).toBeNull();
  });
});

describe('rememberBrowserHistory', () => {
  it('prepends, dedupes by canonical URL, and refreshes title', () => {
    const first = rememberBrowserHistory([], { url: 'https://example.com/a', title: 'A', visitedAt: 1 });
    const second = rememberBrowserHistory(first, { url: 'https://example.com/b', title: 'B', visitedAt: 2 });
    const again = rememberBrowserHistory(second, { url: 'https://example.com/a#x', title: 'A2', visitedAt: 3 });
    expect(again.map((item) => item.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(again[0]?.title).toBe('A2');
    expect(again[0]?.visitedAt).toBe(3);
  });

  it('ignores blank and illegal URLs', () => {
    expect(rememberBrowserHistory([], { url: 'about:blank', title: 'x' })).toEqual([]);
    expect(rememberBrowserHistory([], { url: 'javascript:alert(1)' })).toEqual([]);
  });

  it(`caps at ${MAX_BROWSER_HISTORY} entries`, () => {
    let entries: BrowserHistoryEntry[] = [];
    for (let index = 0; index < MAX_BROWSER_HISTORY + 5; index += 1) {
      entries = rememberBrowserHistory(entries, {
        url: `https://example.com/${index}`,
        title: String(index),
        visitedAt: index,
      });
    }
    expect(entries).toHaveLength(MAX_BROWSER_HISTORY);
    expect(entries[0]?.url).toBe(`https://example.com/${MAX_BROWSER_HISTORY + 4}`);
  });
});

describe('typedAddressSuggestion', () => {
  it('turns a host into an https navigate row', () => {
    expect(typedAddressSuggestion('123pan.com')).toEqual({
      kind: 'typed',
      url: 'https://123pan.com',
      title: '123pan.com',
    });
  });

  it('returns null for empty or illegal input', () => {
    expect(typedAddressSuggestion('  ')).toBeNull();
    expect(typedAddressSuggestion('javascript:alert(1)')).toBeNull();
  });
});

describe('suggestBrowserHistory', () => {
  const entries = [
    entry('https://123pan.com/', '123云盘'),
    entry('http://127.0.0.1:8080/admin/accounts', '使用记录 - Sub2API'),
    entry('https://zhihu.com/p/1', '知乎文章'),
  ];
  const openTabs = [
    tab({ id: 'current', url: 'https://example.com/', title: '当前页' }),
    tab({ id: 'open-123', url: 'https://123pan.com/', title: '123云盘 - 123pan.com' }),
  ];

  it('puts the typed row first and marks an already-open URL for switching', () => {
    const items = suggestBrowserHistory('123pan.com', entries, openTabs, 'current');
    expect(items[0]).toMatchObject({ kind: 'typed', url: 'https://123pan.com' });
    const open = items.find((item) => item.kind === 'tab');
    expect(open).toMatchObject({
      openTabId: 'open-123',
      openTabRegion: 'right',
      url: 'https://123pan.com/',
    });
    expect(items.some((item) => item.openTabId === 'current')).toBe(false);
  });

  it('filters by query against title or URL', () => {
    const items = suggestBrowserHistory('8080', entries, openTabs, 'current');
    expect(items.some((item) => item.url.includes('8080'))).toBe(true);
    expect(items.some((item) => item.url.includes('zhihu'))).toBe(false);
  });

  it('treats a focused current document URL as recents instead of a filter', () => {
    const items = suggestBrowserHistory(
      'https://example.com/',
      entries,
      openTabs,
      'current',
      'all',
      'https://example.com/',
    );
    expect(items.some((item) => item.kind === 'typed')).toBe(false);
    expect(items.some((item) => item.url.includes('123pan'))).toBe(true);
  });

  it('shows recents when the query is empty', () => {
    const items = suggestBrowserHistory('', entries, openTabs, 'current');
    expect(items.some((item) => item.kind === 'typed')).toBe(false);
    expect(items[0]?.kind).toBe('tab');
    expect(items.map((item) => item.url)).toContain('https://zhihu.com/p/1');
  });

  it('respects history and tabs filters', () => {
    const historyOnly = suggestBrowserHistory('123', entries, openTabs, 'current', 'history');
    expect(historyOnly.every((item) => item.kind !== 'tab' || item.openTabId == null)).toBe(true);
    expect(historyOnly.some((item) => item.kind === 'typed')).toBe(true);

    const tabsOnly = suggestBrowserHistory('123', entries, openTabs, 'current', 'tabs');
    expect(tabsOnly.every((item) => item.kind === 'tab')).toBe(true);
    expect(tabsOnly).toHaveLength(1);
    expect(tabsOnly[0]?.openTabId).toBe('open-123');
  });

  it('caps the visible list', () => {
    const many = Array.from({ length: 40 }, (_, index) => entry(`https://n.test/${index}`, `N${index}`));
    expect(suggestBrowserHistory('', many, [], 'x')).toHaveLength(MAX_BROWSER_HISTORY_SUGGESTIONS);
  });
});

describe('listOpenBrowserTabs', () => {
  it('keeps only browser tabs', () => {
    expect(
      listOpenBrowserTabs([
        { id: 't1', kind: 'terminal', region: 'bottom', title: 'sh', payload: {} },
        {
          id: 'b1',
          kind: 'browser',
          region: 'right',
          title: '主页',
          payload: { url: 'https://a.test/', title: 'A', faviconUrl: 'https://a.test/f.png' },
        },
      ]),
    ).toEqual([
      {
        id: 'b1',
        region: 'right',
        url: 'https://a.test/',
        title: '主页',
        faviconUrl: 'https://a.test/f.png',
      },
    ]);
  });
});

describe('displayBrowserHistoryUrl', () => {
  it('strips the http(s) scheme for the subtitle', () => {
    expect(displayBrowserHistoryUrl('https://127.0.0.1:8080/keys')).toBe('127.0.0.1:8080/keys');
    expect(displayBrowserHistoryUrl('http://example.com/')).toBe('example.com/');
  });
});
