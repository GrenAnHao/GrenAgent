// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { code: { status: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

describe('CodeRetrievalPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: '/workspace', connected: false, indexed: false, state: 'unavailable', files: 0, nodes: 0, edges: 0 });
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'codegraph.sync', workspace: '/workspace', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('shows unavailable status and creates an index sync job', async () => {
    render(<CodeRetrievalPanel workspace="/workspace" />);
    expect(await screen.findByText('CodeGraph 索引尚未连接')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '同步索引' }));
    await waitFor(() => expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'codegraph.sync', workspace: '/workspace' }));
  });
});
