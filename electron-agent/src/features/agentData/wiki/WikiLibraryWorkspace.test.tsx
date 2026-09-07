// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryWorkspace } from './WikiLibraryWorkspace';
import { deferred, library, page } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
import { task } from '../operationsTestData';
const monitor = vi.hoisted(() => ({ jobs: [] as import('../../../lib/agentData').AgentJob[], tasks: undefined as import('../../../lib/agentData').TaskView[] | undefined, track: vi.fn(), watchedTaskVersion: 0 }));
vi.mock('../AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => ({ ...monitor }) }));
vi.mock('../useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }] }));
vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(() => { mockWikiApi(); monitor.track = vi.fn(); monitor.watchedTaskVersion = 0; monitor.jobs = []; monitor.tasks = undefined; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const props = { kbId: 'k', onBack: vi.fn(), onViewTask: vi.fn() };

it('prefers projected user task stages and cancellation requests to compatibility progress', async () => {
  vi.mocked(agentDataApi.wiki.libraries.read).mockResolvedValue({ ...library, activeJobId: 'existing' });
  monitor.jobs = [{ id: 'existing', kind: 'wiki.sync', workspace: 'D:/a', state: 'running', progress: 0, createdAt: 1, updatedAt: 2 }];
  monitor.tasks = [{ ...task, ref: { source: 'user', id: 'existing' }, status: 'running', stage: '生成页面', progress: undefined }];
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByText(/运行中.*生成页面/)).toBeVisible();
  expect(screen.queryByText(/0%/)).toBeNull();
  monitor.tasks = [{ ...monitor.tasks[0], cancellationRequested: true, stage: undefined }];
  rerender(<WikiLibraryWorkspace {...props} visible />);
  expect(screen.getByText(/正在取消.*等待确认.*进度未提供/)).toBeVisible();
});

it('previews the real model and tracks an asynchronous receipt in the initiating view', async () => {
  const pending = deferred<{ jobId: string; targetCount: number; model: string }>();
  vi.mocked(agentDataApi.wiki.libraries.ingest).mockReturnValue(pending.promise);
  const originalTrack = monitor.track;
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始抽取' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: '开始抽取' }));
  await waitFor(() => expect(screen.getByText('会调用模型')).toBeVisible());
  expect(screen.getByText('fixture/provider-model')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '确认抽取 1 份资料' }));
  monitor.track = vi.fn();
  rerender(<WikiLibraryWorkspace {...props} visible={false} />);
  await act(async () => pending.resolve({ jobId: 'job-1', targetCount: 1, model: 'fixture/provider-model' }));
  expect(originalTrack).toHaveBeenCalledWith('job-1');
  expect(monitor.track).not.toHaveBeenCalled();
  expect(agentDataApi.wiki.libraries.ingest).toHaveBeenCalledWith('k', ['s'], undefined, 'fixture/provider-model');
  rerender(<WikiLibraryWorkspace {...props} visible />);
  expect(screen.getByText('已加入任务')).toBeVisible();
  expect(props.onViewTask).not.toHaveBeenCalled();
});

it('preserves successful domains after partial failure and pauses hidden refreshes', async () => {
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.sources.list).mockRejectedValue(new Error('来源离线'));
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByRole('alert')).toHaveTextContent('来源离线');
  expect(screen.getByRole('button', { name: '查看资料 a.md' })).toBeVisible();
  rerender(<WikiLibraryWorkspace {...props} visible={false} />);
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} visible={false} />);
  expect(agentDataApi.wiki.libraries.read).toHaveBeenCalledTimes(2);
  rerender(<WikiLibraryWorkspace {...props} visible />);
  await waitFor(() => expect(agentDataApi.wiki.libraries.read).toHaveBeenCalledTimes(3));
});

it('does not declare uncancellable system tasks cancelled during deletion', async () => {
  vi.mocked(agentDataApi.wiki.libraries.remove).mockResolvedValue({ state: 'waiting', tasks: [{ kbId: 'k', taskSource: 'service_task', taskId: 'sys-1', active: true, canCancel: false }] });
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
  fireEvent.click(await screen.findByText('删除知识库'));
  fireEvent.change(await screen.findByLabelText('输入知识库名称确认'), { target: { value: library.name } });
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(screen.getByText(/等待任务结束/)).toBeVisible());
  expect(screen.queryByRole('button', { name: '请求取消任务' })).toBeNull();
  expect(screen.queryByText('已取消')).toBeNull();
});

