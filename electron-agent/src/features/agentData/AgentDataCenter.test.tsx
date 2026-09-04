// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDataCenter } from './AgentDataCenter';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: {
    status: vi.fn(),
    jobs: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
    memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() },
    wiki: { overview: vi.fn(), search: vi.fn() },
    code: { projects: vi.fn(), status: vi.fn(), search: vi.fn() },
  },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('AgentDataCenter', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentDataApi.status).mockResolvedValue({ state: 'ready', version: 1 });
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 248, byLevel: { L0: 120, L1: 64, L2: 48, L3: 16 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([]);
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 12, latestUpdatedAt: 100 });
    vi.mocked(agentDataApi.wiki.search).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
  });

  it('loads global memory and wiki overviews without any workspace', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    expect(agentDataApi.memory.overview).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true });
    expect(agentDataApi.wiki.overview).toHaveBeenCalledWith(undefined);
    // Code 概览不预取：它需要用户先选项目。
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('does not refetch when the initial workspace prop changes', async () => {
    const { rerender } = render(<AgentDataCenter userId="u" initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1));

    rerender(<AgentDataCenter userId="u" initialProject="D:/proj/beta" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1);
  });

  it('switches views and surfaces runtime failures', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(screen.getByTestId('memory-panel')).toBeTruthy();
  });

  it('shows runtime failures in the shared error state', async () => {
    vi.mocked(agentDataApi.status).mockRejectedValueOnce(new Error('runtime unavailable'));
    render(<AgentDataCenter userId="u" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('runtime unavailable'));
  });
});
