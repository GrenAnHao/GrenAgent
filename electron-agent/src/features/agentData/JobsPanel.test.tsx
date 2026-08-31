// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './JobsPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { jobs: { list: vi.fn(), cancel: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

const jobs = [
  { id: 'job-1', kind: 'Wiki 增量同步', workspace: '/workspace', state: 'running' as const, progress: 42, createdAt: 1, updatedAt: 2 },
  { id: 'job-2', kind: 'CodeGraph 同步', workspace: '/workspace', state: 'failed' as const, progress: 12, error: 'indexer exited', createdAt: 1, updatedAt: 2 },
];

describe('JobsPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(jobs[0]);
  });

  it('lists jobs, filters by text and state, and cancels a running job', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<JobsPanel jobs={jobs} onRefresh={refresh} />);

    expect(screen.getByText('Wiki 增量同步')).toBeTruthy();
    expect(screen.getByText('indexer exited')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'CodeGraph' } });
    expect(screen.queryByText('Wiki 增量同步')).toBeNull();
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'running' } });
    expect(screen.queryByText('CodeGraph 同步')).toBeNull();

    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith('job-1'));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('delegates task creation to the parent with the selected workspace', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    render(<JobsPanel jobs={[]} workspace="/workspace" onCreate={create} />);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('wiki.sync', '/workspace'));
  });
});
