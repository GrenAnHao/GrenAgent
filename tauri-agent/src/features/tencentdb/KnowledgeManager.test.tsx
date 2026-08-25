import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteCodeGraph,
  deleteWiki,
  analyzeCodeGraphImpact,
  exploreCodeGraph,
  getCodeGraph,
  getCodeGraphCallers,
  getCodeGraphCallees,
  getCodeGraphNode,
  getCodeGraphStatus,
  getWiki,
  importWikiFiles,
  listCodeGraphFiles,
  listKnowledgeAssets,
  listWikiPages,
  provisionWorkspaceAssets,
  readWikiPages,
  searchCodeGraph,
  searchWiki,
  syncCodeGraph,
  syncWiki,
} = vi.hoisted(() => ({
  deleteCodeGraph: vi.fn(() => Promise.resolve({ deleted_ids: ['cg-1'] })),
  deleteWiki: vi.fn(() => Promise.resolve({ deleted_ids: ['wiki-1'] })),
  analyzeCodeGraphImpact: vi.fn(() => Promise.resolve({ text: 'bootstrap <- routes', isError: false })),
  exploreCodeGraph: vi.fn(() => Promise.resolve({ text: 'src/main.ts', isError: false })),
  getCodeGraph: vi.fn(() => Promise.resolve({ code_graph_id: 'cg-1', repo_name: 'app', status: 'ready' })),
  getCodeGraphCallers: vi.fn(() => Promise.resolve({ text: 'start -> bootstrap', isError: false })),
  getCodeGraphCallees: vi.fn(() => Promise.resolve({ text: 'bootstrap -> loadConfig', isError: false })),
  getCodeGraphNode: vi.fn(() => Promise.resolve({ text: 'function bootstrap()', isError: false })),
  getCodeGraphStatus: vi.fn(() => Promise.resolve({ text: 'ready', isError: false })),
  getWiki: vi.fn(() => Promise.resolve({ wiki_id: 'wiki-1', name: 'Team Wiki', status: 'ready' })),
  importWikiFiles: vi.fn(() => Promise.resolve({ uploaded: 1, sync: {} })),
  listCodeGraphFiles: vi.fn(() => Promise.resolve({ text: 'src/main.ts', isError: false })),
  listKnowledgeAssets: vi.fn(),
  listWikiPages: vi.fn(() => Promise.resolve({
    items: [{ id: 'overview', title: 'Overview', type: 'guide', path: 'overview.md' }],
  })),
  provisionWorkspaceAssets: vi.fn(() => Promise.resolve({ codeGraphId: 'cg-1', wikiId: 'wiki-1' })),
  readWikiPages: vi.fn(() => Promise.resolve({ items: [{ ref: 'overview', content: '# Overview' }] })),
  searchCodeGraph: vi.fn(() => Promise.resolve({ text: 'bootstrap (function)', isError: false })),
  searchWiki: vi.fn(() => Promise.resolve({
    results: [{ path: 'overview.md', title: 'Overview', snippet: 'Release steps', score: 1, type: 'guide' }],
    count: 1,
  })),
  syncCodeGraph: vi.fn(() => Promise.resolve({})),
  syncWiki: vi.fn(() => Promise.resolve({})),
}));

vi.mock('./tencentdbApi', () => ({
  tencentdbApi: {
    deleteCodeGraph,
    deleteWiki,
    analyzeCodeGraphImpact,
    exploreCodeGraph,
    getCodeGraph,
    getCodeGraphCallers,
    getCodeGraphCallees,
    getCodeGraphNode,
    getCodeGraphStatus,
    getWiki,
    importWikiFiles,
    listCodeGraphFiles,
    listKnowledgeAssets,
    listWikiPages,
    provisionWorkspaceAssets,
    readWikiPages,
    searchCodeGraph,
    searchWiki,
    syncCodeGraph,
    syncWiki,
  },
}));
import { KnowledgeManager } from './KnowledgeManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  listKnowledgeAssets.mockResolvedValue({
    codeGraphs: [{ code_graph_id: 'cg-1', repo_name: 'app', status: 'ready' }],
    wikis: [{ wiki_id: 'wiki-1', name: 'Team Wiki', status: 'ready', page_count: 1 }],
  });
});

