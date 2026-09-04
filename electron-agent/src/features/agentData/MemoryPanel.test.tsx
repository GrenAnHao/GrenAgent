// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from './MemoryPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('MemoryPanel', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 1, byLevel: { L0: 1, L1: 0, L2: 0, L3: 0 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([{
      id: 'memory-1', level: 2, content: 'Electron 版统一使用 TypeScript Agent Data Runtime',
      source: 'session:s1', scope: 'global', createdAt: 1, updatedAt: 2,
    }]);
  });

  it('queries every project by default without requiring a workspace', async () => {
    render(<MemoryPanel userId="u" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true }));
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'TypeScript' } });
    expect(await screen.findByText('Electron 版统一使用 TypeScript Agent Data Runtime')).toBeTruthy();
    expect(agentDataApi.memory.search).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true }, 'TypeScript', 50);
  });

  it('narrows the query to one project when the filter is set', async () => {
    render(<MemoryPanel userId="u" />);
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: 'D:/proj/beta' } });
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', projectId: 'D:/proj/beta' }));
  });

  it('keeps the panel filter when the initial workspace prop changes', async () => {
    const { rerender } = render(<MemoryPanel userId="u" initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', projectId: 'D:/proj/alpha' }));
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: '' } });
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', includeOtherProjects: true }));

    rerender(<MemoryPanel userId="u" initialProject="D:/proj/beta" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', includeOtherProjects: true });
  });
});
