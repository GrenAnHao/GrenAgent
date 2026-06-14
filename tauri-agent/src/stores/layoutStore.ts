import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const DEFAULT_RIGHT_PANEL_WIDTH = 320;
export const DEFAULT_TERMINAL_HEIGHT = 200;

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 600;
export const RIGHT_PANEL_MIN_WIDTH = 200;
export const RIGHT_PANEL_MAX_WIDTH = 800;
export const TERMINAL_MIN_HEIGHT = 100;
export const TERMINAL_MAX_HEIGHT = 600;

interface LayoutState {
  sidebarWidth: number;
  sidebarOpen: boolean;
  rightPanelWidth: number;
  rightPanelOpen: boolean;
  terminalHeight: number;
  terminalOpen: boolean;

  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  setTerminalHeight: (height: number) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarOpen: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      rightPanelOpen: false,
      terminalHeight: DEFAULT_TERMINAL_HEIGHT,
      terminalOpen: false,

      setSidebarWidth: (width) =>
        set({
          sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, SIDEBAR_MAX_WIDTH)),
        }),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setRightPanelWidth: (width) =>
        set({
          rightPanelWidth: Math.max(
            RIGHT_PANEL_MIN_WIDTH,
            Math.min(width, RIGHT_PANEL_MAX_WIDTH),
          ),
        }),

      toggleRightPanel: () =>
        set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

      setTerminalHeight: (height) =>
        set({
          terminalHeight: Math.max(
            TERMINAL_MIN_HEIGHT,
            Math.min(height, TERMINAL_MAX_HEIGHT),
          ),
        }),

      toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

      setTerminalOpen: (open) => set({ terminalOpen: open }),
    }),
    {
      name: 'hermes-layout',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        sidebarOpen: state.sidebarOpen,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelOpen: state.rightPanelOpen,
        terminalHeight: state.terminalHeight,
        terminalOpen: state.terminalOpen,
      }),
    },
  ),
);
