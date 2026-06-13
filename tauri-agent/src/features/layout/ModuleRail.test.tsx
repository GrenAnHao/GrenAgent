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
  it('renders all 8 module buttons', () => {
    render(<ModuleRail />);
    for (const id of ['chat', 'knowledge', 'memory', 'review', 'create', 'connections', 'extensions', 'settings']) {
      expect(screen.getByTestId(`module-${id}`)).toBeTruthy();
    }
  });

  it('switches active module on click', () => {
    render(<ModuleRail />);
    fireEvent.click(screen.getByTestId('module-memory'));
    expect(useModuleStore.getState().activeModule).toBe('memory');
  });

  it('marks the active module with aria-pressed', () => {
    useModuleStore.setState({ activeModule: 'review' });
    render(<ModuleRail />);
    expect(screen.getByTestId('module-review').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('module-chat').getAttribute('aria-pressed')).toBe('false');
  });
});
