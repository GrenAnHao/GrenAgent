// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiPanel } from './WikiPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { wiki: { overview: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

describe('WikiPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 1, latestUpdatedAt: 2 });
    vi.mocked(agentDataApi.wiki.search).mockResolvedValue([{
      workspace: '/workspace', page: 'architecture', title: 'Architecture', snippet: 'Agent Data Runtime', sourcePath: 'docs/architecture.md', chunks: 3,
    }]);
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'wiki.sync', workspace: '/workspace', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('searches wiki sources and creates a sync job', async () => {
    render(<WikiPanel workspace="/workspace" onJobCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('搜索 Wiki'), { target: { value: 'Agent Data' } });
    expect(await screen.findByText('docs/architecture.md')).toBeTruthy();
    expect(screen.getByText('3 个分块')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '同步 Wiki' }));
    expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'wiki.sync', workspace: '/workspace' });
  });
});
