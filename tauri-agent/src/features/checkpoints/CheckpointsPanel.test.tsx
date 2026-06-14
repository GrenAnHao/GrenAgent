import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { cpList, cpDiff, runCommand } = vi.hoisted(() => ({
  cpList: vi.fn(() =>
    Promise.resolve([
      { id: 'c2', hash: 'h2', label: 'edit config', kind: 'auto', files: [{ file: 'a.ts', status: 'M' }], createdAt: 200 },
      { id: 'c1', hash: 'h1', label: 'init', kind: 'manual', files: [], createdAt: 100 },
    ]),
  ),
  cpDiff: vi.fn(() => Promise.resolve('--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new')),
  runCommand: vi.fn(() => Promise.resolve('')),
}));
vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }));
vi.mock('../../lib/pi', () => ({ pi: { cpList, cpDiff, runCommand } }));
vi.mock('../tools/LazyHighlighter', () => ({
  LazyHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

import { CheckpointsPanel } from './CheckpointsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CheckpointsPanel', () => {
  it('lists checkpoints newest-first', async () => {
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    expect(screen.getByTestId('cp-item-c2').textContent).toContain('edit config');
    expect(screen.getByTestId('cp-item-c1').textContent).toContain('init');
  });

  it('shows diff when a checkpoint is selected', async () => {
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-item-c2'));
    await waitFor(() => expect(cpDiff).toHaveBeenCalledWith('/ws', 'c2'));
    expect(screen.getByTestId('cp-detail').textContent).toContain('+new');
  });

  it('reverts via /checkpoint revert', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CheckpointsPanel />);
    await waitFor(() => expect(screen.getByTestId('cp-item-c2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-item-c2'));
    await waitFor(() => expect(screen.getByTestId('cp-revert')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cp-revert'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/checkpoint revert c2'));
  });
});
