// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleRail } from './ModuleRail';
import { useModuleStore } from '../../stores/moduleStore';
import { IS_DEV } from '../../lib/devMode';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleRail', () => {
  it('renders only global module buttons', () => {
    render(<ModuleRail />);
    for (const id of ['chat', 'extensions', 'usage', 'settings']) {
      expect(screen.getByTestId(`module-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('module-connections')).toBeNull();
  });

  it('does not render retired memory or project-scoped modules', () => {
    render(<ModuleRail />);
    for (const id of ['memory', 'knowledge']) {
      expect(screen.queryByTestId(`module-${id}`)).toBeNull();
    }
  });

  // 入口存在与否完全由构建模式决定：DEV 构建（vitest 跑的就是）应该露出来。
  it('renders the dev workbench entry only in dev builds', () => {
    render(<ModuleRail />);
    const entry = screen.queryByTestId('module-devWorkbench');
    if (IS_DEV) expect(entry).toBeTruthy();
    else expect(entry).toBeNull();
  });

  it('opens the dev workbench from the rail in dev builds', () => {
    render(<ModuleRail />);
    const entry = screen.queryByTestId('module-devWorkbench');
    if (!entry) {
      expect(IS_DEV).toBe(false);
      return;
    }
    fireEvent.click(entry);
    expect(useModuleStore.getState().activeModule).toBe('devWorkbench');
  });

  it('switches active module on click', () => {
    render(<ModuleRail />);
    fireEvent.click(screen.getByTestId('module-usage'));
    expect(useModuleStore.getState().activeModule).toBe('usage');
  });

  it('marks the active module with aria-pressed', () => {
    useModuleStore.setState({ activeModule: 'usage' });
    render(<ModuleRail />);
    expect(screen.getByTestId('module-usage').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('module-chat').getAttribute('aria-pressed')).toBe('false');
  });
});
