// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const monitor = vi.hoisted(() => ({ jobs: [], error: undefined, track: vi.fn(), refresh: vi.fn(), watchedTaskVersion: 0 }));
const options = vi.hoisted(() => ({ value: [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
vi.mock('./AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => monitor }));
vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => options.value }));
vi.mock('../../lib/agentData', () => ({ agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), search: vi.fn(), call: vi.fn() }, jobs: { create: vi.fn() } } }));
vi.mock('../../lib/files', () => ({ files: { read: vi.fn() } }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn() }));
import { agentDataApi, type CodeGraphStatus } from '../../lib/agentData';
import { files } from '../../lib/files';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const rows = (file: string, symbol?: string) => ({ structuredContent: [{ file, symbol, line: 2 }] });
describe('CodeRetrievalPanel workbench isolation', () => {
  it('revokes a selected project when it disappears from the real options', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    const calls = vi.mocked(agentDataApi.code.call).mock.calls.length;
    options.value = [{ cwd: 'D:/b', name: 'B' }];
    rerender(<CodeRetrievalPanel initialProject="D:/a" />);
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText('src/a.ts')).toBeNull();
    expect(screen.queryByLabelText('搜索代码')).toBeNull();
    expect(screen.queryByRole('button', { name: '同步索引' })).toBeNull();
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel initialProject="D:/a" />);
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(calls);
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('uses the current equivalent option spelling so the selector never looks unselected', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalled());
    options.value = [{ cwd: 'd:\\A\\', name: 'A' }];
    rerender(<CodeRetrievalPanel initialProject="D:/a" />);
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('d:\\A\\');
  });

  beforeEach(() => {
    vi.resetAllMocks(); monitor.watchedTaskVersion = 0;
    options.value = [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }];
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.status).mockImplementation(async (workspace) => ({ workspace, connected: true, indexed: true }));
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => request.tool === 'codegraph_search' ? rows('src/a.ts', 'parse') : { structuredContent: [] });
    vi.mocked(files.read).mockResolvedValue('first\nsource target\nthird');
  });
  afterEach(cleanup);

  it('only lists 51 real options, shows same-name paths and rejects temporary initialProject', async () => {
    options.value = Array.from({ length: 51 }, (_, index) => ({ cwd: `D:/group-${index}/repo`, name: 'repo' }));
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([{ workspace: 'D:/works/temporary', indexed: true }]);
    render(<CodeRetrievalPanel initialProject="D:/works/temporary" />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    expect(screen.getAllByRole('option')).toHaveLength(52);
    expect(screen.getByRole('option', { name: /group-50/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /temporary/ })).toBeNull();
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('');
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('accepts equivalent real initial and status paths', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'd:\\A\\', indexed: true, connected: true });
    render(<CodeRetrievalPanel initialProject={'d:\\a\\'} />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_files', args: { format: 'flat' } }));
  });

  it('uses files for empty query, search for symbols and explore for related context', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_files', args: { format: 'flat' } }));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/a', tool: 'codegraph_search', args: { query: 'parse', limit: 20 } });
    fireEvent.click(screen.getByRole('button', { name: '相关上下文' }));
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/a', tool: 'codegraph_explore', args: { query: 'parse', limit: 20 } }));
    expect(agentDataApi.code.search).not.toHaveBeenCalled();
  });

  it('stores queries per project and clears old results immediately on project switch', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'alpha query' } });
    await screen.findByText('src/a.ts');
    const pending = deferred<CodeGraphStatus>();
    vi.mocked(agentDataApi.code.status).mockReturnValueOnce(pending.promise);
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/b' } });
    expect(screen.queryByText('src/a.ts')).toBeNull();
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('');
    await act(async () => { pending.resolve({ workspace: 'D:/b', connected: true, indexed: true }); });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'beta query' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/a' } });
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('alpha query');
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/b' } });
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('beta query');
  });

  it('ignores a slower old query after the next query has returned', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalled());
    const old = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(old.promise).mockResolvedValue(rows('new.ts'));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'old' } });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'new' } });
    await screen.findByText('new.ts');
    await act(async () => { old.resolve(rows('old.ts')); });
    expect(screen.queryByText('old.ts')).toBeNull();
  });

  it('does not invalidate a pending query by clicking its already active mode', async () => {
    const pending = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValue(pending.promise);
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '符号搜索' }));
    await act(async () => { pending.resolve(rows('current.ts')); });
    expect(screen.getByText('current.ts')).toBeTruthy();
  });

  it('can reselect the same symbol after returning to the list', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    const trigger = await screen.findByRole('button', { name: /parse.*src\/a.ts/ });
    fireEvent.click(trigger);
    await screen.findByText('source target');
    fireEvent.click(trigger);
    await waitFor(() => expect(vi.mocked(agentDataApi.code.call).mock.calls.filter(([request]) => request.tool === 'codegraph_node')).toHaveLength(2));
  });

  it('rejects old status and query responses after another project is selected', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    const oldStatus = deferred<CodeGraphStatus>();
    const oldQuery = deferred<unknown>();
    vi.mocked(agentDataApi.code.status).mockReturnValueOnce(oldStatus.promise).mockResolvedValue({ workspace: 'D:/b', connected: true, indexed: true });
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(oldQuery.promise).mockResolvedValue(rows('beta.ts'));
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/b' } });
    await screen.findByText('beta.ts');
    await act(async () => { oldStatus.resolve({ workspace: 'D:/a', connected: true, indexed: true, files: 99 }); oldQuery.resolve(rows('stale.ts')); });
    expect(screen.queryByText('stale.ts')).toBeNull();
    expect(screen.queryByText(/99 \/ /)).toBeNull();
  });

  it('loads a node with disambiguating file, reads source and restores focus after detail closes', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'parse' } });
    const trigger = await screen.findByRole('button', { name: /parse.*src\/a.ts/ });
    fireEvent.click(trigger);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_node', args: { symbol: 'parse', file: 'src/a.ts', includeCode: true } }));
    await screen.findByText('source target');
    expect(files.read).toHaveBeenCalledWith('D:/a', 'src/a.ts');
    expect(screen.getByTestId('code-source-line-2').getAttribute('aria-current')).toBe('location');
    fireEvent.click(screen.getByRole('button', { name: '返回结果列表' }));
    expect(screen.queryByLabelText('源码预览')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('opens a file-only result without inventing a symbol or relation query', async () => {
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: [{ file: 'src/file.ts' }] });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: /src\/file.ts/ }));
    await screen.findByText('source target');
    expect(screen.getByText('未提供符号，无法查询调用关系。')).toBeTruthy();
    expect(agentDataApi.code.call).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'codegraph_node' }));
    expect(agentDataApi.code.call).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'codegraph_callers' }));
    expect(document.querySelector('[aria-current="location"]')).toBeNull();
  });

  it('isolates slow node responses for identical symbols in different files', async () => {
    const oldNode = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => {
      if (request.tool === 'codegraph_files') return { structuredContent: [{ file: 'a.ts', symbol: 'parse' }, { file: 'b.ts', symbol: 'parse' }] };
      if (request.tool === 'codegraph_node') return request.args.file === 'a.ts' ? oldNode.promise : { content: [{ type: 'text', text: 'beta symbol context' }] };
      return { structuredContent: [] };
    });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: /parse.*a.ts/ }));
    fireEvent.click(screen.getByRole('button', { name: /parse.*b.ts/ }));
    await screen.findByText('beta symbol context');
    await act(async () => { oldNode.resolve({ content: [{ type: 'text', text: 'stale alpha symbol context' }] }); });
    expect(screen.queryByText('stale alpha symbol context')).toBeNull();
    expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_node', args: { symbol: 'parse', file: 'b.ts', includeCode: true } });
  });

  it('reveals explicit node errors instead of hiding them inside collapsed context', async () => {
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => {
      if (request.tool === 'codegraph_files') return rows('a.ts', 'parse');
      if (request.tool === 'codegraph_node') return { isError: true, content: [{ type: 'text', text: 'node connection failed' }] };
      return { structuredContent: [] };
    });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: /parse.*a.ts/ }));
    await waitFor(() => expect(screen.getByText('符号上下文').closest('details')?.open).toBe(true));
    expect(screen.getByRole('alert').textContent).toContain('node connection failed');
  });

  it('rejects in-flight project references and status when hidden', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/a', connected: true, indexed: true, files: 12 });
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    await screen.findByText('12 / 未提供 / 未提供');
    const oldStatus = deferred<CodeGraphStatus>();
    const oldProjects = deferred<{ workspace: string; indexed: boolean }[]>();
    vi.mocked(agentDataApi.code.status).mockReturnValueOnce(oldStatus.promise);
    vi.mocked(agentDataApi.code.projects).mockReturnValueOnce(oldProjects.promise);
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    rerender(<CodeRetrievalPanel visible={false} />);
    await act(async () => {
      oldStatus.resolve({ workspace: 'D:/a', connected: true, indexed: false, files: 99 });
      oldProjects.resolve([{ workspace: 'D:/b', indexed: false }]);
    });
    expect(screen.getByText('12 / 未提供 / 未提供')).toBeTruthy();
    expect(screen.queryByText('该项目尚未建立 CodeGraph 索引')).toBeNull();
    expect(screen.getByRole('option', { name: /B.*未检查/ })).toBeTruthy();
  });

  it('keeps readable same-project content when status and query refresh fail', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    vi.mocked(agentDataApi.code.projects).mockRejectedValue(new Error('projects unavailable'));
    vi.mocked(agentDataApi.code.status).mockRejectedValue(new Error('status unavailable'));
    vi.mocked(agentDataApi.code.call).mockRejectedValue(new Error('query unavailable'));
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    await waitFor(() => expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes('query unavailable'))).toBe(true));
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.queryByText('没有匹配结果')).toBeNull();
  });

  it('preserves selection and scroll across terminal refresh with indexed still true and hidden return', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'parse' } });
    fireEvent.click(await screen.findByRole('button', { name: /parse.*src\/a.ts/ }));
    await screen.findByText('source target');
    const searches = () => vi.mocked(agentDataApi.code.call).mock.calls.filter(([request]) => request.tool === 'codegraph_search').length;
    expect(searches()).toBe(1);
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    await waitFor(() => expect(searches()).toBe(2));
    expect(screen.getByText('source target')).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
    rerender(<CodeRetrievalPanel visible={false} />);
    const callsBefore = vi.mocked(agentDataApi.code.call).mock.calls.length;
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel visible={false} />);
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(callsBefore);
    rerender(<CodeRetrievalPanel />);
    await waitFor(() => expect(searches()).toBe(3));
    expect(screen.getByText('source target')).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('rejects in-flight hidden responses and refreshes once after an initially hidden mount', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" visible={false} />);
    expect(agentDataApi.code.projects).not.toHaveBeenCalled();
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    rerender(<CodeRetrievalPanel />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledTimes(1));
    const old = deferred<unknown>();
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(old.promise).mockResolvedValue(rows('fresh.ts'));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    rerender(<CodeRetrievalPanel visible={false} />);
    await act(async () => { old.resolve(rows('hidden.ts')); });
    expect(screen.queryByText('hidden.ts')).toBeNull();
    rerender(<CodeRetrievalPanel />);
    await screen.findByText('fresh.ts');
    expect(agentDataApi.code.call).toHaveBeenCalledTimes(3);
    expect(agentDataApi.code.status).toHaveBeenCalledTimes(2);
  });
});
