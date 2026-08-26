import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, listKnowledgeAssets, listWikiPages, readWikiPages, searchCodeGraph, searchWiki, session, workspace } = vi.hoisted(() => ({
  connection: { status: { state: 'ready' } as { state: string } | null },
  listKnowledgeAssets: vi.fn(),
  listWikiPages: vi.fn(),
  readWikiPages: vi.fn(),
  searchCodeGraph: vi.fn(),
  searchWiki: vi.fn(),
  session: { worksDir: '/works' },
  workspace: { current: '/repo' },
}));

vi.mock('../../../../lib/pi', () => ({ onPiEvent: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../../store/session', () => ({
  useSessionStore: (selector: (state: { worksDir: string }) => unknown) => selector(session),
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: workspace.current }),
}));
vi.mock('../../../../stores/gitStore', () => ({
  useGitInfo: () => ({ current: '', branches: [] }),
  useGitStore: { getState: () => ({ load: vi.fn() }) },
}));
vi.mock('../../../../features/tencentdb/tencentdbApi', () => ({
  tencentdbApi: { listKnowledgeAssets, listWikiPages, readWikiPages, searchCodeGraph, searchWiki },
  useTencentdbConnection: () => connection,
}));
vi.mock('./TaskTray', () => ({ TaskTray: () => null }));

import { WorkspaceBar } from './WorkspaceBar';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function currentAssets({
  name = '项目 Wiki',
  files = 12,
  nodes = 48,
  wikiStatus = 'ready',
  codeGraphStatus = 'ready',
  codeGraphError,
  workspaceError,
}: {
  name?: string;
  files?: number;
  nodes?: number;
  wikiStatus?: 'draft' | 'pending' | 'processing' | 'ready' | 'failed';
  codeGraphStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  codeGraphError?: string;
  workspaceError?: string;
} = {}) {
  return {
    codeGraphs: [
      {
        code_graph_id: 'codegraph-current',
        repo_name: 'repo',
        status: codeGraphStatus,
        stats: { files, nodes },
        sync_error: codeGraphError,
      },
      { code_graph_id: 'codegraph-other', repo_name: 'other', status: 'ready', stats: { files: 99, nodes: 999 } },
    ],
    wikis: [
      { wiki_id: 'wiki-current', name, status: wikiStatus },
      { wiki_id: 'wiki-other', name: '其他项目知识', status: 'ready' },
    ],
    workspace: { codeGraphId: 'codegraph-current', wikiId: 'wiki-current', error: workspaceError },
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  connection.status = { state: 'ready' };
  session.worksDir = '/works';
  workspace.current = '/repo';
  listKnowledgeAssets.mockResolvedValue(currentAssets());
  listWikiPages.mockResolvedValue({
    items: [{ id: 'overview', title: '项目概览', type: 'page', path: '/overview', description: '当前项目说明' }],
  });
  readWikiPages.mockResolvedValue({ items: [{ ref: '/overview', content: 'Wiki 正文内容' }] });
  searchCodeGraph.mockResolvedValue({ text: 'src/main.ts: bootstrapApp', isError: false });
  searchWiki.mockResolvedValue({ results: [{ path: '/architecture', title: '架构设计', snippet: '项目架构说明', score: 0.9, type: 'page' }], count: 1 });
});

