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
import { expectSelectDisplay, openSelect, pickSelectOption } from './antdSelectTestUtils';
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
    expectSelectDisplay('项目', '请选择项目');
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
    expectSelectDisplay('项目', /d:\\A\\/);
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
    await openSelect('项目');
    expect(document.querySelectorAll('.ant-select-item-option')).toHaveLength(52);
    expect(screen.getByTitle(/group-50/)).toBeTruthy();
    expect(screen.queryByTitle(/temporary/)).toBeNull();
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('');
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('accepts equivalent real initial and status paths', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'd:\\A\\', indexed: true, connected: true });
    render(<CodeRetrievalPanel initialProject={'d:\\a\\'} />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_files', args: { format: 'flat', limit: 100 } }));
  });

  it('uses files for empty query, search for symbols and explore for related context', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalledWith({ workspace: 'D:/a', tool: 'codegraph_files', args: { format: 'flat', limit: 100 } }));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await screen.findByText('src/a.ts');
    expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/a', tool: 'codegraph_search', args: { query: 'parse', limit: 20 } });
    fireEvent.click(screen.getByRole('radio', { name: '相关上下文' }));
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenLastCalledWith({ workspace: 'D:/a', tool: 'codegraph_explore', args: { query: 'parse', limit: 20 } }));
    expect(agentDataApi.code.search).not.toHaveBeenCalled();
  });

  it('pages a long project file listing instead of rendering every file, and starts over on a new query', async () => {
    const manyFiles = Array.from({ length: 250 }, (_, index) => ({ file: `src/file-${index}.ts` }));
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => request.tool === 'codegraph_files'
      ? { structuredContent: manyFiles }
      : { structuredContent: manyFiles.slice(0, 150).map((row) => ({ ...row, symbol: 'parse' })) });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    await screen.findByText('src/file-0.ts');
    const rendered = () => document.querySelectorAll('[data-code-list] [aria-pressed]').length;
    expect(rendered()).toBe(100);
    expect(screen.getByText('250 个结果')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 150 项）' }));
    expect(rendered()).toBe(200);
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    await waitFor(() => expect(screen.getByText('150 个结果')).toBeTruthy());
    expect(rendered()).toBe(100);
    expect(screen.getByRole('button', { name: '显示更多（还有 50 项）' })).toBeTruthy();
  });

  describe('server-paged file listing', () => {
    const everyFile = Array.from({ length: 250 }, (_, index) => ({ file: `src/file-${index}.ts` }));
    // 主进程报告的总数；测试里改它来模拟两次取页之间索引变了。
    const reported = { total: everyFile.length };
    beforeEach(() => { reported.total = everyFile.length; });
    const filePage = (offset: number, limit: number) => ({
      structuredContent: { schemaVersion: 1, rows: everyFile.slice(offset, offset + limit), nodes: [], edges: [], extra: { page: { offset, total: reported.total } } },
    });
    const filesCalls = () => vi.mocked(agentDataApi.code.call).mock.calls.filter(([request]) => request.tool === 'codegraph_files').map(([request]) => request.args);
    const listed = () => document.querySelectorAll('[data-code-list] [aria-pressed]').length;
    const servePages = () => vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => {
      if (request.tool !== 'codegraph_files') return rows('src/a.ts', 'parse');
      const { offset = 0, limit = everyFile.length } = request.args as { offset?: number; limit?: number };
      return filePage(offset, limit);
    });

    it('asks for one page, shows the real total, and fetches the next page only when asked', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      expect(filesCalls()).toEqual([{ format: 'flat', limit: 100 }]);
      expect(listed()).toBe(100);
      expect(screen.getByText('250 个结果')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 150 项）' }));
      await screen.findByText('src/file-199.ts');
      expect(filesCalls()).toEqual([{ format: 'flat', limit: 100 }, { format: 'flat', limit: 100, offset: 100 }]);
      expect(listed()).toBe(200);
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 50 项）' }));
      await screen.findByText('src/file-249.ts');
      expect(listed()).toBe(250);
      expect(screen.queryByRole('button', { name: /显示更多/ })).toBeNull();
      expect(screen.getByText('250 个结果')).toBeTruthy();
    });

    it('does not start a second fetch while the next page is still on its way', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      const pending = deferred<unknown>();
      vi.mocked(agentDataApi.code.call).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      const waiting = await screen.findByRole('button', { name: '正在加载…' });
      fireEvent.click(waiting);
      expect(filesCalls()).toHaveLength(2);
      await act(async () => { pending.resolve(filePage(100, 100)); });
      await screen.findByText('src/file-100.ts');
    });

    it('drops a late page once the query has changed, so it never lands in the search results', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      const late = deferred<unknown>();
      vi.mocked(agentDataApi.code.call).mockReturnValueOnce(late.promise);
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
      await screen.findByText('parse');
      await act(async () => { late.resolve(filePage(100, 100)); });
      expect(screen.queryByText('src/file-100.ts')).toBeNull();
      expect(listed()).toBe(1);
    });

    it('keeps the loaded rows and offers a retry when the next page fails', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      vi.mocked(agentDataApi.code.call).mockRejectedValueOnce(new Error('index is busy'));
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      expect((await screen.findByRole('alert')).textContent).toContain('index is busy');
      expect(listed()).toBe(100);
      fireEvent.click(screen.getByRole('button', { name: '显示更多（还有 150 项）' }));
      await screen.findByText('src/file-100.ts');
      expect(listed()).toBe(200);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows an MCP error from the next page instead of appending it', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      vi.mocked(agentDataApi.code.call).mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'page unavailable' }] });
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      expect((await screen.findByRole('alert')).textContent).toContain('page unavailable');
      expect(listed()).toBe(100);
    });

    it('starts over from the first page when the total changed between two pages, instead of mixing two index states', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      reported.total = 251;
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      await waitFor(() => expect(filesCalls()).toEqual([{ format: 'flat', limit: 100 }, { format: 'flat', limit: 100, offset: 100 }, { format: 'flat', limit: 100 }]));
      await screen.findByText('251 个结果');
      expect(listed()).toBe(100);
      expect(screen.getByRole('button', { name: '显示更多（还有 151 项）' })).toBeTruthy();
    });

    it('does not refetch, or lose the pages already loaded, when only whitespace is typed', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      await screen.findByText('src/file-199.ts');
      const before = filesCalls().length;
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: '  ' } });
      await act(async () => { await Promise.resolve(); });
      expect(filesCalls()).toHaveLength(before);
      expect(listed()).toBe(200);
    });

    it('keeps a pending search alive when a trailing space is typed after it', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      const pending = deferred<unknown>();
      vi.mocked(agentDataApi.code.call).mockReturnValueOnce(pending.promise);
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse ' } });
      await act(async () => { pending.resolve(rows('src/a.ts', 'parse')); });
      await screen.findByText('src/a.ts');
      expect(vi.mocked(agentDataApi.code.call).mock.calls.filter(([request]) => request.tool === 'codegraph_search')).toHaveLength(1);
    });

    it('does not leave the list loading forever when the mode is flipped while the empty-query listing is in flight', async () => {
      servePages();
      render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
      await screen.findByText('src/a.ts');
      fireEvent.click(screen.getByRole('radio', { name: '相关上下文' }));
      await waitFor(() => expect(vi.mocked(agentDataApi.code.call).mock.lastCall![0].tool).toBe('codegraph_explore'));
      const pending = deferred<unknown>();
      vi.mocked(agentDataApi.code.call).mockReturnValueOnce(pending.promise);
      fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('radio', { name: '符号' }));
      await act(async () => { pending.resolve(filePage(0, 100)); });
      await screen.findByText('src/file-0.ts');
      expect(screen.queryByText('正在查询代码…')).toBeNull();
    });

    it('goes back to the first page when the index refreshes', async () => {
      servePages();
      const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
      await screen.findByText('src/file-0.ts');
      fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
      await screen.findByText('src/file-199.ts');
      monitor.watchedTaskVersion++;
      rerender(<CodeRetrievalPanel initialProject="D:/a" />);
      await waitFor(() => expect(screen.queryByText('src/file-199.ts')).toBeNull());
      expect(listed()).toBe(100);
    });
  });

  it('stores queries per project and clears old results immediately on project switch', async () => {
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.change(await screen.findByLabelText('搜索代码'), { target: { value: 'alpha query' } });
    await screen.findByText('src/a.ts');
    const pending = deferred<CodeGraphStatus>();
    vi.mocked(agentDataApi.code.status).mockReturnValueOnce(pending.promise);
    await pickSelectOption('项目', /^B ·/);
    expect(screen.queryByText('src/a.ts')).toBeNull();
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('');
    await act(async () => { pending.resolve({ workspace: 'D:/b', connected: true, indexed: true }); });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'beta query' } });
    await pickSelectOption('项目', /^A ·/);
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('alpha query');
    await pickSelectOption('项目', /^B ·/);
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
    fireEvent.click(screen.getByRole('radio', { name: '符号' }));
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
    await pickSelectOption('项目', /^B ·/);
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
    await screen.findByText('12 文件');
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
    expect(screen.getByText('12 文件')).toBeTruthy();
    expect(screen.queryByText('这个项目还没有索引')).toBeNull();
    await openSelect('项目');
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
