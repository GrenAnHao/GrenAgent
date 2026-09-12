// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Titlebar } from './Titlebar';
import { useLayoutStore } from '../stores/layoutStore';
import { useModuleStore } from '../stores/moduleStore';

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
  useLayoutStore.setState({
    sidebarOpen: true,
    rightPanelOpen: false,
    availableWidth: 0,
    liveSidebarWidth: null,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Titlebar sidebar toggle', () => {
  it('collapses the sidebar from the titlebar and stays there', () => {
    render(<Titlebar />);
    const toggle = screen.getByTestId('sidebar-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('收起会话列表');
    expect(toggle.getAttribute('data-app-region')).toBe('no-drag');
    fireEvent.click(toggle);
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('展开会话列表');
    fireEvent.click(screen.getByTestId('sidebar-toggle'));
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('disables the toggle outside the chat module', () => {
    useModuleStore.setState({ activeModule: 'settings' });
    render(<Titlebar />);
    const toggle = screen.getByTestId('sidebar-toggle');
    fireEvent.click(toggle);
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('does not render the pi mark in the titlebar', () => {
    const { container } = render(<Titlebar />);
    expect(container.querySelector('svg[viewBox="0 0 240 220"]')).toBeNull();
    expect(container.querySelector('svg[viewBox="40 56 160 134"]')).toBeNull();
    expect(screen.getByText('Gren')).toBeTruthy();
  });
});
