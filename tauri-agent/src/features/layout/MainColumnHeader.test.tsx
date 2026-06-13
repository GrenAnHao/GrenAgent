import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePlanModeStore } from '../../stores/planModeStore';
import { MainColumnHeader } from './MainColumnHeader';

beforeEach(() => usePlanModeStore.setState({ status: undefined }));
afterEach(cleanup);

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
});
