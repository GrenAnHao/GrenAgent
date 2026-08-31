import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDataCenter } from './AgentDataCenter';

vi.mock('../../lib/agentData', () => ({ agentDataApi: { status: vi.fn(), jobs: { list: vi.fn() } } }));
import { agentDataApi } from '../../lib/agentData';

describe('AgentDataCenter', () => {
  beforeEach(() => { vi.mocked(agentDataApi.status).mockResolvedValue({ state: 'ready', version: 1 }); vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]); });
  it('shows runtime status and reserved module tabs', async () => {
    render(<AgentDataCenter />);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'memory' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'wiki' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'code' })).toBeTruthy();
  });
});
