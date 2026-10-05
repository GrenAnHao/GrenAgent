import { isAllowedDocumentUrl, normalizeAddressInput } from './browserUrls';

export const MAX_BROWSER_HISTORY = 80;
export const MAX_BROWSER_HISTORY_SUGGESTIONS = 10;

export type AddressSuggestFilter = 'all' | 'history' | 'tabs';

export type BrowserHistoryEntry = {
  url: string;
  title: string;
  faviconUrl?: string;
  visitedAt: number;
};

export type OpenBrowserTab = {
  id: string;
  region: 'right' | 'bottom';
  url: string;
  title: string;
  faviconUrl?: string;
};

export type BrowserHistorySuggestion = {
  kind: 'typed' | 'history' | 'tab';
  url: string;
  title: string;
  faviconUrl?: string;
  openTabId?: string;
  openTabRegion?: OpenBrowserTab['region'];
};

export function canonicalBrowserHistoryUrl(url: string): string | null {
  if (!isAllowedDocumentUrl(url) || url === 'about:blank') return null;
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function displayBrowserHistoryUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

export function typedAddressSuggestion(query: string): BrowserHistorySuggestion | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const url = normalizeAddressInput(trimmed);
  if (!isAllowedDocumentUrl(url) || url === 'about:blank') return null;
  return { kind: 'typed', url, title: trimmed };
}

export function rememberBrowserHistory(
  entries: BrowserHistoryEntry[],
  input: { url: string; title?: string; faviconUrl?: string; visitedAt?: number },
): BrowserHistoryEntry[] {
  const url = canonicalBrowserHistoryUrl(input.url);
  if (!url) return entries;
  const previous = entries.find((item) => item.url === url);
  const title = (input.title || '').trim() || previous?.title || url;
  const faviconUrl = input.faviconUrl || previous?.faviconUrl;
  const visitedAt = input.visitedAt ?? Date.now();
  return [
    { url, title, ...(faviconUrl ? { faviconUrl } : {}), visitedAt },
    ...entries.filter((item) => item.url !== url),
  ].slice(0, MAX_BROWSER_HISTORY);
}

function matchesQuery(query: string, title: string, url: string): boolean {
  if (!query) return true;
  return title.toLowerCase().includes(query) || url.toLowerCase().includes(query);
}

export function suggestBrowserHistory(
  query: string,
  entries: BrowserHistoryEntry[],
  openTabs: OpenBrowserTab[],
  currentTabId: string,
  filter: AddressSuggestFilter = 'all',
  currentPageUrl?: string,
): BrowserHistorySuggestion[] {
  const trimmed = query.trim();
  const pageCanonical = currentPageUrl ? canonicalBrowserHistoryUrl(currentPageUrl) : null;
  const queryCanonical = canonicalBrowserHistoryUrl(trimmed);
  const browsingCurrent = Boolean(pageCanonical && queryCanonical && pageCanonical === queryCanonical);
  const needle = browsingCurrent ? '' : trimmed.toLowerCase();
  const items: BrowserHistorySuggestion[] = [];
  const seen = new Set<string>();
  const typed = filter === 'tabs' || browsingCurrent ? null : typedAddressSuggestion(query);
  if (typed) items.push(typed);

  const others = openTabs.filter((item) => item.id !== currentTabId);

  if (filter !== 'history') {
    for (const open of others) {
      const url = canonicalBrowserHistoryUrl(open.url);
      if (!url || seen.has(url)) continue;
      if (!matchesQuery(needle, open.title, url) && !matchesQuery(needle, open.url, url)) continue;
      seen.add(url);
      items.push({
        kind: 'tab',
        url,
        title: open.title || url,
        faviconUrl: open.faviconUrl,
        openTabId: open.id,
        openTabRegion: open.region,
      });
    }
  }

  if (filter !== 'tabs') {
    for (const entry of entries) {
      const url = canonicalBrowserHistoryUrl(entry.url) || entry.url;
      if (seen.has(url)) continue;
      if (!matchesQuery(needle, entry.title, url) && !matchesQuery(needle, entry.url, url)) continue;
      seen.add(url);
      const open = filter === 'history'
        ? undefined
        : others.find((item) => canonicalBrowserHistoryUrl(item.url) === url);
      items.push({
        kind: open ? 'tab' : 'history',
        url,
        title: entry.title,
        faviconUrl: entry.faviconUrl || open?.faviconUrl,
        openTabId: open?.id,
        openTabRegion: open?.region,
      });
    }
  }

  return items.slice(0, MAX_BROWSER_HISTORY_SUGGESTIONS);
}

export function listOpenBrowserTabs(
  tabs: Array<{
    id: string;
    kind: string;
    region: 'right' | 'bottom';
    title: string;
    payload: { url?: string; title?: string; faviconUrl?: string };
  }>,
): OpenBrowserTab[] {
  return tabs
    .filter((tab) => tab.kind === 'browser')
    .map((tab) => ({
      id: tab.id,
      region: tab.region,
      url: typeof tab.payload?.url === 'string' ? tab.payload.url : '',
      title: tab.title || tab.payload?.title || tab.payload?.url || '',
      faviconUrl: tab.payload?.faviconUrl,
    }));
}
