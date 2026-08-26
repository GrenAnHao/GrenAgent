import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, listKnowledgeAssets, session, workspace } = vi.hoisted(() => ({
  connection: { status: { state: 'ready' } as { state: string } | null },
  listKnowledgeAssets: vi.fn(),
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
  tencentdbApi: { listKnowledgeAssets },
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

function currentAssets(name = '项目 Wiki', files = 12, nodes = 48) {
  return {
    codeGraphs: [
      { code_graph_id: 'codegraph-current', repo_name: 'repo', status: 'ready', stats: { files, nodes } },
      { code_graph_id: 'codegraph-other', repo_name: 'other', status: 'ready', stats: { files: 99, nodes: 999 } },
    ],
    wikis: [
      { wiki_id: 'wiki-current', name, status: 'ready' },
      { wiki_id: 'wiki-other', name: '其他项目知识', status: 'ready' },
    ],
    workspace: { codeGraphId: 'codegraph-current', wikiId: 'wiki-current' },
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  connection.status = { state: 'ready' };
  session.worksDir = '/works';
  workspace.current = '/repo';
  listKnowledgeAssets.mockResolvedValue(currentAssets());
});

describe('项目上下文卡片', () => {
  it('显示当前项目名称与仅属于该项目的知识摘要', async () => {
    render(<WorkspaceBar />);

    const card = screen.getByTestId('project-context-card');
    expect(within(card).getByText('repo')).toBeTruthy();
    expect(await within(card).findByText('1 篇 Wiki · 12 文件 · 48 节点')).toBeTruthy();
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

  it('忽略工作区切换后返回的过期知识响应', async () => {
    const workspaceA = deferred<ReturnType<typeof currentAssets>>();
    listKnowledgeAssets.mockImplementation((scope?: string) => (
      scope === '/repo-a' ? workspaceA.promise : Promise.resolve(currentAssets('项目 B Wiki', 7, 21))
    ));
    workspace.current = '/repo-a';
    const view = render(<WorkspaceBar />);
    await waitFor(() => expect(listKnowledgeAssets).toHaveBeenCalledWith('/repo-a'));

    workspace.current = '/repo-b';
    view.rerender(<WorkspaceBar />);
    expect(await screen.findByText('1 篇 Wiki · 7 文件 · 21 节点')).toBeTruthy();

    workspaceA.resolve(currentAssets('过期项目 Wiki'));
    await workspaceA.promise;

    expect(screen.queryByText('过期项目 Wiki')).toBeNull();
    expect(screen.getByText('1 篇 Wiki · 7 文件 · 21 节点')).toBeTruthy();
  });
});
