// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiPanel } from './WikiPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { wiki: { overview: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('WikiPanel', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 2, latestUpdatedAt: 2 });
    vi.mocked(agentDataApi.wiki.search).mockResolvedValue([{
      workspace: 'D:/proj/beta', page: 'architecture', title: 'Architecture',
      snippet: 'Agent Data Runtime', sourcePath: 'docs/architecture.md', chunks: 3,
    }]);
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'wiki.sync', workspace: 'D:/proj/alpha', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('searches every project by default and shows each page origin', async () => {
    render(<WikiPanel />);
    await waitFor(() => expect(agentDataApi.wiki.overview).toHaveBeenCalledWith(undefined));
    fireEvent.change(screen.getByLabelText('搜索 Wiki'), { target: { value: 'Agent Data' } });
    expect(await screen.findByText('docs/architecture.md')).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'beta' })).toBeTruthy();
    expect(agentDataApi.wiki.search).toHaveBeenCalledWith(undefined, 'Agent Data', 50);
  });

  it('narrows to one project and syncs that project', async () => {
    const onJobCreated = vi.fn();
    render(<WikiPanel onJobCreated={onJobCreated} />);
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: 'D:/proj/alpha' } });
    await waitFor(() => expect(agentDataApi.wiki.overview).toHaveBeenLastCalledWith('D:/proj/alpha'));

    fireEvent.click(screen.getByRole('button', { name: '同步 Wiki' }));
    await waitFor(() => expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'wiki.sync', workspace: 'D:/proj/alpha' }));
    expect(onJobCreated).toHaveBeenCalled();
  });

  it('disables sync while the scope is global because sync targets one project', async () => {
    render(<WikiPanel />);
    expect(screen.getByRole('button', { name: '同步 Wiki' }).hasAttribute('disabled')).toBe(true);
  });
});
