// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './JobsPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { jobs: { list: vi.fn(), cancel: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

const jobs = [
  { id: 'job-1', kind: 'wiki.sync', workspace: 'D:/proj/alpha', state: 'running' as const, progress: 40, createdAt: 1, updatedAt: 2 },
  { id: 'job-2', kind: 'codegraph.sync', workspace: 'D:/proj/beta', state: 'failed' as const, progress: 0, error: 'codegraph exited (1)', createdAt: 1, updatedAt: 3 },
];

describe('JobsPanel', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue(jobs);
    vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(jobs[0]);
  });

  it('lists jobs from every workspace with their progress and failure reason', () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.getByText('wiki.sync')).toBeTruthy();
    expect(screen.getByText('D:/proj/beta')).toBeTruthy();
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

  it('filters by state', () => {
    render(<JobsPanel jobs={jobs} />);
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'failed' } });
    expect(screen.queryByText('wiki.sync')).toBeNull();
    expect(screen.getByText('codegraph.sync')).toBeTruthy();
  });

  it('does not offer a create form because sync is triggered from its own module', () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
  });
});
