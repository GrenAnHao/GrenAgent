import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProjectContextPastedText } from './projectContextCitation';
import { useDockStore } from '../../../../stores/dockStore';
import { useLayoutStore } from '../../../../stores/layoutStore';

const { gitLoad, piHandlers } = vi.hoisted(() => ({
  gitLoad: vi.fn(),
  piHandlers: [] as Array<(e: { workspace: string; source?: string; event: { type: string } }) => void>,
}));
vi.mock('../../../../lib/pi', () => ({
  onPiEvent: vi.fn((handler: (typeof piHandlers)[number]) => {
    piHandlers.push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock('../../../../store/session', () => ({
  useSessionStore: (selector: (state: { worksDir: string }) => unknown) => selector({ worksDir: '/works' }),
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/repo' }),
}));
vi.mock('../../../../stores/gitStore', () => ({
  useGitInfo: () => ({ current: '', branches: [], changes: [], loading: false, loaded: true }),
  useGitStore: { getState: () => ({ load: gitLoad }) },
}));
vi.mock('./TaskTray', () => ({ TaskTray: () => <span data-testid="task-tray" /> }));

import { WorkspaceBar } from './WorkspaceBar';

beforeEach(() => {
  gitLoad.mockClear();
  piHandlers.length = 0;
  useDockStore.setState({ tabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false });
});
afterEach(cleanup);

describe('WorkspaceBar', () => {
  it('does not expose the retired code index or graph entries', () => {
    render(<WorkspaceBar />);
    expect(screen.queryByTestId('code-index-button')).toBeNull();
    expect(screen.queryByTestId('code-graph-button')).toBeNull();
    expect(screen.queryByTestId('project-context-card')).toBeNull();
    expect(screen.queryByRole('dialog', { name: /项目上下文/ })).toBeNull();
    expect(screen.getByTestId('task-tray')).toBeTruthy();
    expect(screen.getByText('没有可用的本地分支')).toBeTruthy();
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

  it('子代理的工具事件不刷新 git；主会话的工具结束才刷新', async () => {
    render(<WorkspaceBar />);
    await Promise.resolve();
    expect(gitLoad).toHaveBeenCalledTimes(1);
    const emit = (source: string, type: string) => {
      for (const handler of piHandlers) handler({ workspace: '/repo', source, event: { type } });
    };
    // 十个子代理并行时每个工具结束都会来一条，每条都跑 git status / branch 会把机器拖慢
    emit('subagent', 'tool_execution_end');
    emit('subagent', 'agent_end');
    expect(gitLoad).toHaveBeenCalledTimes(1);
    emit('interactive', 'tool_execution_end');
    expect(gitLoad).toHaveBeenCalledTimes(2);
  });

  it('places the project context chip last and opens it in the existing right dock', () => {
    render(<WorkspaceBar />);

    const projectContext = screen.getByRole('button', { name: '项目上下文' });
    expect(projectContext.parentElement?.lastElementChild).toBe(projectContext);

    fireEvent.click(projectContext);

    expect(useDockStore.getState().activeByRegion.right).toBe('project-context');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });
});