describe('项目上下文卡片', () => {
  it('显示当前项目名称与仅属于该项目的知识摘要', async () => {
    render(<WorkspaceBar />);

    const card = screen.getByTestId('project-context-card');
    expect(within(card).getByText('repo')).toBeTruthy();
    expect(await within(card).findByText('1 篇 Wiki · 12 文件 · 48 节点 · Wiki：已就绪 · CodeGraph：已就绪 · 项目记忆不可用')).toBeTruthy();
    expect(listKnowledgeAssets).toHaveBeenCalledWith('/repo');
    expect(screen.queryByText('其他项目知识')).toBeNull();
  });

  it('在会话工作目录中不显示', () => {
    session.worksDir = '/repo';

    render(<WorkspaceBar />);

    expect(screen.queryByTestId('project-context-card')).toBeNull();
    expect(listKnowledgeAssets).not.toHaveBeenCalled();
  });

  it('TencentDB 未连接时仍可打开卡片占位状态', () => {
    connection.status = null;

    render(<WorkspaceBar />);

    const card = screen.getByRole('button', { name: '打开项目上下文' });
    expect(card).toHaveTextContent('知识未连接');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(listKnowledgeAssets).not.toHaveBeenCalled();
  });

  it('从卡片打开右侧项目抽屉，切换标签并在关闭或工作区切换后清空内容', async () => {
    const view = render(<WorkspaceBar />);

    fireEvent.click(screen.getByRole('button', { name: '打开项目上下文' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'repo 项目上下文');
    expect(within(dialog).getByRole('tablist')).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tab', { name: 'Wiki' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'CodeGraph' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: '记忆' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Git' })).toBeTruthy();
    expect(within(dialog).getByRole('tabpanel')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Wiki' }));
    expect(within(dialog).getByRole('tab', { name: 'Wiki' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByRole('tabpanel')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭项目上下文' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '打开项目上下文' }));
    const reopenedDialog = await screen.findByRole('dialog');
    expect(within(reopenedDialog).getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    expect(within(reopenedDialog).getByRole('tabpanel')).toBeTruthy();
    workspace.current = '/repo-b';
    view.rerender(<WorkspaceBar />);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('复用项目资产展示概览，并加载 Wiki 页面与 CodeGraph 搜索结果', async () => {
    render(<WorkspaceBar />);
    fireEvent.click(screen.getByRole('button', { name: '打开项目上下文' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('1 个 Wiki')).toBeTruthy();
    expect(within(dialog).getByText('12 个文件')).toBeTruthy();
    expect(within(dialog).getByText('48 个节点')).toBeTruthy();
    expect(listKnowledgeAssets).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Wiki' }));
    expect(await within(dialog).findByText('项目概览')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '搜索 Wiki' }), { target: { value: '架构' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索 Wiki' }));
    expect(await within(dialog).findByText('架构设计')).toBeTruthy();
    expect(searchWiki).toHaveBeenCalledWith('wiki-current', '架构', 20);
    fireEvent.click(within(dialog).getByRole('button', { name: '阅读项目概览' }));
    expect(await within(dialog).findByText('Wiki 正文内容')).toBeTruthy();
    expect(readWikiPages).toHaveBeenCalledWith('wiki-current', ['/overview']);

    fireEvent.click(within(dialog).getByRole('tab', { name: 'CodeGraph' }));
    const codeGraphSearch = await within(dialog).findByRole('textbox', { name: '搜索 CodeGraph 符号' });
    fireEvent.change(codeGraphSearch, { target: { value: 'bootstrapApp' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '搜索 CodeGraph' }));
    expect(await within(dialog).findByText('src/main.ts: bootstrapApp')).toBeTruthy();
    expect(searchCodeGraph).toHaveBeenCalledWith('codegraph-current', 'bootstrapApp', 20);
  });

  it('显示当前绑定知识的同步和不可用状态', async () => {
    listKnowledgeAssets.mockResolvedValue(currentAssets({
      wikiStatus: 'processing',
      codeGraphStatus: 'failed',
      codeGraphError: '代码图谱同步失败',
    }));

    render(<WorkspaceBar />);

    expect(await screen.findByText('1 篇 Wiki · 12 文件 · 48 节点 · Wiki：同步中 · CodeGraph：不可用 · 项目知识不可用：代码图谱同步失败 · 项目记忆不可用')).toBeTruthy();
  });

  it('展示工作区知识错误', async () => {
    listKnowledgeAssets.mockResolvedValue(currentAssets({ workspaceError: '工作区资产初始化失败' }));

    render(<WorkspaceBar />);

    expect(await screen.findByText('1 篇 Wiki · 12 文件 · 48 节点 · Wiki：已就绪 · CodeGraph：已就绪 · 项目知识不可用：工作区资产初始化失败 · 项目记忆不可用')).toBeTruthy();
  });

  it('忽略工作区切换后返回的过期知识响应', async () => {
    const workspaceA = deferred<ReturnType<typeof currentAssets>>();
    listKnowledgeAssets.mockImplementation((scope?: string) => (
      scope === '/repo-a' ? workspaceA.promise : Promise.resolve(currentAssets({ name: '项目 B Wiki', files: 7, nodes: 21 }))
    ));
    workspace.current = '/repo-a';
    const view = render(<WorkspaceBar />);
    await waitFor(() => expect(listKnowledgeAssets).toHaveBeenCalledWith('/repo-a'));

    workspace.current = '/repo-b';
    view.rerender(<WorkspaceBar />);
    expect(await screen.findByText('1 篇 Wiki · 7 文件 · 21 节点 · Wiki：已就绪 · CodeGraph：已就绪 · 项目记忆不可用')).toBeTruthy();

    workspaceA.resolve(currentAssets({ name: '过期项目 Wiki' }));
    await workspaceA.promise;

    expect(screen.queryByText('过期项目 Wiki')).toBeNull();
    expect(screen.getByText('1 篇 Wiki · 7 文件 · 21 节点 · Wiki：已就绪 · CodeGraph：已就绪 · 项目记忆不可用')).toBeTruthy();
  });
});
