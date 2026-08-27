import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlanModeStore } from '../../stores/planModeStore';
import { useLayoutStore } from '../../stores/layoutStore';

vi.mock('../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({ workspace: '/repo' }),
}));

import { MainColumnHeader } from './MainColumnHeader';

beforeEach(() => {
  usePlanModeStore.setState({ status: undefined });
  useLayoutStore.setState({ rightPanelOpen: false });
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
});
