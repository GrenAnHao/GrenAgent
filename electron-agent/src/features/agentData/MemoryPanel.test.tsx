// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from './MemoryPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

describe('MemoryPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 1, byLevel: { L0: 1, L1: 0, L2: 0, L3: 0 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([{
      id: 'memory-1', level: 0, content: 'Electron 版统一使用 TypeScript Agent Data Runtime', source: 'session:s1', createdAt: 1, updatedAt: 2,
    }]);
  });

  it('searches memory by scope and level and shows its source', async () => {
    render(<MemoryPanel userId="u" workspace="/workspace" />);
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'TypeScript' } });
    expect(await screen.findByText('Electron 版统一使用 TypeScript Agent Data Runtime')).toBeTruthy();
    expect(screen.getByText('session:s1')).toBeTruthy();
    expect(agentDataApi.memory.search).toHaveBeenCalledWith({ userId: 'u', workspace: '/workspace' }, 'TypeScript', 50);
  });
});
