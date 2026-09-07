// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './JobsPanel';
import { deferred, systemTask, task, taskDetail } from './operationsTestData';
import { agentDataApi } from '../../lib/agentData';
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  jobs: { list: vi.fn(), cancel: vi.fn(), remove: vi.fn(), clear: vi.fn() },
  tasks: { read: vi.fn(), previewRetry: vi.fn(), retry: vi.fn() },
} }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(agentDataApi.tasks.read).mockImplementation(async (ref) => ref.source === 'system' ? { ...systemTask, events: [] } : { ...taskDetail, ref });
  vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('统一任务操作', () => {
  it('collapses system tasks and distinguishes matching IDs without fabricating progress', async () => {
    const { rerender } = render(<JobsPanel tasks={[task, systemTask]} onRefresh={vi.fn()} />);
    expect(screen.queryByText('后台维护')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /系统后台任务/ }));
    expect(screen.getByText('后台维护')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /后台维护/ });
    expect(within(row).queryByText(/0%/)).toBeNull();
    expect(within(row).queryByRole('button', { name: '删除' })).toBeNull();
    expect(within(row).queryByRole('button', { name: '取消' })).toBeNull();
    expect(within(row).getByText('系统只读')).toBeInTheDocument();
    rerender(<JobsPanel tasks={[task, systemTask]} selectedTask={systemTask.ref} selectionRequest={1} />);
    await waitFor(() => expect(agentDataApi.tasks.read).toHaveBeenCalledWith(systemTask.ref));
    expect(row).toHaveAttribute('aria-selected', 'true');
  });
  it('uses capabilities instead of guessing mutations from failed status', () => {
    render(<JobsPanel tasks={[{ ...task, capabilities: { cancel: false, retry: false, remove: false } }]} />);
    const row = screen.getByRole('row', { name: /生成知识页面/ });
    expect(within(row).getByRole('button', { name: '删除' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: '重试' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '清理已结束' })).toBeDisabled();
  });
  it('rechecks removal capability and keeps records when permission changed', async () => {
    vi.mocked(agentDataApi.tasks.read).mockResolvedValue({ ...taskDetail, cancellationRequested: true, capabilities: { cancel: false, retry: false, remove: false } });
    render(<JobsPanel tasks={[task]} onRefresh={vi.fn()} />);
    fireEvent.click(within(screen.getByRole('row', { name: /生成知识页面/ })).getByRole('button', { name: '删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前不允许删除');
    expect(agentDataApi.jobs.remove).not.toHaveBeenCalled();
    expect(screen.getByText('生成知识页面')).toBeInTheDocument();
  });
  it('cleans only permitted user terminal IDs, excluding system and cancelling rows', async () => {
    const cancelling = { ...task, ref: { source: 'user' as const, id: 'cancelling' }, key: 'user:cancelling', label: '取消中的任务', status: 'running' as const, cancellationRequested: true, capabilities: { cancel: false, retry: false, remove: false } };
    render(<JobsPanel tasks={[task, systemTask, cancelling]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '清理已结束' }));
    await waitFor(() => expect(agentDataApi.jobs.clear).toHaveBeenCalledWith(['same-id']));
    expect(screen.getByText('正在取消，等待确认')).toBeInTheDocument();
  });
  it('retains all rows after a failed batch and only removes returned IDs on success', async () => {
    vi.mocked(agentDataApi.jobs.clear).mockRejectedValueOnce(new Error('批量清理失败')).mockResolvedValueOnce({ deletedIds: ['same-id'] });
    render(<JobsPanel tasks={[task, { ...task, ref: { source: 'user', id: 'b' }, key: 'user:b', label: '第二任务' }]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '清理已结束' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('批量清理失败');
    expect(screen.getByText('生成知识页面')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清理已结束' }));
    await waitFor(() => expect(screen.queryByText('生成知识页面')).toBeNull());
    expect(screen.getByText('第二任务')).toBeInTheDocument();
  });
  it('does not fetch detail while hidden and does not re-scroll for monitor updates', async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const { rerender } = render(<JobsPanel tasks={[task]} selectedTask={task.ref} visible={false} />);
    expect(agentDataApi.tasks.read).not.toHaveBeenCalled();
    rerender(<JobsPanel tasks={[task]} selectedTask={task.ref} visible />);
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    rerender(<JobsPanel tasks={[{ ...task, updatedAt: 3 }]} selectedTask={task.ref} visible />);
    expect(scroll).toHaveBeenCalledOnce();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });
  it('keeps a running cancellation visible and displays backend cancellation failure', async () => {
    const running = { ...task, status: 'running' as const, capabilities: { cancel: true, retry: false, remove: false } };
    vi.mocked(agentDataApi.tasks.read).mockResolvedValue({ ...running, events: [] });
    vi.mocked(agentDataApi.jobs.cancel).mockRejectedValueOnce(new Error('取消请求未送达'));
    render(<JobsPanel tasks={[running]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('取消请求未送达');
    expect(screen.getByText('生成知识页面')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });
  it('keeps mutations fixed to their original source and ID while selection changes', async () => {
    const response = deferred<{ deleted: boolean }>();
    vi.mocked(agentDataApi.jobs.remove).mockReturnValue(response.promise);
    const { rerender } = render(<JobsPanel tasks={[task, systemTask]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(agentDataApi.jobs.remove).toHaveBeenCalledWith('same-id'));
    rerender(<JobsPanel tasks={[task, systemTask]} selectedTask={systemTask.ref} onRefresh={vi.fn()} />);
    await act(async () => response.resolve({ deleted: true }));
    expect(await screen.findByRole('row', { name: /后台维护/ })).toBeInTheDocument();
    expect(agentDataApi.jobs.remove).toHaveBeenCalledOnce();
  });
  it('does not reuse a previous retry intent when opening a different detail normally', async () => {
    const second = { ...task, ref: { source: 'user' as const, id: 'second' }, key: 'user:second', label: '第二任务' };
    vi.mocked(agentDataApi.tasks.previewRetry).mockResolvedValue({ ref: task.ref, label: task.label, callsModel: false });
    render(<JobsPanel tasks={[task, second]} />);
    fireEvent.click(within(screen.getByRole('row', { name: /生成知识页面/ })).getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '确认重试' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(screen.getByRole('row', { name: /第二任务/ })).getByRole('button', { name: '详情' }));
    await waitFor(() => expect(agentDataApi.tasks.read).toHaveBeenCalledWith(second.ref));
    expect(agentDataApi.tasks.previewRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '确认重试' })).toBeNull();
  });
  it('updates the open detail from its monitor without reloading or clearing a retry confirmation', async () => {
    vi.mocked(agentDataApi.tasks.previewRetry).mockResolvedValue({ ref: task.ref, label: task.label, callsModel: false });
    const { rerender } = render(<JobsPanel tasks={[task]} />);
    fireEvent.click(within(screen.getByRole('row', { name: /生成知识页面/ })).getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '确认重试' });
    const reads = vi.mocked(agentDataApi.tasks.read).mock.calls.length;
    rerender(<JobsPanel tasks={[{ ...task, stage: '新阶段', updatedAt: 42 }]} />);
    expect(within(screen.getByRole('dialog')).getByText('新阶段')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重试' })).toBeEnabled();
    expect(agentDataApi.tasks.read).toHaveBeenCalledTimes(reads);
  });
  it('hides unsafe progress on a modern task with non-finite data', () => {
    render(<JobsPanel tasks={[{ ...task, progress: Number.NaN }]} />);
    expect(screen.queryByText('NaN%')).toBeNull();
    expect(screen.getByText('未提供百分比')).toBeInTheDocument();
  });
  it('can open a fresh retry confirmation for the same task after closing it', async () => {
    vi.mocked(agentDataApi.tasks.previewRetry).mockResolvedValue({ ref: task.ref, label: task.label, callsModel: false });
    render(<JobsPanel tasks={[task]} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('button', { name: '确认重试' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    await screen.findByRole('button', { name: '重试任务' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '确认重试' })).toBeInTheDocument();
    expect(agentDataApi.tasks.previewRetry).toHaveBeenCalledTimes(2);
  });
  it('redacts recognizable credentials in task row and operation error messages', async () => {
    vi.mocked(agentDataApi.jobs.remove).mockRejectedValueOnce(new Error('delete failed Bearer mutation-credential'));
    render(<JobsPanel tasks={[{ ...task, error: 'request failed Bearer row-credential' }]} />);
    expect(screen.queryByText(/row-credential/)).toBeNull();
    expect(screen.getByText('request failed Bearer [redacted]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete failed Bearer [redacted]');
    expect(screen.queryByText(/mutation-credential/)).toBeNull();
  });

  it('keeps long workspace paths as one-line summaries while retaining the full value for access', () => {
    const workspace = 'D:/OneDrive/Project Files/mcp/JSReverser-MCP/a-very-long-workspace-name';
    render(<JobsPanel tasks={[{ ...task, workspace }]} />);
    const row = screen.getByRole('row', { name: /生成知识页面/ });
    const path = within(row).getByTitle(workspace);
    expect(path).toHaveTextContent(workspace);
  });
});
