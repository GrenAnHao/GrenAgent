import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import wikiRag from './index.js';
import { WikiClient } from './client.js';
import { __resetForTest } from '../_shared/runtime-config.js';

type Tool = Parameters<Parameters<typeof wikiRag>[0]['registerTool']>[0];
type Context = Parameters<Tool['execute']>[4];

function tools(): Record<string, Tool> {
  const registered: Record<string, Tool> = {};
  wikiRag({ registerTool: (tool: Tool) => { registered[tool.name] = tool; } } as never);
  return registered;
}

function context(cwd = '/repo') {
  return { cwd, model: { id: 'fixture', api: 'wiki-test', provider: 'fixture' }, modelRegistry: { complete: vi.fn() } } as unknown as Context;
}

beforeEach(() => {
  vi.stubEnv('PI_RUNTIME_CONFIG', '');
  __resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetForTest();
});

describe('wiki rag extension', () => {
  it('registers only list, read, and search tools', () => {
    expect(Object.keys(tools()).sort()).toEqual(['wiki_list', 'wiki_read', 'wiki_search']);
  });

  it('lists all libraries when wikiId is omitted and pages when wikiId is provided', async () => {
    const libraries = [{ wikiId: 'w1', name: 'Docs' }];
    const pages = [{ id: 'guide', title: 'Guide', type: 'concept', relPath: 'wiki/guide.md' }];
    const request = vi.spyOn(WikiClient.prototype, 'request')
      .mockResolvedValueOnce(libraries)
      .mockResolvedValueOnce(pages);
    const registered = tools();
    const ctx = context();

    const all = await registered.wiki_list.execute('list', {}, undefined, undefined, ctx);
    expect(all.details).toEqual(libraries);
    const one = await registered.wiki_list.execute('list', { wikiId: 'w1' }, undefined, undefined, ctx);
    expect(one.details).toEqual(pages);
    expect(request).toHaveBeenNthCalledWith(1, 'wiki.list', {});
    expect(request).toHaveBeenNthCalledWith(2, 'wiki.pageList', { wikiId: 'w1' });
  });

  it('reads a page by wikiId and ref', async () => {
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValue('# Stored Markdown');
    const registered = tools();
    const ctx = context();

    const read = await registered.wiki_read.execute('read', { wikiId: 'w1', ref: 'guide' }, undefined, undefined, ctx);
    expect(read.content).toEqual([{ type: 'text', text: '# Stored Markdown' }]);
    expect(read.details).toEqual({ content: '# Stored Markdown' });
    expect(request).toHaveBeenCalledExactlyOnceWith('wiki.pageRead', { wikiId: 'w1', ref: 'guide' });
  });

  it('searches with hop, decay, and minScore', async () => {
    const response = { results: [{ path: 'wiki/guide.md', title: 'Guide', snippet: 'text', score: 1, type: 'concept', hop: 0, related: [] }], links: [], count: 1 };
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValue(response);
    const registered = tools();
    const ctx = context();

    const search = await registered.wiki_search.execute('search', {
      wikiId: 'w1', query: '指南', hop: 1, decay: 0.4, minScore: 0.2, limit: 10,
    }, undefined, undefined, ctx);
    expect(search.details).toEqual(response);
    expect(request).toHaveBeenCalledExactlyOnceWith('wiki.search', {
      wikiId: 'w1', query: '指南', limit: 10, hop: 1, decay: 0.4, minScore: 0.2,
    });
  });

  it('rejects hop 6 before calling wiki.search', async () => {
    const request = vi.spyOn(WikiClient.prototype, 'request');
    const registered = tools();
    const ctx = context();

    const result = await registered.wiki_search.execute('search', {
      wikiId: 'w1', query: '指南', hop: 6,
    }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/hop/i) });
    expect(request).not.toHaveBeenCalled();
  });

  it('exposes promptSnippet on each tool and named guidelines on wiki_search', () => {
    const registered = tools();
    for (const name of ['wiki_list', 'wiki_read', 'wiki_search'] as const) {
      expect(registered[name].promptSnippet?.trim().length).toBeGreaterThan(0);
    }
    const guidelines = registered.wiki_search.promptGuidelines ?? [];
    expect(guidelines.length).toBeGreaterThan(0);
    const text = guidelines.join('\n');
    expect(text).toMatch(/wiki_list/);
    expect(text).toMatch(/wiki_search/);
    expect(text).toMatch(/wiki_read/);
    expect(text).toMatch(/wikiId/);
    expect(text).toMatch(/do not guess|don't guess|never guess/i);
  });
});
