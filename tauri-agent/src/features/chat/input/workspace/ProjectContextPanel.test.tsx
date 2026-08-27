import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, coreRequest, getGitLogGraph, listKnowledgeAssets, listWikiPages, readWikiPages, searchCodeGraph, searchWiki } = vi.hoisted(() => ({
  connection: { status: { state: 'ready' } as { state: string } | null },
  coreRequest: vi.fn(),
  getGitLogGraph: vi.fn(),
  listKnowledgeAssets: vi.fn(),
  listWikiPages: vi.fn(),
  readWikiPages: vi.fn(),
  searchCodeGraph: vi.fn(),
  searchWiki: vi.fn(),
}));

vi.mock('../../../../features/tencentdb/tencentdbApi', () => ({
  tencentdbApi: { coreRequest, listKnowledgeAssets, listWikiPages, readWikiPages, searchCodeGraph, searchWiki },
  useTencentdbConnection: () => connection,
}));

vi.mock('../../../../lib/pi', () => ({ pi: { getGitLogGraph } }));

import { ProjectContextPanel } from './ProjectContextPanel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function assets({ files = 12, nodes = 48 }: { files?: number; nodes?: number } = {}) {
  return {
    codeGraphs: [
      {
        code_graph_id: 'codegraph-current',
        repo_name: 'repo',
        status: 'ready' as const,
        stats: { files, nodes },
      },
    ],
    wikis: [{ wiki_id: 'wiki-current', name: '项目 Wiki', summary: '项目知识说明', page_count: 1, status: 'ready' as const }],
    workspace: { codeGraphId: 'codegraph-current', wikiId: 'wiki-current' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connection.status = { state: 'ready' };
  listKnowledgeAssets.mockResolvedValue(assets());
  listWikiPages.mockResolvedValue({
    items: [{ id: 'overview', title: '项目概览', type: 'page', path: '/overview', description: '当前项目说明' }],
  });
  readWikiPages.mockResolvedValue({ items: [{ ref: '/overview', content: 'Wiki 正文内容' }] });
  searchCodeGraph.mockResolvedValue({ text: 'src/main.ts: bootstrapApp', isError: false });
  searchWiki.mockResolvedValue({
    results: [{ path: '/architecture', title: '架构设计', snippet: '项目架构说明', score: 0.9, type: 'page' }],
    count: 1,
  });
  coreRequest.mockResolvedValue({ messages: [{ id: 'm1', role: 'user', content: '记住项目约定' }] });
  getGitLogGraph.mockResolvedValue([{ hash: 'abc', shortHash: 'abc', parents: [], author: 'Alice', subject: '初始化项目', timestamp: 1700000000, refs: ['HEAD -> main'] }]);
});

afterEach(cleanup);

describe('ProjectContextPanel', () => {
  it('renders inside the right dock surface instead of an independent drawer', async () => {
    render(<ProjectContextPanel active workspace="/repo" />);

    const panel = screen.getByRole('region', { name: 'repo 项目上下文' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(panel).getByText('/repo')).toBeTruthy();
    expect(await within(panel).findByText('1 个 Wiki')).toBeTruthy();
    expect(within(panel).getByText('12 个文件')).toBeTruthy();
    expect(within(panel).getByText('48 个节点')).toBeTruthy();
    expect(listKnowledgeAssets).toHaveBeenCalledWith('/repo');
  });

  it('keeps Wiki reading and CodeGraph search available in the dock panel', async () => {
    render(<ProjectContextPanel active workspace="/repo" />);
    const panel = screen.getByRole('region', { name: 'repo 项目上下文' });
    await within(panel).findByText('1 个 Wiki');

    fireEvent.click(within(panel).getByRole('tab', { name: 'Wiki' }));
    expect(await within(panel).findByText(/项目知识说明/)).toBeTruthy();
    expect(await within(panel).findByText('项目概览')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '阅读项目概览' }));
    expect(await within(panel).findByText('Wiki 正文内容')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('tab', { name: 'CodeGraph' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: '搜索 CodeGraph 符号' }), {
      target: { value: 'bootstrapApp' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '搜索 CodeGraph' }));
    expect(await within(panel).findByText('src/main.ts: bootstrapApp')).toBeTruthy();
  });

  it('shows CodeGraph metadata, searchable memory, and Git history instead of placeholder text', async () => {
    render(<ProjectContextPanel active workspace="/repo" />);
    const panel = screen.getByRole('region', { name: 'repo 项目上下文' });
    await within(panel).findByText('1 个 Wiki');

    fireEvent.click(within(panel).getByRole('tab', { name: 'CodeGraph' }));
    expect(await within(panel).findByText('12 个文件')).toBeTruthy();
    expect(within(panel).getByText('48 个节点')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('tab', { name: '记忆' }));
    expect(await within(panel).findByText('记住项目约定')).toBeTruthy();
    expect(within(panel).getByText(/未按项目路径过滤/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole('tab', { name: 'Git' }));
    expect(await within(panel).findByText('初始化项目')).toBeTruthy();
    expect(getGitLogGraph).toHaveBeenCalledWith('/repo', 40);
  });

  it('shows the disconnected state without loading assets', () => {
    connection.status = null;

    render(<ProjectContextPanel active workspace="/repo" />);

    expect(screen.getByText('TencentDB 知识未连接。')).toBeTruthy();
    expect(listKnowledgeAssets).not.toHaveBeenCalled();
  });

  it('drops stale assets when the dock switches workspace', async () => {
    const repoA = deferred<ReturnType<typeof assets>>();
    listKnowledgeAssets.mockImplementation((workspace: string) => (
      workspace === '/repo-a' ? repoA.promise : Promise.resolve(assets({ files: 7, nodes: 21 }))
    ));
    const view = render(<ProjectContextPanel active workspace="/repo-a" />);
    await waitFor(() => expect(listKnowledgeAssets).toHaveBeenCalledWith('/repo-a'));

    view.rerender(<ProjectContextPanel active workspace="/repo-b" />);
    expect(await screen.findByText('7 个文件')).toBeTruthy();

    repoA.resolve(assets({ files: 99, nodes: 999 }));
    await repoA.promise;
    expect(screen.queryByText('99 个文件')).toBeNull();
  });
});
