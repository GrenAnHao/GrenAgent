import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

const ctx = vi.hoisted(() => ({
  workspace: '/repo',
}));

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ctx,
}));

import { DockLauncher } from './DockLauncher';

afterEach(cleanup);

function renderLauncher(region: 'right' | 'bottom' = 'bottom') {
  return render(
    <DndContext>
      <DockLauncher region={region} />
    </DndContext>,
  );
}

function resetStores() {
  localStorage.clear();
  ctx.workspace = '/repo';
  useSessionStore.setState({ worksDir: '/home/.pi/agent/works' });
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
}

describe('DockLauncher', () => {
  beforeEach(resetStores);

  it('renders four project pathways and opens a browser tab in the launcher region', () => {
    ctx.workspace = '/repo';
    renderLauncher('bottom');

    expect(screen.getByTestId('dock-launcher-bottom')).toBeTruthy();
    expect(screen.getAllByRole('button').map((el) => el.getAttribute('data-testid'))).toEqual([
      'dock-launcher-review',
      'dock-launcher-terminal',
      'dock-launcher-browser',
      'dock-launcher-file',
    ]);
    expect(screen.getByTestId('dock-launcher-review').textContent).toContain('审查');
    expect(screen.getByTestId('dock-launcher-review').getAttribute('title')).toBe('Ctrl+Shift+G');
    expect(screen.getByTestId('dock-launcher-terminal').textContent).toContain('终端');
    expect(screen.getByTestId('dock-launcher-browser').textContent).toContain('浏览器');
    expect(screen.getByTestId('dock-launcher-file').textContent).toContain('文件');
    expect(screen.getByTestId('dock-launcher-bottom').textContent).not.toContain('占位');
    expect(screen.queryByText('打开标签页')).toBeNull();

    fireEvent.click(screen.getByTestId('dock-launcher-browser'));
    const tabs = useDockStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('browser');
    expect(tabs[0].region).toBe('bottom');
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
  });

  it('hides review and file for a casual conversation', () => {
    ctx.workspace = '/home/.pi/agent/works/u1';
    renderLauncher('right');

    expect(screen.getByText('打开标签页')).toBeTruthy();
    expect(screen.getByText('选择要在侧边面板中打开的标签。')).toBeTruthy();
    expect(screen.getByTestId('dock-launcher-browser')).toBeTruthy();
    expect(screen.getByTestId('dock-launcher-terminal')).toBeTruthy();
    expect(screen.queryByTestId('dock-launcher-review')).toBeNull();
    expect(screen.queryByTestId('dock-launcher-file')).toBeNull();
  });

  it('treats empty workspace as casual with no file row', () => {
    ctx.workspace = '';
    renderLauncher('right');

    expect(screen.getByTestId('dock-launcher-browser')).toBeTruthy();
    expect(screen.queryByTestId('dock-launcher-file')).toBeNull();
    expect(screen.queryByTestId('dock-launcher-review')).toBeNull();
  });
});
