import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/pi', () => ({ onPiEvent: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../../../store/session', () => ({
  useSessionStore: (selector: (state: { worksDir: string }) => unknown) => selector({ worksDir: '/works' }),
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo' }),
}));
vi.mock('../../../../stores/gitStore', () => ({
  useGitInfo: () => ({ current: '', branches: [] }),
  useGitStore: { getState: () => ({ load: vi.fn() }) },
}));
vi.mock('./TaskTray', () => ({ TaskTray: () => <span data-testid="task-tray" /> }));

import { WorkspaceBar } from './WorkspaceBar';

afterEach(cleanup);

describe('WorkspaceBar', () => {
  it('does not expose the retired code index or graph entries', () => {
    render(<WorkspaceBar />);
    expect(screen.queryByTestId('code-index-button')).toBeNull();
    expect(screen.queryByTestId('code-graph-button')).toBeNull();
    expect(screen.getByTestId('task-tray')).toBeTruthy();
  });
});
