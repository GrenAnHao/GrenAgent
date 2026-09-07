import { vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import { deletePreview, library, page, source } from './wikiTestData';

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
  const { libraries, sources, pages } = agentDataApi.wiki;
  vi.spyOn(libraries, 'list').mockResolvedValue([library]);
  vi.spyOn(libraries, 'read').mockResolvedValue(library);
  vi.spyOn(libraries, 'create').mockResolvedValue(library);
  vi.spyOn(libraries, 'update').mockResolvedValue(library);
  vi.spyOn(libraries, 'previewDelete').mockResolvedValue(deletePreview);
  vi.spyOn(libraries, 'remove').mockResolvedValue({ state: 'deleted' });
  vi.spyOn(libraries, 'previewIngest').mockResolvedValue({ sourceIds: ['s'], targetCount: 1, model: 'fixture/provider-model' });
  vi.spyOn(libraries, 'ingest').mockResolvedValue({ jobId: 'job-1', targetCount: 1, model: 'fixture/provider-model' });
  vi.spyOn(libraries, 'reindex').mockResolvedValue({ pages: 1, diagnostics: [] });
  vi.spyOn(sources, 'list').mockResolvedValue([source]);
  vi.spyOn(sources, 'read').mockResolvedValue({ source, content: '# 来源正文' });
  vi.spyOn(sources, 'previewImport').mockResolvedValue({ projectWorkspace: 'D:/a', relativePath: 'docs/a.md', name: 'a.md', contentHash: 'import-h', bytes: 17 });
  vi.spyOn(sources, 'create').mockResolvedValue(source);
  vi.spyOn(sources, 'update').mockResolvedValue({ ...source, revision: 2 });
  vi.spyOn(sources, 'previewDelete').mockResolvedValue({ ...deletePreview, name: source.name, target: { kind: 'source', kbId: 'k', sourceId: 's' } });
  vi.spyOn(sources, 'remove').mockResolvedValue({ state: 'deleted' });
  vi.spyOn(pages, 'list').mockResolvedValue([page]);
  vi.spyOn(pages, 'read').mockResolvedValue(page);
  vi.spyOn(pages, 'create').mockResolvedValue(page);
  vi.spyOn(pages, 'update').mockResolvedValue({ ...page, revision: 2 });
  vi.spyOn(pages, 'setLocked').mockResolvedValue({ ...page, locked: false, revision: 2 });
  vi.spyOn(pages, 'previewDelete').mockResolvedValue({ ...deletePreview, name: page.title, target: { kind: 'page', kbId: 'k', pageId: 'p' } });
  vi.spyOn(pages, 'remove').mockResolvedValue({ state: 'deleted' });
  vi.spyOn(agentDataApi.jobs, 'create').mockRejectedValue(new Error('Unexpected legacy job creation'));
}
