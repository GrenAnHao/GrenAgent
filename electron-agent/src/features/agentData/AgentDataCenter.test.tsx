// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDataCenter } from './AgentDataCenter';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: {
    status: vi.fn(),
    jobs: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
    memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() },
    wiki: { overview: vi.fn(), search: vi.fn() },
    code: { status: vi.fn(), search: vi.fn() },
  },
}));
import { agentDataApi } from '../../lib/agentData';

describe('AgentDataCenter', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.status).mockResolvedValue({ state: 'ready', version: 1 });
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 248, byLevel: { L0: 120, L1: 64, L2: 48, L3: 16 } });
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 12, latestUpdatedAt: 100 });
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: '/workspace', connected: false, indexed: false });
  });

  it('renders overview KPIs from runtime data and switches views', async () => {
    render(<AgentDataCenter userId="u" workspace="/workspace" />);
    expect(await screen.findByText('248')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(screen.getByTestId('memory-panel')).toBeTruthy();
  });

  it('shows runtime failures in the shared error state', async () => {
    vi.mocked(agentDataApi.status).mockRejectedValueOnce(new Error('runtime unavailable'));
    render(<AgentDataCenter userId="u" workspace="/workspace" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('runtime unavailable'));
  });
});
