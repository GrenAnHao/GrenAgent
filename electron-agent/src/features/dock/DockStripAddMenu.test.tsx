import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const ctx = vi.hoisted(() => ({ workspace: '/repo' }));

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lobehub/ui')>();
  return {
    ...actual,
    Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
      <div>
        {children}
        {content}
      </div>
    ),
  };
});

import { DockStripAddMenu } from './DockStripAddMenu';

afterEach(cleanup);

function resetStores() {
  localStorage.clear();
  ctx.workspace = '/repo';
  useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('DockStripAddMenu', () => {
  beforeEach(resetStores);

  it('lists project launcher items and opens a browser tab in this region', () => {
    render(<DockStripAddMenu region="bottom" />);
    expect(screen.getByTestId('dock-add-review').textContent).toContain('审查');
    expect(screen.getByTestId('dock-add-terminal').textContent).toContain('Ctrl+`');
    expect(screen.getByTestId('dock-add-browser').textContent).toContain('Ctrl+T');
    expect(screen.getByTestId('dock-add-file').textContent).toContain('文件');

    fireEvent.click(screen.getByTestId('dock-add-browser'));
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('browser');
    expect(tabs[0].region).toBe('bottom');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('offers file but not review for a casual conversation', () => {
    ctx.workspace = '/home/.pi/agent/works/u1';
    render(<DockStripAddMenu region="right" />);
    expect(screen.getByTestId('dock-add-browser')).toBeTruthy();
    expect(screen.getByTestId('dock-add-terminal')).toBeTruthy();
    expect(screen.queryByTestId('dock-add-review')).toBeNull();
    expect((screen.getByTestId('dock-add-file') as HTMLButtonElement).disabled).toBe(false);
  });
});
