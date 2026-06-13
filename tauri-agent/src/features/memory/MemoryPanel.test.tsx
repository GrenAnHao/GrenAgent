import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { memStats, memList } = vi.hoisted(() => ({
  memStats: vi.fn(() => Promise.resolve({ project: 1, global: 1 })),
  memList: vi.fn(() =>
    Promise.resolve([
      { id: 'g1', text: 'global fact', category: null, createdAt: 200, scope: 'global' },
      { id: 'p1', text: 'project pref', category: 'preference', createdAt: 100, scope: 'project' },
    ]),
  ),
}));

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({ pi: { memStats, memList } }));

import { MemoryPanel } from './MemoryPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoryPanel', () => {
  it('shows stats and both scopes by default', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-header').textContent).toContain('项目 1'));
    expect(screen.getByTestId('mem-header').textContent).toContain('全局 1');
    expect(screen.getByTestId('mem-item-global-g1')).toBeTruthy();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('filters by scope', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-filter-project'));
    expect(screen.queryByTestId('mem-item-global-g1')).toBeNull();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('shows detail when an item is clicked', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    expect(screen.getByTestId('mem-detail').textContent).toContain('project pref');
    expect(screen.getByTestId('mem-detail').textContent).toContain('preference');
  });
});