it('confirms reindex without a model and displays returned diagnostics without clearing content', async () => {
  vi.mocked(agentDataApi.wiki.libraries.reindex).mockResolvedValue({ pages: 0, diagnostics: [{ code: 'PAGE_PARSE_FAILED', path: page.path, message: '损坏正文' }] });
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
  fireEvent.click(await screen.findByText('重建索引'));
  await waitFor(() => expect(screen.getByText('不调用模型，不改正文')).toBeVisible());
  expect(agentDataApi.wiki.libraries.reindex).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认重建索引' }));
  await waitFor(() => expect(screen.getByText(/PAGE_PARSE_FAILED/)).toBeVisible());
  expect(screen.getByText('团队说明')).toBeVisible();
  expect(agentDataApi.wiki.libraries.ingest).not.toHaveBeenCalled();
});

it('protects a dirty page when choosing another page', async () => {
  vi.mocked(agentDataApi.wiki.pages.list).mockResolvedValue([page, { ...page, pageId: 'p2', title: '第二页' }]);
  render(<WikiLibraryWorkspace {...props} visible />);
  fireEvent.click(await screen.findByRole('tab', { name: /知识页面/ }));
  fireEvent.click(screen.getByRole('button', { name: '查看页面 说明' }));
  fireEvent.change(await screen.findByLabelText('Markdown 正文'), { target: { value: '未保存' } });
  fireEvent.click(screen.getByRole('button', { name: '查看页面 第二页' }));
  await waitFor(() => expect(screen.getByText('放弃未保存修改？')).toBeVisible());
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('未保存');
  expect(agentDataApi.wiki.pages.read).not.toHaveBeenCalledWith('k', 'p2');
});

