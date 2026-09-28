// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../lib/agentData';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { deferred, systemTask, task, taskDetail } from './operationsTestData';
import type { TaskDetail, TaskView } from '../../../electron/agentData/operationsContracts';
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  tasks: { read: vi.fn(), previewRetry: vi.fn(), retry: vi.fn() },
  jobs: { cancel: vi.fn() },
} }));
beforeEach(() => {
  vi.resetAllMocks();
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue(taskDetail);
  vi.mocked(agentDataApi.tasks.previewRetry).mockResolvedValue({ ref: task.ref, label: task.label, callsModel: true, resource: task.resource, sourceIds: ['s1', 's2'], targetCount: 2, model: 'fixture/provider-model' });
  vi.mocked(agentDataApi.tasks.retry).mockResolvedValue({ ...task, ref: { source: 'user', id: 'new-id' }, key: 'user:new-id', status: 'pending', error: undefined, retryOf: task.ref.id });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('reads safe detail only while open and displays real counts without a fake percentage', async () => {
  const { rerender } = render(<TaskDetailDrawer taskRef={task.ref} visible={false} onClose={vi.fn()} />);
  expect(agentDataApi.tasks.read).not.toHaveBeenCalled();
  rerender(<TaskDetailDrawer taskRef={task.ref} visible onClose={vi.fn()} />);
  expect(await screen.findByText('处理停止')).toBeInTheDocument();
  expect(screen.getByText('1 / 3')).toBeInTheDocument();
  expect(screen.queryByText('0%')).toBeNull();
  expect(screen.getByText('wiki.ingest')).toBeInTheDocument();
});
it('distinguishes read failure from deleted and permits retrying detail loading', async () => {
  vi.mocked(agentDataApi.tasks.read).mockRejectedValueOnce(new Error('读取失败'));
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  expect(screen.queryByText('任务记录已移除')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  expect(await screen.findByText('处理停止')).toBeInTheDocument();
});
it('isolates a late detail from a newly selected source with the same ID', async () => {
  const earlier = deferred<TaskDetail | undefined>();
  vi.mocked(agentDataApi.tasks.read).mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ ...systemTask, events: [] });
  const { rerender } = render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} />);
  rerender(<TaskDetailDrawer taskRef={systemTask.ref} onClose={vi.fn()} />);
  expect(await screen.findByText('后台维护')).toBeInTheDocument();
  await act(async () => earlier.resolve(taskDetail));
  expect(screen.queryByText('来源读取失败')).toBeNull();
  expect(screen.getByText('后台维护')).toBeInTheDocument();
});
it('confirms current Wiki model and target count then tracks a new ID without changing old failure', async () => {
  const onTrack = vi.fn();
  const onRefresh = vi.fn();
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} onTrack={onTrack} onRefresh={onRefresh} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试任务' }));
  expect(await screen.findByText('fixture/provider-model')).toBeInTheDocument();
  expect(screen.getByText(/2 份来源/)).toBeInTheDocument();
  expect(screen.getByText(/新建任务，保留旧记录/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认重试' }));
  await waitFor(() => expect(agentDataApi.tasks.retry).toHaveBeenCalledWith(task.ref, { expectedModel: 'fixture/provider-model' }));
  expect(onTrack).toHaveBeenCalledWith({ source: 'user', id: 'new-id' });
  expect(onRefresh).toHaveBeenCalled();
  expect(screen.getByText('来源读取失败')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /查看新任务/ })).toBeInTheDocument();
});
it('retains confirmation when the backend reports a changed model instead of resubmitting automatically', async () => {
  vi.mocked(agentDataApi.tasks.retry).mockRejectedValueOnce(new Error('模型配置已变化，请重新确认'));
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试任务' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认重试' }));
  await waitFor(() => expect(screen.queryAllByRole('alert').some((el) => el.textContent?.includes('模型配置已变化'))).toBe(true));
  expect(screen.getByRole('button', { name: '确认重试' })).toBeEnabled();
  expect(agentDataApi.tasks.retry).toHaveBeenCalledOnce();
});
it('prevents close and duplicate retry while busy and ignores A results after switching to B', async () => {
  const retry = deferred<TaskView>();
  vi.mocked(agentDataApi.tasks.retry).mockReturnValue(retry.promise);
  const onClose = vi.fn(); const onTrack = vi.fn();
  const { rerender } = render(<TaskDetailDrawer taskRef={task.ref} onClose={onClose} onTrack={onTrack} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试任务' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认重试' }));
  expect(screen.getByRole('button', { name: '确认重试' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
  expect(onClose).not.toHaveBeenCalled();
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue({ ...systemTask, events: [] });
  rerender(<TaskDetailDrawer taskRef={systemTask.ref} onClose={onClose} onTrack={onTrack} />);
  expect(await screen.findByText('后台维护')).toBeInTheDocument();
  await act(async () => retry.resolve({ ...task, ref: { source: 'user', id: 'new-id' }, key: 'user:new-id' }));
  expect(onTrack).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /查看新任务/ })).toBeNull();
});
it('navigates to the related resource with the typed reference', async () => {
  const onNavigate = vi.fn();
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看关联资源' }));
  expect(onNavigate).toHaveBeenCalledWith({ view: 'wiki', kbId: 'kb-a' });
});
it('shows a project resource path as the target instead of calling it removed', async () => {
  const memory = {
    ...systemTask,
    kind: 'memory_scene',
    label: '记忆场景',
    status: 'completed' as const,
    resource: { type: 'project' as const, id: 'D:/System Dir/Downloads/Python代码' },
    resourceName: undefined,
    workspace: 'D:/System Dir/Downloads/Python代码',
    stage: '已完成',
    progress: 100,
    inputSummary: { mode: 'work', memoryCount: 1 },
    outputSummary: { written: 1, deleted: 0 },
    events: [],
  };
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue(memory);
  render(<TaskDetailDrawer taskRef={memory.ref} onClose={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: '记忆场景' })).toBeInTheDocument();
  expect(screen.getAllByText('D:/System Dir/Downloads/Python代码').length).toBeGreaterThan(0);
  expect(screen.queryByText(/资源已移除/)).toBeNull();
  expect(screen.getByText(/"memoryCount": 1/)).toBeInTheDocument();
  expect(screen.queryByText('未提供阶段')).toBeNull();
  expect(screen.queryByText('未提供百分比')).toBeNull();
});
it('shows task creation and update timestamps separately from event timestamps', async () => {
  const createdAt = Date.UTC(2026, 8, 3, 3, 4, 5);
  const updatedAt = Date.UTC(2026, 8, 5, 6, 7, 8);
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue({ ...taskDetail, createdAt, updatedAt });
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} />);
  expect(await screen.findByText('创建时间')).toBeInTheDocument();
  expect(screen.getByText('更新时间')).toBeInTheDocument();
  expect(screen.getByText(new Date(createdAt).toLocaleString())).toBeInTheDocument();
  expect(screen.getByText(new Date(updatedAt).toLocaleString())).toBeInTheDocument();
});

it('groups detail metadata, execution summary, and events for visual scanning', async () => {
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: '任务信息', exact: true })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '资源信息', exact: true })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '执行摘要', exact: true })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '任务事件', exact: true })).toBeInTheDocument();
  expect(screen.getByText(task.ref.id)).toBeInTheDocument();
});

it('cancels from the drawer after rechecking capability', async () => {
  const running = { ...taskDetail, status: 'running' as const, capabilities: { cancel: true, retry: false, remove: false } };
  vi.mocked(agentDataApi.tasks.read).mockResolvedValue(running);
  vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(undefined);
  const onRefresh = vi.fn();
  render(<TaskDetailDrawer taskRef={task.ref} onClose={vi.fn()} onRefresh={onRefresh} />);
  fireEvent.click(await screen.findByRole('button', { name: '取消任务' }));
  await waitFor(() => expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith(task.ref.id));
  // 初次读取 + 取消前复查 + 取消后重读详情。
  await waitFor(() => expect(agentDataApi.tasks.read).toHaveBeenCalledTimes(3));
  expect(onRefresh).toHaveBeenCalled();
});
