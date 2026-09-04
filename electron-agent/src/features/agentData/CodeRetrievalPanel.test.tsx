// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('CodeRetrievalPanel', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([
      { workspace: 'D:/proj/alpha', indexed: true },
      { workspace: 'D:/proj/beta', indexed: false },
    ]);
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/alpha', connected: true, indexed: true, state: 'indexed', files: 12, nodes: 34, edges: 56 });
    vi.mocked(agentDataApi.code.search).mockResolvedValue({ workspace: 'D:/proj/alpha', available: true, results: [{ file: 'src/a.ts', line: 3, symbol: 'parse' }] });
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'codegraph.sync', workspace: 'D:/proj/beta', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('requires an explicit project before showing anything', async () => {
    render(<CodeRetrievalPanel />);
    expect(await screen.findByText('请选择一个项目')).toBeTruthy();
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('queries the selected indexed project', async () => {
    render(<CodeRetrievalPanel />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/alpha' } });

    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    expect(await screen.findByText('src/a.ts')).toBeTruthy();
  });

  it('offers to index a selected project that has no index yet', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/beta', connected: false, indexed: false, state: 'unavailable' });
    render(<CodeRetrievalPanel />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/beta' } });

    expect(await screen.findByText('该项目尚未建立 CodeGraph 索引')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '同步索引' }));
    // 同步目标是当前选中项目，而不是应用的活跃工作区。
    await waitFor(() => expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'codegraph.sync', workspace: 'D:/proj/beta' }));
  });

  it('preselects the initial project but keeps manual choices afterwards', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/beta' } });
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenLastCalledWith('D:/proj/beta'));

    rerender(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.code.status).toHaveBeenLastCalledWith('D:/proj/beta');
  });
});
