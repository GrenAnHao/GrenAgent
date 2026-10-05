// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleRail } from './ModuleRail';
import { useModuleStore } from '../../stores/moduleStore';
import { SIDEBAR_AUTO_COLLAPSE_WIDTH, SIDEBAR_DRAWER_HOVER_CLOSE_MS, useLayoutStore } from '../../stores/layoutStore';
import { IS_DEV } from '../../lib/devMode';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
  useLayoutStore.setState({ sidebarOpen: true, sidebarDrawer: null, availableWidth: 1200 });
});

afterEach(() => {
  cleanup();
  useLayoutStore.getState().cancelSidebarHoverClose();
  vi.useRealTimers();
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

  it('手动收起会话列后，悬停对话标签滑出抽屉', () => {
    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: null, availableWidth: 1200 });
    render(<ModuleRail />);
    fireEvent.pointerEnter(screen.getByTestId('module-chat'));
    expect(useLayoutStore.getState().sidebarDrawer).toBe('hover');
  });

  it('最小宽度下手动收起后，悬停对话标签同样滑出', () => {
    useLayoutStore.setState({
      sidebarOpen: false,
      sidebarDrawer: null,
      availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
    });
    render(<ModuleRail />);
    fireEvent.pointerEnter(screen.getByTestId('module-chat'));
    expect(useLayoutStore.getState().sidebarDrawer).toBe('hover');
  });

  it('会话列仍是停靠意图时，悬停对话标签不滑出', () => {
    useLayoutStore.setState({
      sidebarOpen: true,
      sidebarDrawer: null,
      availableWidth: SIDEBAR_AUTO_COLLAPSE_WIDTH,
    });
    render(<ModuleRail />);
    fireEvent.pointerEnter(screen.getByTestId('module-chat'));
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('指针离开对话标签后收回悬停抽屉', () => {
    vi.useFakeTimers();
    useLayoutStore.setState({ sidebarOpen: false, sidebarDrawer: null, availableWidth: 1200 });
    render(<ModuleRail />);
    fireEvent.pointerEnter(screen.getByTestId('module-chat'));
    fireEvent.pointerLeave(screen.getByTestId('module-chat'));
    vi.advanceTimersByTime(SIDEBAR_DRAWER_HOVER_CLOSE_MS);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });
});
