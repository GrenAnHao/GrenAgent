import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarDrawer, SIDEBAR_DRAWER_MOTION_MS, useSidebarDrawerPresence } from './SidebarDrawer';
import { SIDEBAR_DRAWER_HOVER_CLOSE_MS, useLayoutStore } from '../../stores/layoutStore';
import { useModuleStore } from '../../stores/moduleStore';
import { useSessionStore } from '../../store/session';

function installRow() {
  const row = document.createElement('div');
  row.setAttribute('data-sidebar-row', '');
  document.body.appendChild(row);
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
    x: 56,
    y: 40,
    top: 40,
    left: 56,
    right: 856,
    bottom: 640,
    width: 800,
    height: 600,
    toJSON() {
      return {};
    },
  });
  return row;
}

beforeEach(() => {
  installRow();
  useModuleStore.setState({ activeModule: 'chat' });
  useSessionStore.setState({ activeWorkspace: '/ws', activeSessionPath: 'sess-a' });
  useLayoutStore.setState({
    sidebarOpen: false,
    sidebarDrawer: 'toggle',
    sidebarWidth: 275,
    availableWidth: 800,
  });
});

afterEach(() => {
  cleanup();
  document.querySelector('[data-sidebar-row]')?.remove();
  useLayoutStore.getState().cancelSidebarHoverClose();
  useLayoutStore.setState({ sidebarDrawer: null });
  vi.useRealTimers();
});

describe('SidebarDrawer', () => {
  it('点到抽屉外面收回，点在抽屉里面留着', () => {
    render(
      <SidebarDrawer mode="toggle">
        <button type="button">会话</button>
      </SidebarDrawer>,
    );
    expect(screen.getByTestId('sidebar-drawer').style.left).toBe('56px');
    fireEvent.pointerDown(screen.getByText('会话'));
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
    fireEvent.pointerDown(document.body);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('失焦到对话区时不收回，点到布局外面才收回', () => {
    render(
      <div>
        <SidebarDrawer mode="toggle">
          <button type="button">会话</button>
        </SidebarDrawer>
        <button type="button">外面</button>
      </div>,
    );
    screen.getByText('会话').focus();
    fireEvent.blur(screen.getByTestId('sidebar-drawer'), { relatedTarget: screen.getByText('外面') });
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
    fireEvent.pointerDown(screen.getByText('外面'));
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('Escape 收回按钮打开的抽屉', () => {
    render(
      <SidebarDrawer mode="toggle">
        <button type="button">会话</button>
      </SidebarDrawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('点选会话不收回，指针离开布局后才收回', () => {
    vi.useFakeTimers();
    useLayoutStore.setState({ sidebarDrawer: 'hover' });
    render(
      <SidebarDrawer mode="hover">
        <button type="button">会话</button>
      </SidebarDrawer>,
    );
    fireEvent.pointerDown(screen.getByText('会话'));
    act(() => {
      useSessionStore.setState({ activeSessionPath: 'sess-b' });
    });
    expect(useLayoutStore.getState().sidebarDrawer).toBe('hover');

    fireEvent.pointerLeave(screen.getByTestId('sidebar-drawer'));
    vi.advanceTimersByTime(SIDEBAR_DRAWER_HOVER_CLOSE_MS);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('按钮打开的抽屉同样在指针离开后收回', () => {
    vi.useFakeTimers();
    render(
      <SidebarDrawer mode="toggle">
        <button type="button">会话</button>
      </SidebarDrawer>,
    );
    fireEvent.pointerDown(screen.getByText('会话'));
    expect(useLayoutStore.getState().sidebarDrawer).toBe('toggle');
    fireEvent.pointerLeave(screen.getByTestId('sidebar-drawer'));
    vi.advanceTimersByTime(SIDEBAR_DRAWER_HOVER_CLOSE_MS);
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('离开对话模块时收回抽屉', () => {
    render(
      <SidebarDrawer mode="toggle">
        <span>会话</span>
      </SidebarDrawer>,
    );
    act(() => {
      useModuleStore.setState({ activeModule: 'settings' });
    });
    expect(useLayoutStore.getState().sidebarDrawer).toBeNull();
  });

  it('收回时先滑回去，动画结束后再卸掉', () => {
    vi.useFakeTimers();
    function Host() {
      const mode = useLayoutStore((s) => s.sidebarDrawer);
      const presence = useSidebarDrawerPresence(mode != null, mode);
      if (!presence.present || !presence.mode) return null;
      return (
        <SidebarDrawer mode={presence.mode} entered={presence.entered}>
          <span>会话</span>
        </SidebarDrawer>
      );
    }
    useLayoutStore.setState({ sidebarDrawer: 'toggle' });
    render(<Host />);
    act(() => {
      useLayoutStore.setState({ sidebarDrawer: null });
    });
    const drawer = screen.getByTestId('sidebar-drawer');
    expect(drawer.querySelector('[data-entered="false"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_DRAWER_MOTION_MS + 32);
    });
    expect(screen.queryByTestId('sidebar-drawer')).toBeNull();
  });
});
