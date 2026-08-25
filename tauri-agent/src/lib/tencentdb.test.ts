import { afterEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { coreRequest, tencentdbApi } from './tencentdb';

afterEach(() => vi.clearAllMocks());

describe('TencentDB Core API', () => {
  it('invokes the restricted Core command with route and body', async () => {
    invoke.mockResolvedValue({ count: 3 });

    await expect(
      coreRequest<{ count: number }>('/v3/core/count', { ignoredIdentity: 'value' }),
    ).resolves.toEqual({ count: 3 });
    expect(invoke).toHaveBeenCalledWith('tencentdb_core_request', {
      input: {
        route: '/v3/core/count',
        body: { ignoredIdentity: 'value' },
      },
    });
  });

  it('defaults the body to an empty object through the public API', async () => {
    invoke.mockResolvedValue({});

    await tencentdbApi.coreRequest('/v3/scenario/rm');

    expect(invoke).toHaveBeenCalledWith('tencentdb_core_request', {
      input: { route: '/v3/scenario/rm', body: {} },
    });
  });

  it('reloads managed skills through the dedicated command', async () => {
    invoke.mockResolvedValue(undefined);

    await tencentdbApi.reloadSkills();

    expect(invoke).toHaveBeenCalledWith('tencentdb_reload_skills');
  });

  it('opens the native panel through the managed Tauri command', async () => {
    invoke.mockResolvedValue({ url: 'http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=token' });

    await expect(tencentdbApi.openPanel()).resolves.toEqual({
      url: 'http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=token',
    });
    expect(invoke).toHaveBeenCalledWith('tencentdb_open_panel');
  });
});

describe('TencentDB Knowledge API', () => {
  it('does not expose direct WebView-supplied Wiki file writes', () => {
    expect(tencentdbApi).not.toHaveProperty('writeWikiFiles');
  });

  it('invokes only the typed Wiki and CodeGraph management commands', async () => {
    invoke.mockResolvedValue({});

    await tencentdbApi.getWiki('wiki-1');
    await tencentdbApi.searchWiki('wiki-1', 'release', 15);
    await tencentdbApi.listWikiPages('wiki-1');
    await tencentdbApi.readWikiPages('wiki-1', ['overview']);
    await tencentdbApi.deleteWiki('wiki-1', '/workspace/app');
    await tencentdbApi.getCodeGraph('cg-1');
    await tencentdbApi.searchCodeGraph('cg-1', 'bootstrap', 10);
    await tencentdbApi.exploreCodeGraph('cg-1', 'authentication', 12);
    await tencentdbApi.getCodeGraphCallers('cg-1', 'bootstrap', 25);
    await tencentdbApi.getCodeGraphCallees('cg-1', 'bootstrap', 30);
    await tencentdbApi.analyzeCodeGraphImpact('cg-1', 'bootstrap', 3);
    await tencentdbApi.getCodeGraphNode('cg-1', 'bootstrap', {
      includeCode: true,
      file: 'src/main.ts',
      line: 42,
    });
    await tencentdbApi.getCodeGraphStatus('cg-1');
    await tencentdbApi.listCodeGraphFiles('cg-1', {
      path: 'src',
      pattern: '**/*.ts',
      format: 'flat',
      includeMetadata: false,
      maxDepth: 4,
    });
    await tencentdbApi.deleteCodeGraph('cg-1', '/workspace/app');

    expect(invoke.mock.calls).toEqual([
      ['tencentdb_get_wiki', { input: { assetId: 'wiki-1' } }],
      ['tencentdb_search_wiki', { input: { assetId: 'wiki-1', query: 'release', limit: 15 } }],
      ['tencentdb_list_wiki_pages', { input: { assetId: 'wiki-1' } }],
      ['tencentdb_read_wiki_pages', { input: { assetId: 'wiki-1', refs: ['overview'] } }],
      ['tencentdb_delete_wiki', { input: { assetId: 'wiki-1', workspace: '/workspace/app' } }],
      ['tencentdb_get_code_graph', { input: { assetId: 'cg-1' } }],
      ['tencentdb_search_code_graph', { input: { assetId: 'cg-1', query: 'bootstrap', limit: 10 } }],
      ['tencentdb_explore_code_graph', { input: { assetId: 'cg-1', query: 'authentication', maxFiles: 12 } }],
      ['tencentdb_get_code_graph_callers', { input: { assetId: 'cg-1', symbol: 'bootstrap', limit: 25 } }],
      ['tencentdb_get_code_graph_callees', { input: { assetId: 'cg-1', symbol: 'bootstrap', limit: 30 } }],
      ['tencentdb_analyze_code_graph_impact', { input: { assetId: 'cg-1', symbol: 'bootstrap', depth: 3 } }],
      ['tencentdb_get_code_graph_node', {
        input: {
          assetId: 'cg-1',
          symbol: 'bootstrap',
          includeCode: true,
          file: 'src/main.ts',
          line: 42,
        },
      }],
      ['tencentdb_get_code_graph_status', { input: { assetId: 'cg-1' } }],
      ['tencentdb_list_code_graph_files', {
        input: {
          assetId: 'cg-1',
          path: 'src',
          pattern: '**/*.ts',
          format: 'flat',
          includeMetadata: false,
          maxDepth: 4,
        },
      }],
      ['tencentdb_delete_code_graph', { input: { assetId: 'cg-1', workspace: '/workspace/app' } }],
    ]);
  });
});
