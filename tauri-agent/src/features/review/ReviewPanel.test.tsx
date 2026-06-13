import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const { rvList } = vi.hoisted(() => ({
  rvList: vi.fn(() =>
    Promise.resolve([
      { id: 'n1', file: 'a.ts', line: 10, severity: 'major', message: 'bug here', createdAt: 100 },
      { id: 'n2', file: 'b.ts', line: null, severity: 'nit', message: 'style', createdAt: 200 },
    ]),
  ),
}));
vi.mock('../../lib/pi', () => ({ pi: { rvList } }));

import { ReviewPanel } from './ReviewPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReviewPanel', () => {
  it('shows total and grouped findings', async () => {
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('rv-header').textContent).toContain('2'));
    expect(screen.getByTestId('rv-note-n1').textContent).toContain('a.ts');
    expect(screen.getByTestId('rv-note-n1').textContent).toContain('10');
    expect(screen.getByTestId('rv-note-n2')).toBeTruthy();
  });

  it('shows detail when a finding is clicked', async () => {
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('rv-note-n1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('rv-note-n1'));
    expect(screen.getByTestId('rv-detail').textContent).toContain('bug here');
    expect(screen.getByTestId('rv-detail').textContent).toContain('major');
  });
});
