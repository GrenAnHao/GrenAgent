// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
vi.mock('../../lib/agentData', () => ({ agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), call: vi.fn() }, jobs: { create: vi.fn() } } }));
vi.mock('../../lib/files', () => ({ files: { read: vi.fn() } }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn() }));
vi.mock('./CodeSourceLines', async () => await import('./codeSourceLinesStub'));
import { agentDataApi } from '../../lib/agentData';
import { files } from '../../lib/files';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
import { scrollToLineSpy } from './codeSourceLinesStub';
import { deferred } from './operationsTestData';
import { task } from './operationsTestData';
import { expectSelectDisplay, pickSelectOption } from './antdSelectTestUtils';

describe('CodeRetrievalPanel resource navigation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.status).mockImplementation(async (workspace) => ({ workspace, connected: true, indexed: true }));
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: [] });
    vi.mocked(files.read).mockResolvedValue('first\ntarget\nlast');
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('selects the equivalent real project and file line without inventing a symbol', async () => {
    render(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'd:\\B\\', file: 'src/a.ts', line: 2 }} navigationRequest={1} />);
    await screen.findByText('target');
    expectSelectDisplay('项目', /^B ·/);
    expect(files.read).toHaveBeenCalledWith('D:/b', 'src/a.ts');
    expect(screen.getByTestId('code-source-line-2').getAttribute('aria-current')).toBe('location');
    expect(agentDataApi.code.call).not.toHaveBeenCalledWith(expect.objectContaining({ tool: 'codegraph_node' }));
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('waits until visible and repeats an explicit request without jumping on ordinary rerenders', async () => {
    const navigation = { view: 'code' as const, workspace: 'D:/a', file: 'a.ts', line: 2 };
    const { rerender } = render(<CodeRetrievalPanel visible={false} navigation={navigation} navigationRequest={1} />);
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
    expect(files.read).not.toHaveBeenCalled();
    rerender(<CodeRetrievalPanel navigation={navigation} navigationRequest={1} />);
    await screen.findByText('target');
    expect(scrollToLineSpy).toHaveBeenCalledTimes(1);
    // 任务视图下线后没有 watchedTaskVersion 回调：普通重渲染不再触发第二次状态读取。
    rerender(<CodeRetrievalPanel navigation={{ ...navigation }} navigationRequest={1} />);
    rerender(<CodeRetrievalPanel navigation={navigation} navigationRequest={1} />);
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledTimes(1));
    expect(scrollToLineSpy).toHaveBeenCalledTimes(1);
    rerender(<CodeRetrievalPanel navigation={navigation} navigationRequest={2} />);
    await waitFor(() => expect(scrollToLineSpy).toHaveBeenCalledTimes(2));
  });

  it('refuses unknown workspaces and outside files without reading or creating tasks', async () => {
    const { rerender } = render(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'D:/removed', file: 'a.ts' }} navigationRequest={1} />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
    expect(agentDataApi.code.call).not.toHaveBeenCalled();
    rerender(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'D:/a', file: '../outside.ts' }} navigationRequest={2} />);
    await screen.findByText('无法确认该文件位于当前项目内，未打开文件。');
    expect(files.read).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('does not open source in an unindexed project', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/a', indexed: false, connected: true });
    render(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'D:/a', file: 'a.ts' }} navigationRequest={1} />);
    await screen.findByText('这个项目还没有索引');
    expect(files.read).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('invalidates the old project reply while retaining each project query', async () => {
    const old = deferred<unknown>();
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    await waitFor(() => expect(agentDataApi.code.call).toHaveBeenCalled());
    vi.mocked(agentDataApi.code.call).mockReturnValueOnce(old.promise).mockResolvedValue({ structuredContent: [] });
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'alpha query' } });
    rerender(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'D:/b', file: 'b.ts' }} navigationRequest={1} />);
    await screen.findByText('target');
    await act(async () => old.resolve({ structuredContent: [{ file: 'stale.ts' }] }));
    expect(screen.queryByText('stale.ts')).toBeNull();
    await pickSelectOption('项目', /^A ·/);
    expect((screen.getByLabelText('搜索代码') as HTMLInputElement).value).toBe('alpha query');
  });

  it('surfaces the sync state banner after starting a sync, without a task list', async () => {
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', workspace: 'D:/a', kind: 'codegraph.sync', state: 'running', progress: 0, createdAt: 1, updatedAt: 1 });
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/a', connected: true, indexed: true });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    // 横幅不再来自任务列表，而是读 status 轮询的结果。
    await screen.findByText(/已开始同步/);
    expect(screen.queryByText(/查看任务/)).toBeNull();
  });

  it('invalidates same-project query and node replies on direct file navigation', async () => {
    const oldNode = deferred<unknown>();
    const oldQuery = deferred<unknown>();
    let searches = 0;
    vi.mocked(agentDataApi.code.call).mockImplementation(async (request) => {
      if (request.tool === 'codegraph_files') return { structuredContent: [{ file: 'a.ts', symbol: 'oldSymbol' }] };
      if (request.tool === 'codegraph_node') return oldNode.promise;
      if (request.tool === 'codegraph_search') return ++searches === 1 ? oldQuery.promise : { structuredContent: [] };
      return { structuredContent: [] };
    });
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: /oldSymbol.*a.ts/ }));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'old query' } });
    rerender(<CodeRetrievalPanel navigation={{ view: 'code', workspace: 'D:/a', file: 'direct.ts' }} navigationRequest={1} />);
    await waitFor(() => expect(files.read).toHaveBeenCalledWith('D:/a', 'direct.ts'));
    await act(async () => {
      oldNode.resolve({ content: [{ type: 'text', text: 'stale node reply' }] });
      oldQuery.resolve({ structuredContent: [{ file: 'stale-result.ts' }] });
    });
    expect(screen.queryByText('stale node reply')).toBeNull();
    expect(screen.queryByText('stale-result.ts')).toBeNull();
  });
});
