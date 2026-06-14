import { describe, it, expect, beforeEach } from 'vitest';
import {
  useLayoutStore,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_HEIGHT,
} from './layoutStore';

describe('layoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarOpen: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      rightPanelOpen: false,
      terminalHeight: DEFAULT_TERMINAL_HEIGHT,
      terminalOpen: false,
    });
  });

  it('should have default values', () => {
    const state = useLayoutStore.getState();
    expect(state.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(state.rightPanelWidth).toBe(DEFAULT_RIGHT_PANEL_WIDTH);
    expect(state.terminalHeight).toBe(DEFAULT_TERMINAL_HEIGHT);
    expect(state.sidebarOpen).toBe(true);
    expect(state.rightPanelOpen).toBe(false);
    expect(state.terminalOpen).toBe(false);
  });

  it('should update sidebar width', () => {
    useLayoutStore.getState().setSidebarWidth(300);
    expect(useLayoutStore.getState().sidebarWidth).toBe(300);
  });

  it('should toggle sidebar', () => {
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('should update right panel width', () => {
    useLayoutStore.getState().setRightPanelWidth(400);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(400);
  });

  it('should toggle right panel', () => {
    useLayoutStore.getState().toggleRightPanel();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    useLayoutStore.getState().toggleRightPanel();
    expect(useLayoutStore.getState().rightPanelOpen).toBe(false);
  });

  it('should update terminal height', () => {
    useLayoutStore.getState().setTerminalHeight(300);
    expect(useLayoutStore.getState().terminalHeight).toBe(300);
  });

  it('should toggle terminal', () => {
    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    useLayoutStore.getState().toggleTerminal();
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });

  it('should set terminal open explicitly (idempotent)', () => {
    useLayoutStore.getState().setTerminalOpen(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    useLayoutStore.getState().setTerminalOpen(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    useLayoutStore.getState().setTerminalOpen(false);
    expect(useLayoutStore.getState().terminalOpen).toBe(false);
  });

  it('should clamp sidebar width to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]', () => {
    useLayoutStore.getState().setSidebarWidth(SIDEBAR_MIN_WIDTH - 1);
    expect(useLayoutStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    useLayoutStore.getState().setSidebarWidth(SIDEBAR_MAX_WIDTH + 1);
    expect(useLayoutStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('should clamp right panel width to [RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH]', () => {
    useLayoutStore.getState().setRightPanelWidth(RIGHT_PANEL_MIN_WIDTH - 1);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MIN_WIDTH);
    useLayoutStore.getState().setRightPanelWidth(RIGHT_PANEL_MAX_WIDTH + 1);
    expect(useLayoutStore.getState().rightPanelWidth).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('should clamp terminal height to [TERMINAL_MIN_HEIGHT, TERMINAL_MAX_HEIGHT]', () => {
    useLayoutStore.getState().setTerminalHeight(TERMINAL_MIN_HEIGHT - 1);
    expect(useLayoutStore.getState().terminalHeight).toBe(TERMINAL_MIN_HEIGHT);
    useLayoutStore.getState().setTerminalHeight(TERMINAL_MAX_HEIGHT + 1);
    expect(useLayoutStore.getState().terminalHeight).toBe(TERMINAL_MAX_HEIGHT);
  });

  describe('persistence (hermes-layout)', () => {
    it('should write state to localStorage on update', () => {
      localStorage.clear();
      useLayoutStore.getState().setSidebarWidth(300);

      const raw = localStorage.getItem('hermes-layout');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).state.sidebarWidth).toBe(300);
    });

    it('should rehydrate state from localStorage', async () => {
      localStorage.clear();
      localStorage.setItem(
        'hermes-layout',
        JSON.stringify({
          state: {
            sidebarWidth: 321,
            sidebarOpen: false,
            rightPanelWidth: 456,
            rightPanelOpen: true,
            terminalHeight: 234,
            terminalOpen: true,
          },
          version: 0,
        }),
      );

      await useLayoutStore.persist.rehydrate();

      const state = useLayoutStore.getState();
      expect(state.sidebarWidth).toBe(321);
      expect(state.sidebarOpen).toBe(false);
      expect(state.rightPanelWidth).toBe(456);
      expect(state.rightPanelOpen).toBe(true);
      expect(state.terminalHeight).toBe(234);
      expect(state.terminalOpen).toBe(true);
    });
  });
});
