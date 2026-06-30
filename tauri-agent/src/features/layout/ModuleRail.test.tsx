import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleRail } from './ModuleRail';
import { useModuleStore } from '../../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleRail', () => {
  it('renders only global module buttons', () => {
    render(<ModuleRail />);
    for (const id of ['chat', 'memory', 'connections', 'extensions', 'usage', 'settings']) {
      expect(screen.getByTestId(`module-${id}`)).toBeTruthy();
    }
  });

  it('does not render project-scoped modules (moved to workspace tabs)', () => {
    render(<ModuleRail />);
    for (const id of ['knowledge']) {
      expect(screen.queryByTestId(`module-${id}`)).toBeNull();
    }
  });

  it('switches active module on click', () => {
    render(<ModuleRail />);
    fireEvent.click(screen.getByTestId('module-usage'));
    expect(useModuleStore.getState().activeModule).toBe('usage');
  });

  it('marks the active module with aria-pressed', () => {
    useModuleStore.setState({ activeModule: 'connections' });
    render(<ModuleRail />);
    expect(screen.getByTestId('module-connections').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('module-chat').getAttribute('aria-pressed')).toBe('false');
  });
});
