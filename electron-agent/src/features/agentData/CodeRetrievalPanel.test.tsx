// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const monitor = vi.hoisted(() => ({ jobs: [], error: undefined, track: vi.fn(), refresh: vi.fn(), watchedTaskVersion: 0 }));
vi.mock('./AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => monitor }));
vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }] }));
vi.mock('../../lib/agentData', () => ({ agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), search: vi.fn(), call: vi.fn() }, jobs: { create: vi.fn() } } }));
vi.mock('../../lib/files', () => ({ files: { read: vi.fn() } }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn() }));
import { agentDataApi, type CodeGraphStatus } from '../../lib/agentData';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
describe('CodeRetrievalPanel project and status', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    monitor.watchedTaskVersion = 0;
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.status).mockImplementation(async (workspace) => ({ workspace, indexed: true, connected: true }));
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => request.tool === 'codegraph_search'
      ? { structuredContent: [{ file: 'src/a.ts', line: 2, symbol: 'parse' }] }
      : { structuredContent: [] });
  });
  afterEach(cleanup);

  it('requires an explicit real project before querying or creating jobs', async () => {
    render(<CodeRetrievalPanel />);
    expect(screen.getByText('请选择一个项目')).toBeTruthy();
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('queries the selected indexed project without using the legacy search adapter', async () => {
    render(<CodeRetrievalPanel />);
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/alpha' } });
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/proj/alpha', tool: 'codegraph_search', args: { query: 'parse', limit: 20 } });
    expect(agentDataApi.code.search).not.toHaveBeenCalled();
  });

  it('does not query an unindexed project and offers an explicit build action only', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/beta', connected: false, indexed: false });
    render(<CodeRetrievalPanel initialProject="D:/proj/beta" />);
    expect(await screen.findByText('该项目尚未建立 CodeGraph 索引')).toBeTruthy();
    expect(screen.getByRole('button', { name: '建立索引' })).toBeTruthy();
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('preselects the initial project and keeps subsequent manual choices', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/beta' } });
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenLastCalledWith('D:/proj/beta'));
    rerender(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('D:/proj/beta');
  });

  it('rejects a different-project status rather than enabling queries or index writes', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/beta', connected: true, indexed: true });
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/不匹配/);
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '同步索引' })).toBeNull();
    expect(screen.queryByRole('button', { name: '建立索引' })).toBeNull();
  });

  it('keeps unknown project status and missing counts distinct from false and zero', async () => {
    const pending = deferred<CodeGraphStatus>();
    vi.mocked(agentDataApi.code.status).mockReturnValue(pending.promise);
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    expect(screen.getByRole('option', { name: /alpha.*未检查/ })).toBeTruthy();
    expect(screen.queryByText('该项目尚未建立 CodeGraph 索引')).toBeNull();
    await act(async () => { pending.resolve({ workspace: 'D:/proj/alpha', connected: true, indexed: true }); });
    expect(screen.getByText('未提供 / 未提供 / 未提供')).toBeTruthy();
    expect(screen.queryByText('0 / 0 / 0')).toBeNull();
  });

  it('preserves real zero values when the backend explicitly supplies counts', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/alpha', connected: true, indexed: true, files: 0, nodes: 0, edges: 0 });
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    expect(await screen.findByText('0 / 0 / 0')).toBeTruthy();
  });

  it.each([
    ['spawn codegraph ENOENT', 'CLI 不可用'],
    ['Connection refused', 'Connection refused'],
    ['index not found', '索引缺失'],
  ])('shows the real failure without guessing a CLI issue or offering automatic installation: %s', async (message, expected) => {
    vi.mocked(agentDataApi.code.status).mockRejectedValue(new Error(message));
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    expect((await screen.findByRole('alert')).textContent).toContain(expected);
    if (message === 'Connection refused') expect(screen.queryByText(/CLI 不可用/)).toBeNull();
    expect(screen.queryByRole('button', { name: /安装|建立索引|同步索引/ })).toBeNull();
    expect(screen.getByText('尚未获取 CodeGraph 索引状态')).toBeTruthy();
  });

  it('preserves old content and counts on a same-project failed refresh', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/alpha', connected: true, indexed: true, files: 12, nodes: 34, edges: 56 });
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    vi.mocked(agentDataApi.code.status).mockRejectedValue(new Error('Status unavailable'));
    vi.mocked(agentDataApi.code.call).mockRejectedValue(new Error('Search unavailable'));
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    await waitFor(() => expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes('Search unavailable'))).toBe(true));
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('12 / 34 / 56')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '同步索引' })).toBeNull();
  });

  it('does not let an unmounted status response query or replace a new instance', async () => {
    const oldStatus = deferred<CodeGraphStatus>();
    vi.mocked(agentDataApi.code.status).mockReturnValueOnce(oldStatus.promise).mockResolvedValue({ workspace: 'D:/proj/beta', connected: true, indexed: true, files: 8 });
    const { unmount } = render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    unmount();
    render(<CodeRetrievalPanel initialProject="D:/proj/beta" />);
    await screen.findByText('8 / 未提供 / 未提供');
    await act(async () => { oldStatus.resolve({ workspace: 'D:/proj/alpha', connected: true, indexed: true, files: 99 }); });
    expect(screen.queryByText(/99 \/ /)).toBeNull();
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(1);
    expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/proj/beta', tool: 'codegraph_files', args: { format: 'flat' } });
  });

  it('retains previous readable results when an MCP refresh returns an explicit error and no rows', async () => {
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ isError: true, structuredContent: [], content: [{ type: 'text', text: 'Search disconnected' }] });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse again' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Search disconnected');
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText(/保留上次/)).toBeTruthy();
    expect(screen.queryByText('没有匹配结果')).toBeNull();
  });

  it('renders readable unknown content, unknown objects, real emptiness and explicit errors distinctly', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ content: [{ type: 'text', text: 'Readable code context' }] });
    render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await screen.findByText('Readable code context');
    expect(screen.queryByText('没有匹配结果')).toBeNull();
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: { nodes: ['unknown'], edges: [] } });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'object' } });
    await screen.findByText('返回格式未识别，请展开原始结果查看。');
    expect(screen.getByText('原始结果')).toBeTruthy();
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'empty' } });
    await screen.findByText('没有匹配结果');
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ isError: true, structuredContent: [{ file: 'partial.ts' }], content: [{ type: 'text', text: 'connection dropped' }] });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'error' } });
    expect((await screen.findByRole('alert')).textContent).toContain('connection dropped');
    expect(screen.getByText('partial.ts')).toBeTruthy();
    expect(screen.queryByText('没有匹配结果')).toBeNull();
  });
});
