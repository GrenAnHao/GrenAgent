import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlanModeStore } from '../../stores/planModeStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSessionStore } from '../../store/session';

vi.mock('../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({ workspace: '/repo' }),
}));

import { MainColumnHeader } from './MainColumnHeader';

beforeEach(() => {
  usePlanModeStore.setState({ status: undefined });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
  useSessionStore.setState({ activeSessionPath: null });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('MainColumnHeader plan-mode badge', () => {
  it('hides badge when status is undefined', () => {
    render(<MainColumnHeader />);
    expect(screen.queryByTestId('plan-mode-badge')).toBeNull();
  });
  it('shows badge text when status is set', () => {
    usePlanModeStore.setState({ status: '📋 Plan' });
    render(<MainColumnHeader />);
    expect(screen.getByTestId('plan-mode-badge').textContent).toContain('📋 Plan');
  });

  it('does not place the project context entry in the top header', () => {
    render(<MainColumnHeader />);
    expect(screen.queryByRole('button', { name: '项目上下文' })).toBeNull();
  });

  it('does not host the sidebar toggle after collapse', () => {
    useLayoutStore.setState({ sidebarOpen: false, availableWidth: 0 });
    render(<MainColumnHeader />);
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull();
    expect(screen.queryByTitle('Sidebar')).toBeNull();
    expect(screen.queryByTitle('收起会话列表')).toBeNull();
    expect(screen.queryByTitle('展开会话列表')).toBeNull();
  });
});

describe('MainHeaderActions bottom dock', () => {
  it('toggles terminalOpen and is labeled 底栏', () => {
    useLayoutStore.setState({ terminalOpen: false });
    render(<MainColumnHeader />);
    expect(screen.queryByTitle('Terminal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
    const btn = screen.getByRole('button', { name: '底栏' });
    btn.click();
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    btn.click();
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });
});
