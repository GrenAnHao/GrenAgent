// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const monitor = vi.hoisted(() => ({ jobs: [] as import('../../lib/agentData').AgentJob[], error: undefined as string | undefined, track: vi.fn(), refresh: vi.fn(), watchedTaskVersion: 0 }));
vi.mock('./AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => monitor }));
vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
vi.mock('../../lib/agentData', () => ({ agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), search: vi.fn(), call: vi.fn() }, jobs: { create: vi.fn() } } }));
vi.mock('../../lib/files', () => ({ files: { read: vi.fn() } }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn() }));
import { agentDataApi, type AgentJob } from '../../lib/agentData';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';
const job: AgentJob = { id: 'job-1', workspace: 'D:/a', kind: 'codegraph.sync', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe('CodeRetrievalPanel task ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks(); monitor.jobs = []; monitor.error = undefined; monitor.watchedTaskVersion = 0; monitor.track = vi.fn();
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.status).mockImplementation(async (workspace) => ({ workspace, connected: true, indexed: true }));
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ structuredContent: [] });
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue(job);
  });
  afterEach(cleanup);

  it('creates an index only on a user click and refreshes status after a tracked terminal transition', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/a', connected: false, indexed: false });
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    const build = await screen.findByRole('button', { name: '建立索引' });
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
    fireEvent.click(build);
    await waitFor(() => expect(monitor.track).toHaveBeenCalledWith('job-1'));
    expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'codegraph.sync', workspace: 'D:/a' });
    expect(screen.getByTestId('code-retrieval-panel')).toBeTruthy();
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/a', connected: true, indexed: true });
    monitor.watchedTaskVersion++;
    rerender(<CodeRetrievalPanel />);
    await screen.findByRole('button', { name: '同步索引' });
    expect(agentDataApi.jobs.create).toHaveBeenCalledTimes(1);
    expect(agentDataApi.code.status).toHaveBeenCalledTimes(2);
  });

  it('tracks in place and opens the returned task only after clicking view', async () => {
    const onOpenTask = vi.fn();
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" onOpenTask={onOpenTask} />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    await screen.findByText(/已加入任务.*A/);
    expect(monitor.track).toHaveBeenCalledWith('job-1');
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(screen.getByText('任务状态未获取')).toBeTruthy();
    monitor.jobs = [{ ...job, state: 'running', progress: 61 }];
    rerender(<CodeRetrievalPanel onOpenTask={onOpenTask} />);
    expect(screen.getByText(/运行中.*61%/)).toBeTruthy();
    monitor.jobs = [{ ...job, state: 'completed', progress: 100 }];
    rerender(<CodeRetrievalPanel onOpenTask={onOpenTask} />);
    expect(screen.getByText(/已完成/)).toBeTruthy();
    monitor.jobs = [];
    rerender(<CodeRetrievalPanel onOpenTask={onOpenTask} />);
    expect(screen.getByText('任务状态未获取')).toBeTruthy();
    expect(screen.queryByText(/等待中/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }));
    expect(onOpenTask).toHaveBeenCalledWith('job-1');
  });

  it('captures the initiating track callback and project while creation finishes in another view', async () => {
    const pending = deferred<AgentJob>();
    vi.mocked(agentDataApi.jobs.create).mockReturnValue(pending.promise);
    const oldTrack = monitor.track;
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/b' } });
    monitor.track = vi.fn();
    rerender(<CodeRetrievalPanel visible={false} />);
    await act(async () => { pending.resolve(job); });
    expect(oldTrack).toHaveBeenCalledWith('job-1');
    expect(monitor.track).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'codegraph.sync', workspace: 'D:/a' });
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('D:/b');
    expect(screen.getByText(/已加入任务.*A.*D:\/a/)).toBeTruthy();
  });

  it('uses the returned real job workspace in the notice without changing the current project', async () => {
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ ...job, workspace: 'D:/b' });
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    expect(await screen.findByText(/已加入任务.*B.*D:\/b/)).toBeTruthy();
    expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('D:/a');
  });

  it('labels delayed failures with the original target without tracking or opening a task', async () => {
    const pending = deferred<AgentJob>();
    vi.mocked(agentDataApi.jobs.create).mockReturnValue(pending.promise);
    const onOpenTask = vi.fn();
    render(<CodeRetrievalPanel initialProject="D:/a" onOpenTask={onOpenTask} />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/b' } });
    await act(async () => { pending.reject(new Error('Cannot create index job')); });
    expect(screen.getByRole('alert').textContent).toMatch(/A.*D:\/a.*Cannot create index job/);
    expect(monitor.track).not.toHaveBeenCalled();
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '查看任务' })).toBeNull();
  });

  it('labels monitor failures as old state instead of presenting cached jobs as current', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/a" />);
    fireEvent.click(await screen.findByRole('button', { name: '同步索引' }));
    await screen.findByText(/已加入任务/);
    monitor.jobs = [{ ...job, state: 'running', progress: 40 }];
    monitor.error = 'monitor disconnected';
    rerender(<CodeRetrievalPanel />);
    expect(screen.getByRole('alert').textContent).toMatch(/monitor disconnected.*旧状态不是最新/);
    expect(screen.getByText(/上次获取：运行中.*40%/)).toBeTruthy();
  });

  it('does not enable unknown or failed-status index writes', async () => {
    const pending = deferred<import('../../lib/agentData').CodeGraphStatus>();
    vi.mocked(agentDataApi.code.status).mockReturnValue(pending.promise);
    render(<CodeRetrievalPanel initialProject="D:/a" />);
    expect(screen.queryByRole('button', { name: /建立索引|同步索引/ })).toBeNull();
    await act(async () => { pending.reject(new Error('Status unavailable')); });
    expect(screen.queryByRole('button', { name: /建立索引|同步索引/ })).toBeNull();
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });
});