describe('KnowledgeManager', () => {
  it('hides the previous workspace assets while the next workspace is loading', async () => {
    const workspaceB = deferred<{
      codeGraphs: Array<{ code_graph_id: string; repo_name: string; status: string }>;
      wikis: never[];
    }>();
    listKnowledgeAssets.mockImplementation((workspace?: string) => (
      workspace === '/workspace/b'
        ? workspaceB.promise
        : Promise.resolve({
          codeGraphs: [{ code_graph_id: 'cg-a', repo_name: 'workspace-a', status: 'ready' }],
          wikis: [],
        })
    ));

    const view = render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/a" />);
    expect(await screen.findByText('workspace-a')).toBeTruthy();

    view.rerender(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/b" />);
    expect(screen.queryByText('workspace-a')).toBeNull();

    await act(async () => {
      workspaceB.resolve({
        codeGraphs: [{ code_graph_id: 'cg-b', repo_name: 'workspace-b', status: 'ready' }],
        wikis: [],
      });
      await workspaceB.promise;
    });
    expect(screen.getByText('workspace-b')).toBeTruthy();
  });

  it('ignores an older asset list after the workspace changes', async () => {
    const workspaceA = deferred<{
      codeGraphs: Array<{ code_graph_id: string; repo_name: string; status: string }>;
      wikis: never[];
    }>();
    listKnowledgeAssets.mockImplementation((workspace?: string) => (
      workspace === '/workspace/a'
        ? workspaceA.promise
        : Promise.resolve({
          codeGraphs: [{ code_graph_id: 'cg-b', repo_name: 'workspace-b', status: 'ready' }],
          wikis: [],
        })
    ));

    const view = render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/a" />);
    await waitFor(() => expect(listKnowledgeAssets).toHaveBeenCalledWith('/workspace/a'));

    view.rerender(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/b" />);
    expect(await screen.findByText('workspace-b')).toBeTruthy();

    await act(async () => {
      workspaceA.resolve({
        codeGraphs: [{ code_graph_id: 'cg-a', repo_name: 'workspace-a', status: 'ready' }],
        wikis: [],
      });
      await workspaceA.promise;
    });

    expect(screen.queryByText('workspace-a')).toBeNull();
    expect(screen.getByText('workspace-b')).toBeTruthy();
  });

  it('ignores a completed sync from the previous workspace', async () => {
    const pendingSync = deferred<Record<string, never>>();
    syncCodeGraph.mockReturnValueOnce(pendingSync.promise);
    listKnowledgeAssets.mockImplementation((workspace?: string) => Promise.resolve({
      codeGraphs: workspace === '/workspace/a'
        ? [{ code_graph_id: 'cg-a', repo_name: 'workspace-a', status: 'ready' }]
        : [{ code_graph_id: 'cg-b', repo_name: 'workspace-b', status: 'ready' }],
      wikis: [],
    }));

    const view = render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/a" />);
    expect(await screen.findByText('workspace-a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新同步' }));
    await waitFor(() => expect(syncCodeGraph).toHaveBeenCalledWith('cg-a'));

    view.rerender(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/b" />);
    expect(await screen.findByText('workspace-b')).toBeTruthy();

    await act(async () => {
      pendingSync.resolve({});
      await pendingSync.promise;
    });

    expect(screen.queryByText('workspace-a')).toBeNull();
    expect(screen.getByText('workspace-b')).toBeTruthy();
    expect(screen.queryByText('已提交重新同步，状态会自动刷新。')).toBeNull();
  });

  it('polls the concrete building asset and stops after it becomes ready', async () => {
    listKnowledgeAssets.mockResolvedValue({
      codeGraphs: [{ code_graph_id: 'cg-1', repo_name: 'app', status: 'processing' }],
      wikis: [],
    });
    const timeout = vi.spyOn(window, 'setTimeout');

    render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/app" />);

    expect(await screen.findByText('app')).toBeTruthy();
    const poll = timeout.mock.calls.find(([, delay]) => delay === 2000)?.[0];
    expect(poll).toBeTypeOf('function');

    await act(async () => {
      await (poll as () => Promise<void>)();
    });

    expect(getCodeGraph).toHaveBeenCalledWith('cg-1');
    expect(await screen.findByText('ready')).toBeTruthy();
    expect(timeout.mock.calls.filter(([, delay]) => delay === 2000)).toHaveLength(1);
  });

  it('clears a pending asset poll when unmounted', async () => {
    const timeout = vi.spyOn(window, 'setTimeout');
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    listKnowledgeAssets.mockResolvedValueOnce({
      codeGraphs: [{ code_graph_id: 'cg-1', repo_name: 'app', status: 'pending' }],
      wikis: [],
    });
    const pending = render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/app" />);

    expect(await screen.findByText('app')).toBeTruthy();
    const pollCallIndex = timeout.mock.calls.findIndex(([, delay]) => delay === 2000);
    expect(pollCallIndex).toBeGreaterThanOrEqual(0);
    const pollTimer = timeout.mock.results[pollCallIndex]?.value;
    pending.unmount();
    expect(clearTimeout).toHaveBeenCalledWith(pollTimer);
  });

  it('does not poll draft Wiki assets', async () => {
    listKnowledgeAssets.mockResolvedValueOnce({
      codeGraphs: [],
      wikis: [{ wiki_id: 'wiki-draft', name: 'Draft Wiki', status: 'draft' }],
    });
    render(<KnowledgeManager kind="wiki" enabled workspace="/workspace/app" />);
    expect(await screen.findByText('Draft Wiki')).toBeTruthy();
    expect(screen.queryByText('构建中，自动刷新')).toBeNull();
  });

  it('delegates Wiki file selection to the backend command', async () => {
    render(<KnowledgeManager kind="wiki" enabled workspace="/workspace/app" />);

    fireEvent.click(await screen.findByRole('button', { name: '导入文档' }));

    await waitFor(() => expect(importWikiFiles).toHaveBeenCalledWith('wiki-1'));
  });

  it('searches Wiki content and reads a selected processed page', async () => {
    render(<KnowledgeManager kind="wiki" enabled workspace="/workspace/app" />);

    fireEvent.click(await screen.findByRole('button', { name: '浏览 Team Wiki' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(listWikiPages).toHaveBeenCalledWith('wiki-1'));

    fireEvent.change(within(dialog).getByPlaceholderText('搜索 Wiki 内容'), { target: { value: 'release' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索 Wiki' }));
    expect(await within(dialog).findByText('Release steps')).toBeTruthy();
    expect(searchWiki).toHaveBeenCalledWith('wiki-1', 'release', 20);

    fireEvent.click(within(dialog).getAllByRole('button', { name: '读取 Overview' })[1]);
    expect(await within(dialog).findByText('# Overview')).toBeTruthy();
    expect(readWikiPages).toHaveBeenCalledWith('wiki-1', ['overview']);
  });

  it('queries and deletes a CodeGraph through typed commands', async () => {
    render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/app" />);

    fireEvent.click(await screen.findByRole('button', { name: '查询 app' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('输入符号'), { target: { value: 'bootstrap' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '执行查询' }));
    expect(await within(dialog).findByText('bootstrap (function)')).toBeTruthy();
    expect(searchCodeGraph).toHaveBeenCalledWith('cg-1', 'bootstrap', 20);

    fireEvent.click(within(dialog).getByRole('button', { name: /关\s*闭/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除 app' }));
    fireEvent.click(await screen.findByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(deleteCodeGraph).toHaveBeenCalledWith('cg-1', '/workspace/app'));
  });

  it('offers every CodeGraph query and sends bounded impact parameters', async () => {
    render(<KnowledgeManager kind="codegraph" enabled workspace="/workspace/app" />);

    fireEvent.click(await screen.findByRole('button', { name: '查询 app' }));
    const dialog = await screen.findByRole('dialog');
    const mode = within(dialog).getByRole('combobox', { name: 'CodeGraph 操作' });
    fireEvent.mouseDown(mode);
    for (const label of ['搜索符号', '探索代码', '查找调用方', '查找被调用方', '影响分析', '节点详情', '索引状态', '文件列表']) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByText('影响分析'));
    fireEvent.change(within(dialog).getByPlaceholderText('输入符号'), { target: { value: 'bootstrap' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '分析深度' }), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '执行查询' }));

    expect(await within(dialog).findByText('bootstrap <- routes')).toBeTruthy();
    expect(analyzeCodeGraphImpact).toHaveBeenCalledWith('cg-1', 'bootstrap', 3);
  });

  it('deletes a Wiki and refreshes the asset list', async () => {
    render(<KnowledgeManager kind="wiki" enabled workspace="/workspace/app" />);

    fireEvent.click(await screen.findByRole('button', { name: '删除 Team Wiki' }));
    fireEvent.click(await screen.findByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(deleteWiki).toHaveBeenCalledWith('wiki-1', '/workspace/app'));
    expect(listKnowledgeAssets.mock.calls.length).toBeGreaterThan(1);
  });
});
