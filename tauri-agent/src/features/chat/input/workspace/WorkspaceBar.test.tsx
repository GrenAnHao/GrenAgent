import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProjectContextPastedText } from './projectContextCitation';

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

  it('accepts a typed project context reference callback', () => {
    const onReferencePastedText = vi.fn();
    const citation = makeProjectContextPastedText({
      text: 'CodeGraph: WorkspaceBar callers',
      source: 'project:///repo/codegraph',
      label: 'CodeGraph',
    });

    render(<WorkspaceBar onReferencePastedText={onReferencePastedText} />);

    onReferencePastedText(citation);

    expect(onReferencePastedText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'CodeGraph: WorkspaceBar callers',
        source: 'project:///repo/codegraph',
        lines: 1,
        chars: 31,
        referenceOnly: false,
      }),
    );
  });
});
