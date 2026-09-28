// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentDataApi, type AgentJob, type TaskView, type TaskDetail } from '../../lib/agentData';
import { AgentDataTaskProvider, useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import type { AgentDataTab } from './agentDataViewTypes';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { jobs: { list: vi.fn(), get: vi.fn() }, tasks: { list: vi.fn(), read: vi.fn() } },
}));

const job = (id = 'task-1', state: AgentJob['state'] = 'running'): AgentJob => ({
  id, state, kind: 'wiki.sync', workspace: 'D:/project', progress: state === 'completed' ? 100 : 20, createdAt: 1, updatedAt: 2,
});
function asTask(job: AgentJob): TaskView {
  return { ref: { source: 'user', id: job.id }, key: `user:${job.id}`, kind: job.kind, label: job.kind, status: job.state,
    workspace: job.workspace, progress: job.progress, createdAt: job.createdAt, updatedAt: job.updatedAt, cancellationRequested: false,
    capabilities: { cancel: job.state === 'running' || job.state === 'pending', retry: false, remove: false } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let monitor: ReturnType<typeof useAgentDataTaskMonitor>;
let hidden = false;
function Consumer({ name = 'first' }: { name?: string }) {
  const value = useAgentDataTaskMonitor();
  monitor = value;
  return <div data-testid={name}>
    <span>{value.jobs.map(({ id, state }) => `${id}:${state}`).join(',')}</span>
    <span>{value.error}</span>
    <output>{value.watchedTaskVersion}</output>
    <data value={String(value.activeCount ?? '')} data-testid={`${name}-active`} />
  </div>;
}
function tree(view: AgentDataTab = 'overview', visible = true, two = false) {
  return <AgentDataTaskProvider visible={visible} activeView={view}>
    <Consumer />{two ? <Consumer name="second" /> : null}
  </AgentDataTaskProvider>;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function tick(milliseconds = 2000) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); }
async function setHidden(value: boolean) {
  hidden = value;
  await act(async () => { fireEvent(document, new Event('visibilitychange')); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.mocked(agentDataApi.jobs.list).mockResolvedValue([job()]);
  vi.mocked(agentDataApi.jobs.get).mockResolvedValue(undefined);
  vi.mocked(agentDataApi.tasks.list).mockImplementation(async () => ({ items: (await agentDataApi.jobs.list()).map(asTask) }));
  vi.mocked(agentDataApi.tasks.read).mockImplementation(async (ref) => { const value = await agentDataApi.jobs.get(ref.id); return value ? { ...asTask(value), events: [] } : undefined; });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgentDataTaskProvider', () => {
  it('exposes the server active count including background tasks', async () => {
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [asTask(job())], activeCount: 3 });
    render(tree('overview'));
    await flush();
    expect(screen.getByTestId('first-active').getAttribute('value')).toBe('3');
  });

  it('stops polling paged history but observes active work beyond the loaded page', async () => {
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [asTask(job('history', 'completed'))], nextCursor: 'more', activeCount: 0 });
    render(tree('jobs')); await flush(); await tick(6000);
    expect(agentDataApi.tasks.list).toHaveBeenCalledTimes(1);
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [asTask(job('history', 'completed'))], nextCursor: 'more', activeCount: 1 });
    await act(async () => { await monitor.refresh(); }); await tick();
    expect(agentDataApi.tasks.list).toHaveBeenCalledTimes(3);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('signals a listed %s transition once without explicitly tracking it', async (status) => {
    const running = asTask(job());
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [running], activeCount: 1 });
    render(tree('overview')); await flush();
    expect(monitor.watchedTaskVersion).toBe(0);
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [{ ...running, status }], activeCount: 0 });
    await tick();
    expect(monitor.tasks[0].status).toBe(status);
    expect(monitor.watchedTaskVersion).toBe(1);
    await tick(8000);
    expect(agentDataApi.tasks.list).toHaveBeenCalledTimes(2);
    await act(async () => { await monitor.refresh(); monitor.track(running.ref); }); await flush();
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('settles listed user and system transitions independently when their IDs match', async () => {
    const user = asTask(job('same'));
    const system: TaskView = { ...user, ref: { source: 'system', id: 'same' }, key: 'system:same', capabilities: { cancel: false, retry: false, remove: false } };
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [user, system], activeCount: 2 });
    render(tree('jobs')); await flush();
    const completedSystem = { ...system, status: 'completed' as const };
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [user, completedSystem], activeCount: 1 });
    await tick();
    expect(monitor.watchedTaskVersion).toBe(1);
    expect(monitor.jobs[0].state).toBe('running');
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [{ ...user, status: 'completed' }, completedSystem], activeCount: 0 });
    await tick();
    expect(monitor.watchedTaskVersion).toBe(2);
    await act(async () => { await monitor.refresh(); });
    expect(monitor.watchedTaskVersion).toBe(2);
  });

  it('signals unseen task completion once when the aggregate active count falls', async () => {
    const history = asTask(job('history', 'completed'));
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [history], nextCursor: 'more', activeCount: 2 });
    render(tree('overview')); await flush();
    expect(monitor.watchedTaskVersion).toBe(0);
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [history], nextCursor: 'more', activeCount: 0 });
    await tick();
    expect(monitor.watchedTaskVersion).toBe(1);
    expect(monitor.tasks).toEqual([history]);
    expect(agentDataApi.tasks.read).not.toHaveBeenCalled();
    await tick(8000);
    expect(agentDataApi.tasks.list).toHaveBeenCalledTimes(2);
    await act(async () => { await monitor.refresh(); });
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('merges an aggregate decrease with a tracked listed terminal notification', async () => {
    const running = asTask(job());
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [running], activeCount: 2 });
    render(tree('overview')); await flush();
    act(() => { monitor.track(running.ref); }); await flush();
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [{ ...running, status: 'completed' }], activeCount: 0 });
    await tick();
    expect(monitor.watchedTaskVersion).toBe(1);
    await act(async () => { await monitor.refresh(); });
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it.each([
    [undefined, 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0], [1.5, 0],
    [-1, 0], [1, Number.NaN], [1, -1], [1, 0.5],
  ])('does not infer unseen completion from invalid active counts %s to %s', async (before, after) => {
    const history = asTask(job('history', 'completed'));
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [history], activeCount: before });
    render(tree('overview')); await flush();
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [history], activeCount: after });
    await act(async () => { await monitor.refresh(); });
    expect(monitor.watchedTaskVersion).toBe(0);
  });

  it('does not settle a listed task from a stale terminal response after hiding', async () => {
    const running = asTask(job());
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [running], activeCount: 1 });
    render(tree('overview')); await flush();
    const stale = deferred<{ items: TaskView[]; activeCount: number }>();
    const current = deferred<{ items: TaskView[]; activeCount: number }>();
    vi.mocked(agentDataApi.tasks.list).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    act(() => { void monitor.refresh(); });
    await setHidden(true); await setHidden(false);
    await act(async () => { stale.resolve({ items: [{ ...running, status: 'completed' }], activeCount: 0 }); });
    expect(monitor.watchedTaskVersion).toBe(0);
    await act(async () => { current.resolve({ items: [running], activeCount: 1 }); });
    expect(monitor.watchedTaskVersion).toBe(0);
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [{ ...running, status: 'completed' }], activeCount: 0 });
    await tick();
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('does not commit a pre-hide response after visibility returns', async () => {
    render(tree('jobs')); await flush();
    const old = deferred<{ items: TaskView[] }>(), fresh = deferred<{ items: TaskView[] }>();
    vi.mocked(agentDataApi.tasks.list).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    act(() => { void monitor.refresh(); });
    await setHidden(true); await setHidden(false);
    await act(async () => { old.resolve({ items: [asTask(job('pre-hide', 'completed'))] }); });
    expect(monitor.tasks.map((task) => task.ref.id)).toEqual(['task-1']);
    await act(async () => { fresh.resolve({ items: [asTask(job('fresh', 'completed'))] }); });
    expect(monitor.tasks.map((task) => task.ref.id)).toEqual(['fresh']);
  });

  it('uses composite refs and never lets a terminal system task settle a same-ID user task', async () => {
    const user = asTask(job('same'));
    const system: TaskView = { ...user, ref: { source: 'system', id: 'same' }, key: 'system:same', status: 'completed', progress: undefined, capabilities: { cancel: false, retry: false, remove: false } };
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [user, system] });
    render(tree('wiki')); await flush();
    expect(monitor).toHaveProperty('tasks');
    expect(monitor.tasks.map((task) => task.key)).toEqual(['user:same', 'system:same']);
    expect(monitor.jobs.map((task) => task.id)).toEqual(['same']);
    act(() => { monitor.track('same'); monitor.track({ source: 'system', id: 'same' }); }); await flush();
    expect(monitor.watchedTaskVersion).toBe(1);
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [{ ...user, status: 'completed' }, system] });
    await tick(); expect(monitor.watchedTaskVersion).toBe(2);
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
  });

  it('loads more task pages and refreshes the same loaded window using fresh cursors', async () => {
    const first = asTask(job('first', 'completed')), second = asTask(job('second', 'completed'));
    vi.mocked(agentDataApi.tasks.list).mockImplementation(async (input) => input?.cursor ? { items: [second] } : { items: [first], nextCursor: 'page-2' });
    const { rerender } = render(tree('jobs')); await flush();
    expect(monitor).toHaveProperty('loadMore', expect.any(Function));
    await act(async () => { await monitor.loadMore(); });
    expect(monitor.tasks.map((task) => task.key)).toEqual(['user:first', 'user:second']);
    rerender(tree('jobs', false)); await flush(); rerender(tree('jobs')); await flush();
    expect(monitor.tasks.map((task) => task.key)).toEqual(['user:first', 'user:second']);
    expect(agentDataApi.tasks.list).toHaveBeenCalledTimes(5);
  });

  it.each(['unfocused', 'invisible', 'hidden'] as const)('keeps jobs unknown while initially %s', async (blocked) => {
    vi.mocked(document.hasFocus).mockReturnValue(blocked !== 'unfocused');
    hidden = blocked === 'hidden';
    render(tree('overview', blocked !== 'invisible'));
    await act(async () => { await monitor.refresh(); });
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
    expect(monitor.loaded).toBe(false);
    expect(monitor.loading).toBe(false);
  });

  it('marks a successful empty list as loaded only after the first request resolves', async () => {
    const pending = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(pending.promise);
    render(tree());
    expect(monitor.loaded).toBe(false);
    expect(monitor.loading).toBe(true);
    await act(async () => { pending.resolve([]); });
    expect(monitor.loaded).toBe(true);
    expect(monitor.jobs).toEqual([]);
    expect(monitor.loading).toBe(false);
  });

  it('retains loaded empty-list knowledge during a refresh and its failure', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValueOnce([]);
    render(tree());
    await flush();
    expect(monitor.loaded).toBe(true);
    const pending = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(pending.promise);
    let refreshed!: Promise<void>;
    act(() => { refreshed = monitor.refresh(); });
    expect(monitor.loaded).toBe(true);
    expect(monitor.loading).toBe(true);
    await act(async () => { pending.reject(new Error('刷新失败')); await refreshed; });
    expect(monitor.loaded).toBe(true);
    expect(monitor.jobs).toEqual([]);
    expect(monitor.error).toBe('刷新失败');
  });

  it('keeps jobs unknown after the first list fails and marks a later success as loaded', async () => {
    vi.mocked(agentDataApi.jobs.list).mockRejectedValueOnce(new Error('首次读取失败'));
    render(tree());
    await flush();
    expect(monitor.loaded).toBe(false);
    expect(monitor.error).toBe('首次读取失败');
    await act(async () => { await monitor.refresh(); });
    expect(monitor.loaded).toBe(true);
    expect(monitor.jobs).toEqual([job()]);
  });

  it('does not mark a discarded StrictMode installation response as loaded', async () => {
    const stale = deferred<AgentJob[]>();
    const current = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode>{tree()}</StrictMode>);
    await act(async () => { stale.resolve([]); });
    expect(monitor.loaded).toBe(false);
    await act(async () => { current.resolve([]); });
    expect(monitor.loaded).toBe(true);
  });

  it('shares one initial load and one two-second poll between consumers', async () => {
    render(tree('overview', true, true));
    await flush();
    expect(screen.getByTestId('first').textContent).toContain('task-1:running');
    expect(screen.getByTestId('second').textContent).toContain('task-1:running');
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await tick(1999);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });

  it.each(['overview', 'jobs'] as const)('polls pending jobs in %s', async (view) => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([job('pending', 'pending')]);
    render(tree(view));
    await flush();
    await tick();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });

  it('does not poll a history containing only completed, failed and cancelled jobs', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue(['completed', 'failed', 'cancelled'].map((state) => job(state, state as AgentJob['state'])));
    render(tree());
    await flush();
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    expect(monitor.jobs).toHaveLength(3);
    expect(monitor.watchedTaskVersion).toBe(0);
  });

  it('defers initial loading and tracking while the center is invisible', async () => {
    const { rerender } = render(tree('wiki', false));
    act(() => { monitor.track('task-1'); });
    await tick(8000);
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
    rerender(tree('wiki', true));
    await flush();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    expect(monitor.jobs).toEqual([job()]);
    rerender(tree('wiki', false));
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
  });

  it('pauses when document is hidden and refreshes once on return', async () => {
    render(tree());
    await flush();
    await setHidden(true);
    await act(async () => { await monitor.refresh(); });
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await setHidden(false);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
    await tick();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(3);
  });

  it('pauses on blur and refreshes once on focus, including duplicate focus events', async () => {
    render(tree());
    await flush();
    await act(async () => { fireEvent(window, new Event('blur')); });
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent(window, new Event('focus')); fireEvent(window, new Event('focus')); });
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });

  it('does not load until an initially unfocused document regains focus', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render(tree());
    await flush();
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(monitor.jobs).toEqual([job()]);
  });

  it('does not resume while another visibility condition still blocks requests', async () => {
    render(tree());
    await flush();
    await setHidden(true);
    await act(async () => { fireEvent(window, new Event('blur')); });
    await setHidden(false);
    await tick(4000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });

  it.each(['memory', 'wiki', 'code', 'audit'] as const)('does not poll untracked global jobs in %s', async (view) => {
    render(tree(view));
    await flush();
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
  });

  it('fetches an unknown tracked ID missing from the list and polls its owning view', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.jobs.get).mockResolvedValue(job('new-task'));
    render(tree('wiki'));
    await flush();
    act(() => { monitor.track('new-task'); });
    await flush();
    expect(agentDataApi.jobs.get).toHaveBeenCalledWith('new-task');
    expect(monitor.jobs).toEqual([job('new-task')]);
    await tick();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(3);
  });

  it('drops a confirmed missing tracked ID and signals resource refresh only once', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    render(tree('wiki'));
    await flush();
    act(() => { monitor.track('deleted-task'); });
    await flush();
    expect(agentDataApi.jobs.get).toHaveBeenCalledWith('deleted-task');
    expect(monitor.watchedTaskVersion).toBe(1);
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
    act(() => { monitor.track('deleted-task'); });
    await flush();
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('keeps tracking when get fails instead of treating the task as deleted', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.jobs.get).mockRejectedValueOnce(new Error('获取任务失败')).mockResolvedValue(job('new-task'));
    render(tree('wiki'));
    await flush();
    act(() => { monitor.track('new-task'); });
    await flush();
    expect(monitor.error).toBe('获取任务失败');
    expect(monitor.watchedTaskVersion).toBe(0);
    await tick();
    expect(monitor.jobs).toEqual([job('new-task')]);
    expect(monitor.error).toBeUndefined();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('signals a tracked %s state once even if tracked again', async (state) => {
    render(tree('wiki'));
    await flush();
    act(() => { monitor.track('task-1'); });
    await flush();
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([job('task-1', state)]);
    await tick();
    expect(monitor.watchedTaskVersion).toBe(1);
    expect(monitor.jobs[0].state).toBe(state);
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(3);
    await act(async () => { await monitor.refresh(); monitor.track('task-1'); });
    await flush();
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('notifies for a terminal state first observed immediately after tracking', async () => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([job('task-1', 'completed')]);
    render(tree('wiki'));
    await flush();
    expect(monitor.watchedTaskVersion).toBe(0);
    act(() => { monitor.track('task-1'); });
    await flush();
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('preserves loaded jobs on refresh failure and resumes polling without clearing history', async () => {
    render(tree());
    await flush();
    const failed = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(failed.promise);
    let refreshing!: Promise<void>;
    act(() => { refreshing = monitor.refresh(); });
    expect(monitor.jobs).toEqual([job()]);
    await act(async () => { failed.reject(new Error('任务刷新失败')); await refreshing; });
    expect(monitor.jobs).toEqual([job()]);
    expect(monitor.error).toBe('任务刷新失败');
    await tick();
    expect(monitor.error).toBeUndefined();
  });

  it('coalesces inflight refresh requests and tracking into one serial follow-up', async () => {
    const initial = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(initial.promise).mockResolvedValue([job('new-task', 'completed')]);
    render(tree('wiki'));
    let refreshed!: Promise<void>;
    act(() => { monitor.track('new-task'); refreshed = monitor.refresh(); });
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await act(async () => { initial.resolve([]); await refreshed; });
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
    expect(monitor.jobs).toEqual([job('new-task', 'completed')]);
    expect(monitor.watchedTaskVersion).toBe(1);
    expect(agentDataApi.jobs.get).not.toHaveBeenCalled();
  });

  it('keeps the view captured by a delayed create handler as the tracking owner', async () => {
    const { rerender } = render(tree('wiki'));
    await flush();
    const wikiTrack = monitor.track;
    rerender(tree('code'));
    await flush();
    expect(monitor.track).not.toBe(wikiTrack);
    act(() => { wikiTrack('task-1'); });
    await flush();
    const callsAfterCreation = vi.mocked(agentDataApi.jobs.list).mock.calls.length;
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(callsAfterCreation);
    rerender(tree('wiki'));
    await flush();
    const callsOnReturn = vi.mocked(agentDataApi.jobs.list).mock.calls.length;
    await tick();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(callsOnReturn + 1);
  });

  it('does not start a missing-ID lookup if the document hides during list loading', async () => {
    render(tree('wiki'));
    await flush();
    const pending = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    act(() => { monitor.track('new-task'); });
    await setHidden(true);
    await act(async () => { pending.resolve([]); });
    expect(agentDataApi.jobs.get).not.toHaveBeenCalled();
    expect(monitor.watchedTaskVersion).toBe(0);
    await setHidden(false);
    expect(agentDataApi.jobs.get).toHaveBeenCalledWith('new-task');
    expect(monitor.watchedTaskVersion).toBe(1);
  });

  it('stops timers, listeners and queued refreshes when unmounted', async () => {
    render(tree());
    await flush();
    const pending = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(pending.promise);
    act(() => { void monitor.refresh(); monitor.track('new-task'); });
    cleanup();
    await act(async () => { pending.resolve([job('stale')]); fireEvent(window, new Event('focus')); });
    await setHidden(true);
    await setHidden(false);
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
    expect(agentDataApi.jobs.get).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes StrictMode reinstallation and ignores the old installation result', async () => {
    const stale = deferred<AgentJob[]>();
    const current = deferred<AgentJob[]>();
    vi.mocked(agentDataApi.jobs.list).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise).mockResolvedValue([job('current', 'completed')]);
    render(<StrictMode>{tree()}</StrictMode>);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(1);
    await act(async () => { stale.resolve([job('stale')]); });
    expect(monitor.jobs).toEqual([]);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
    await act(async () => { current.resolve([job('current', 'completed')]); });
    expect(monitor.jobs).toEqual([job('current', 'completed')]);
    await tick(8000);
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });
});
