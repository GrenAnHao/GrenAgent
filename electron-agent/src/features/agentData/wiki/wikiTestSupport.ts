import { vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import { rawSource, searchResponse, wikiAsset, wikiPage } from './wikiTestData';

export function renderWiki(ui: ReactNode) {
  return render(ui, { wrapper: ({ children }) => createElement(ConfigProvider, { theme: { token: { motion: false } } }, children) });
}

export function mockWikiBrowser() {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })));
}

export function mockWikiApi() {
  mockWikiBrowser();
  const wiki = agentDataApi.wiki;
  vi.spyOn(wiki, 'list').mockResolvedValue([wikiAsset]);
  vi.spyOn(wiki, 'read').mockResolvedValue(wikiAsset);
  vi.spyOn(wiki, 'create').mockResolvedValue(wikiAsset);
  vi.spyOn(wiki, 'update').mockResolvedValue(wikiAsset);
  vi.spyOn(wiki, 'remove').mockResolvedValue(null);
  vi.spyOn(wiki, 'resetDraft').mockResolvedValue(null);
  vi.spyOn(wiki, 'ingest').mockResolvedValue({ kind: 'ok' });
  vi.spyOn(wiki, 'rawWrite').mockResolvedValue(null);
  vi.spyOn(wiki, 'rawRemove').mockResolvedValue(null);
  vi.spyOn(wiki, 'rawList').mockResolvedValue([rawSource]);
  vi.spyOn(wiki, 'rawRead').mockResolvedValue('# 来源正文');
  vi.spyOn(wiki, 'writeTemplate').mockResolvedValue(null);
  vi.spyOn(wiki, 'pageWrite').mockResolvedValue({ lockedInjected: true });
  vi.spyOn(wiki, 'pageRemove').mockResolvedValue(null);
  vi.spyOn(wiki, 'pageList').mockResolvedValue([wikiPage]);
  vi.spyOn(wiki, 'pageRead').mockResolvedValue('# 页面正文');
  vi.spyOn(wiki, 'search').mockResolvedValue(searchResponse);
  vi.spyOn(wiki, 'graph').mockResolvedValue([]);
  vi.spyOn(wiki, 'overview').mockResolvedValue({ pages: 1, latestUpdatedAt: Date.parse(wikiAsset.updatedAt) });
  vi.spyOn(agentDataApi.jobs, 'create').mockRejectedValue(new Error('Unexpected legacy job creation'));
}