it('disables ingestion after model preview failure', async () => {
  vi.mocked(agentDataApi.wiki.libraries.previewIngest).mockRejectedValue(new Error('MODEL_UNAVAILABLE'));
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  fireEvent.click(screen.getByRole('button', { name: '开始抽取' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('MODEL_UNAVAILABLE');
  expect(screen.getByRole('button', { name: '确认抽取 0 份资料' })).toBeDisabled();
  expect(agentDataApi.wiki.libraries.ingest).not.toHaveBeenCalled();
});

it('requires explicit regeneration preview and passes the confirmed source IDs', async () => {
  render(<WikiLibraryWorkspace {...props} visible />);
  fireEvent.click(await screen.findByRole('button', { name: '查看资料 a.md' }));
  fireEvent.click(await screen.findByRole('button', { name: '重新生成页面' }));
  expect(agentDataApi.wiki.libraries.previewIngest).toHaveBeenCalledWith('k', undefined, ['s']);
  fireEvent.click(await screen.findByRole('button', { name: '确认抽取 1 份资料' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.ingest).toHaveBeenCalledWith('k', ['s'], ['s'], 'fixture/provider-model'));
});

it('watches an existing active job and does not declare cancellation finished while its lease remains', async () => {
  vi.mocked(agentDataApi.wiki.libraries.read).mockResolvedValue({ ...library, activeJobId: 'existing' });
  monitor.jobs = [{ id: 'existing', kind: 'wiki.sync', workspace: 'D:/a', state: 'cancelled', progress: 20, createdAt: 1, updatedAt: 2 }];
  render(<WikiLibraryWorkspace {...props} visible />);
  await waitFor(() => expect(screen.getByText(/正在取消.*等待任务收尾/)).toBeVisible());
  expect(monitor.track).toHaveBeenCalledWith('existing');
  expect(screen.queryByText('已取消')).toBeNull();
});

it.each([['active', '正常'], ['deleting', '删除中'], ['deleted', '已删除']] as const)('shows %s lifecycle in Chinese', async (lifecycle, label) => {
  vi.mocked(agentDataApi.wiki.libraries.read).mockResolvedValue({ ...library, lifecycle });
  render(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByText(`状态：${label}`)).toBeInTheDocument();
});

it('does not label an initially failed source or page request as an empty resource list', async () => {
  vi.mocked(agentDataApi.wiki.sources.list).mockRejectedValue(new Error('来源断线'));
  vi.mocked(agentDataApi.wiki.pages.list).mockRejectedValue(new Error('页面断线'));
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText(/来源断线/);
  expect(screen.queryByText('添加原始资料后可开始抽取。')).toBeNull();
  expect(screen.queryByText('还没有知识页面。')).toBeNull();
  expect(screen.getByText('原始资料尚未获取')).toBeInTheDocument();
  expect(screen.getByText('知识页面尚未获取')).toBeInTheDocument();
});

it('can continue source and page deletion from persisted targets even when active lists are empty', async () => {
  vi.mocked(agentDataApi.wiki.libraries.read).mockResolvedValue({ ...library, deletingTargets: [{ kind: 'source', kbId: 'k', sourceId: 's' }, { kind: 'page', kbId: 'k', pageId: 'p' }] });
  vi.mocked(agentDataApi.wiki.sources.list).mockResolvedValue([]);
  vi.mocked(agentDataApi.wiki.pages.list).mockResolvedValue([]);
  render(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByText('待完成的删除')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '继续删除资料 s' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(agentDataApi.wiki.sources.remove).toHaveBeenCalledWith('k', 's', false));
});

it('keeps page deletion waiting accessible after the selected page disappears during refresh', async () => {
  vi.mocked(agentDataApi.wiki.pages.remove).mockResolvedValue({ state: 'waiting', tasks: [{ taskSource: 'service_task', taskId: 'sys', kbId: 'k', pageId: 'p', active: true, canCancel: false }] });
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  fireEvent.click(await screen.findByRole('tab', { name: /知识页面/ }));
  fireEvent.click(await screen.findByRole('button', { name: '查看页面 说明' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除页面' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await screen.findByText('等待任务结束后重试删除');
  vi.mocked(agentDataApi.wiki.pages.read).mockResolvedValue(undefined);
  vi.mocked(agentDataApi.wiki.pages.list).mockResolvedValue([]);
  vi.mocked(agentDataApi.wiki.libraries.read).mockResolvedValue({ ...library, deletingTargets: [{ kind: 'page', kbId: 'k', pageId: 'p' }] });
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} visible />);
  await waitFor(() => expect(screen.getByRole('button', { name: '重试删除' })).toBeVisible());
  expect(screen.getByRole('button', { name: '继续删除页面 p' })).toBeVisible();
});

it('makes a deleted library draft read-only without discarding it, and clears selection after an explicit exit', async () => {
  const onDeleted = vi.fn();
  const { rerender } = render(<WikiLibraryWorkspace {...props} onDeleted={onDeleted} visible />);
  fireEvent.click(await screen.findByRole('tab', { name: /知识页面/ }));
  fireEvent.click(await screen.findByRole('button', { name: '查看页面 说明' }));
  fireEvent.change(await screen.findByLabelText('Markdown 正文'), { target: { value: '待复制草稿' } });
  vi.mocked(agentDataApi.wiki.libraries.read).mockRejectedValue(new Error('WIKI_LIBRARY_NOT_FOUND'));
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} onDeleted={onDeleted} visible />);
  await screen.findByText('知识库已删除；草稿保留可复制。');
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('待复制草稿');
  expect(screen.getByRole('button', { name: '保存页面' })).toBeDisabled();
  expect(onDeleted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '返回知识库列表' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('k'));
});

it('notifies the parent of an externally deleted clean library but not a transient read error', async () => {
  const onDeleted = vi.fn();
  const { rerender } = render(<WikiLibraryWorkspace {...props} onDeleted={onDeleted} visible />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.libraries.read).mockRejectedValueOnce(new Error('网络失败')).mockRejectedValueOnce(new Error('NOT_FOUND'));
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} onDeleted={onDeleted} visible />);
  await screen.findByText(/网络失败/);
  expect(onDeleted).not.toHaveBeenCalled();
  monitor.watchedTaskVersion++;
  rerender(<WikiLibraryWorkspace {...props} onDeleted={onDeleted} visible />);
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('k'));
});

it.each(['page', 'source'] as const)('restores %s trigger focus only after the narrow list is visible again', async (kind) => {
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  if (kind === 'page') fireEvent.click(screen.getByRole('tab', { name: /知识页面/ }));
  const trigger = screen.getByRole('button', { name: kind === 'page' ? '查看页面 说明' : '查看资料 a.md' });
  fireEvent.click(trigger);
  const close = await screen.findByRole('button', { name: kind === 'page' ? '关闭页面详情' : '关闭资料详情' });
  const grid = trigger.closest('[data-detail]')!;
  expect(grid).toHaveAttribute('data-detail', 'true');
  const focusStates: Array<string | null> = [];
  const focus = vi.spyOn(trigger, 'focus').mockImplementation(() => { focusStates.push(grid.getAttribute('data-detail')); });
  fireEvent.click(close);
  await waitFor(() => expect(focus).toHaveBeenCalledOnce());
  expect(focusStates).toEqual(['false']);
});
