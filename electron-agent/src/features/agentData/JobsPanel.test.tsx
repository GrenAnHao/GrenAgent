// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './JobsPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { jobs: { list: vi.fn(), cancel: vi.fn(), remove: vi.fn(), clear: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

const ask = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../components/askConfirm', () => ({ useAskConfirm: () => ask }));

const jobs = [
  { id: 'job-1', kind: 'wiki.sync', workspace: 'D:/proj/alpha', state: 'running' as const, progress: 40, createdAt: 1, updatedAt: 2 },
  { id: 'job-2', kind: 'codegraph.sync', workspace: 'D:/proj/beta', state: 'failed' as const, progress: 0, error: 'codegraph exited (1)', createdAt: 1, updatedAt: 3 },
];

const terminalJobs = [
  { ...jobs[0], id: 'job-completed', kind: 'completed.sync', state: 'completed' as const, progress: 100 },
  jobs[1],
  { ...jobs[0], id: 'job-cancelled', kind: 'cancelled.sync', state: 'cancelled' as const },
];
const activeJobs = [
  jobs[0],
  { ...jobs[0], id: 'job-pending', kind: 'pending.sync', state: 'pending' as const, progress: 0 },
];

describe('JobsPanel', () => {
  it('does not show an empty result while its shared task source has not loaded', () => {
    render(<JobsPanel jobs={[]} dataReady={false} />);
    expect(screen.queryByText('暂无匹配任务')).toBeNull();
    expect(screen.getByText('等待获取任务')).toBeTruthy();
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
  });
  it('reveals a requested task even when the same task is opened again after filtering', async () => {
    const { rerender } = render(<JobsPanel jobs={jobs} selectedJobId="job-1" selectionRequest={1} />);
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'no-match' } });
    expect(screen.queryByText('wiki.sync')).toBeNull();
    rerender(<JobsPanel jobs={jobs} selectedJobId="job-1" selectionRequest={2} />);
    expect(await screen.findByText('wiki.sync')).toBeTruthy();
  });

  it('scrolls to a requested row after it arrives, not again on every task poll', async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      const { rerender } = render(<JobsPanel jobs={[]} selectedJobId="job-1" selectionRequest={1} />);
      expect(scroll).not.toHaveBeenCalled();
      rerender(<JobsPanel jobs={jobs} selectedJobId="job-1" selectionRequest={1} />);
      await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
      rerender(<JobsPanel jobs={[...jobs]} selectedJobId="job-1" selectionRequest={1} />);
      expect(scroll).toHaveBeenCalledOnce();
    } finally { Reflect.deleteProperty(Element.prototype, 'scrollIntoView'); }
  });

  it('waits until a matching filter is cleared before consuming the scroll request', async () => {
    const filtersAtScroll: string[] = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => filtersAtScroll.push((screen.getByLabelText('搜索任务') as HTMLInputElement).value) });
    try {
      const { rerender } = render(<JobsPanel jobs={jobs} />);
      fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'wiki.sync' } });
      rerender(<JobsPanel jobs={jobs} selectedJobId="job-1" selectionRequest={1} />);
      await waitFor(() => expect(filtersAtScroll).toEqual(['']));
    } finally { Reflect.deleteProperty(Element.prototype, 'scrollIntoView'); }
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue(jobs);
    vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(jobs[0]);
    vi.mocked(agentDataApi.jobs.remove).mockResolvedValue({ deleted: true });
    vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: terminalJobs.map((job) => job.id) });
    ask.mockResolvedValue(true);
  });

  it('lists jobs from every workspace with their progress and failure reason', () => {
    render(<JobsPanel jobs={jobs} />);
    fireEvent.click(screen.getByRole('radio', { name: /全部/ }));
    expect(screen.getByText('wiki.sync')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.getByText('codegraph exited (1)')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
  });

  it('cancels a running job and refreshes', async () => {
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={jobs} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await waitFor(() => expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith('job-1'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('groups active and history tasks', async () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.getByText('wiki.sync')).toBeTruthy();
    expect(screen.queryByText('codegraph.sync')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    expect(screen.queryByText('wiki.sync')).toBeNull();
    expect(screen.getByText('codegraph.sync')).toBeTruthy();
  });

  it('does not offer a create form because sync is triggered from its own module', () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
  });

  it.each(terminalJobs)('deletes a $state job record after confirmation', async (job) => {
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={[job]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.queryByText(job.kind)).toBeNull());
    expect(agentDataApi.jobs.remove).toHaveBeenCalledWith(job.id);
    expect(ask).toHaveBeenCalled();
    const confirmation = String(ask.mock.calls[0]?.[0]?.content ?? '');
    expect(confirmation).toContain(job.kind);
    expect(confirmation).toContain('Wiki');
    expect(confirmation).toContain('索引');
    expect(confirmation).toContain('审计');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();
  });

  it.each(activeJobs)('only offers cancellation for a $state job', (job) => {
    render(<JobsPanel jobs={[job]} />);
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('does not delete or refresh when single-record confirmation is declined', async () => {
    ask.mockResolvedValueOnce(false);
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={[terminalJobs[0]]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await act(async () => {});

    expect(agentDataApi.jobs.remove).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByText(terminalJobs[0].kind)).toBeTruthy();
  });

  it('clears only terminal records matching both the search and state filter', async () => {
    const matchingJob = { ...terminalJobs[1], id: 'job-matching', kind: 'matching.sync', workspace: 'D:/proj/alpha' };
    vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: [matchingJob.id] });
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={[...activeJobs, ...terminalJobs, matchingJob]} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'matching' } });
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: /^清理已结束/ }));

    await waitFor(() => expect(screen.queryByText(matchingJob.kind)).toBeNull());
    expect(agentDataApi.jobs.clear).toHaveBeenCalledWith([matchingJob.id]);
    const confirmation = String(ask.mock.calls[0]?.[0]?.content ?? '');
    expect(confirmation).toContain('1');
    expect(confirmation).toContain('当前筛选');
    expect(confirmation).toContain('不可恢复');
    expect(confirmation).toContain('Wiki');
    expect(confirmation).toContain('索引');
    expect(confirmation).toContain('审计');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(agentDataApi.jobs.list).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: /全部/ }));
    for (const job of [...activeJobs, ...terminalJobs]) expect(screen.getByText(job.kind)).toBeTruthy();
  });

  it('keeps the IDs from before bulk confirmation when new records arrive', async () => {
    const onRefresh = vi.fn();
    const initialJob = terminalJobs[0];
    const newJob = terminalJobs[2];
    vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: [initialJob.id] });
    const { rerender } = render(<JobsPanel jobs={[initialJob]} onRefresh={onRefresh} />);
    ask.mockImplementationOnce(async () => {
      rerender(<JobsPanel jobs={[initialJob, newJob]} onRefresh={onRefresh} />);
      return true;
    });
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: /^清理已结束/ }));

    await waitFor(() => expect(screen.queryByText(initialJob.kind)).toBeNull());
    expect(agentDataApi.jobs.clear).toHaveBeenCalledWith([initialJob.id]);
    expect(screen.getByText(newJob.kind)).toBeTruthy();
  });

  it('does not clear or refresh when bulk confirmation is declined', async () => {
    ask.mockResolvedValueOnce(false);
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={terminalJobs} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: /^清理已结束/ }));
    await act(async () => {});

    expect(agentDataApi.jobs.clear).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    for (const job of terminalJobs) expect(screen.getByText(job.kind)).toBeTruthy();
  });

  it.each([
    { name: 'empty queue', input: [] },
    { name: 'active-only queue', input: activeJobs },
  ])('disables bulk cleanup for an $name', ({ input }) => {
    render(<JobsPanel jobs={input} />);
    const clearButton = screen.getByRole('button', { name: /^清理已结束/ }) as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    fireEvent.click(clearButton);
    expect(ask).not.toHaveBeenCalled();
    expect(agentDataApi.jobs.clear).not.toHaveBeenCalled();
  });

  it('disables bulk cleanup when the current filter has no terminal records', async () => {
    render(<JobsPanel jobs={[...activeJobs, ...terminalJobs]} />);
    fireEvent.click(screen.getByRole('radio', { name: /进行中/ }));
    expect((screen.getByRole('button', { name: /^清理已结束/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /全部/ }));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'no-such-workspace' } });
    expect((screen.getByRole('button', { name: /^清理已结束/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['cancel', 'remove', 'clear'] as const)('disables all mutation buttons while %s is pending', async (operation) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(agentDataApi.jobs.cancel).mockImplementation(async () => { await pending; return jobs[0]; });
    vi.mocked(agentDataApi.jobs.remove).mockImplementation(async () => { await pending; return { deleted: true }; });
    vi.mocked(agentDataApi.jobs.clear).mockImplementation(async () => { await pending; return { deletedIds: [terminalJobs[0].id] }; });
    render(<JobsPanel jobs={[...activeJobs, terminalJobs[0]]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /全部/ }));
    const button = operation === 'cancel'
      ? within(screen.getByRole('row', { name: /wiki.sync/ })).getByRole('button', { name: '取消' })
      : screen.getByRole('button', { name: operation === 'remove' ? '删除' : /^清理已结束/ });
    fireEvent.click(button);
    await act(async () => {});

    for (const action of screen.getAllByRole('button')) {
      expect((action as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(action);
    }
    expect(agentDataApi.jobs[operation]).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    await waitFor(() => expect((screen.getAllByRole('button', { name: '取消' })[0] as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(['remove', 'clear'] as const)('retains records and reports the error when %s fails', async (operation) => {
    vi.mocked(agentDataApi.jobs[operation]).mockRejectedValue(new Error('记录清理失败'));
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={[terminalJobs[0]]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: operation === 'remove' ? '删除' : /^清理已结束/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('记录清理失败'));
    expect(screen.getByText(terminalJobs[0].kind)).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains a record when the server declines the single deletion', async () => {
    vi.mocked(agentDataApi.jobs.remove).mockResolvedValue({ deleted: false });
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={[terminalJobs[0]]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('radio', { name: /历史/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByText(terminalJobs[0].kind)).toBeTruthy();
  });

  it('removes only returned IDs and refreshes a record that has become active', async () => {
    const becameActive = { ...terminalJobs[1], state: 'running' as const };
    vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: [terminalJobs[0].id] });
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([becameActive, ...activeJobs]);
    render(<JobsPanel jobs={[terminalJobs[0], terminalJobs[1], ...activeJobs]} />);
    fireEvent.click(screen.getByRole('radio', { name: /全部/ }));
    fireEvent.click(screen.getByRole('button', { name: /^清理已结束/ }));

    await waitFor(() => expect(screen.queryByText(terminalJobs[0].kind)).toBeNull());
    expect(agentDataApi.jobs.clear).toHaveBeenCalledWith([terminalJobs[0].id, terminalJobs[1].id]);
    await waitFor(() => expect(within(screen.getByRole('row', { name: /codegraph.sync/ })).getByRole('button', { name: '取消' })).toBeTruthy());
    for (const job of activeJobs) expect(screen.getByText(job.kind)).toBeTruthy();
  });

  it.each(['remove', 'clear'] as const)('refreshes its own loaded list after %s', async (operation) => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValueOnce([terminalJobs[0]]).mockResolvedValueOnce([terminalJobs[2]]);
    vi.mocked(agentDataApi.jobs.clear).mockResolvedValue({ deletedIds: [terminalJobs[0].id] });
    render(<JobsPanel />);
    fireEvent.click(await screen.findByRole('radio', { name: /历史/ }));
    await screen.findByText(terminalJobs[0].kind);
    fireEvent.click(screen.getByRole('button', { name: operation === 'remove' ? '删除' : /^清理已结束/ }));

    await screen.findByText(terminalJobs[2].kind);
    expect(screen.queryByText(terminalJobs[0].kind)).toBeNull();
    expect(agentDataApi.jobs.list).toHaveBeenCalledTimes(2);
  });
});
