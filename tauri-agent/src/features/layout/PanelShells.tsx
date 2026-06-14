import { memo, type ReactNode } from 'react';
import { ResizeHandle } from '../../components/ResizeHandle';
import {
  useLayoutStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_HEIGHT,
} from '../../stores/layoutStore';

interface SidebarShellProps {
  children: ReactNode;
}

export const SidebarShell = memo(function SidebarShell({ children }: SidebarShellProps) {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  return (
    <ResizeHandle
      placement="left"
      defaultSize={sidebarWidth}
      minSize={SIDEBAR_MIN_WIDTH}
      maxSize={SIDEBAR_MAX_WIDTH}
      onResize={setSidebarWidth}
      expand={sidebarOpen}
      onExpandChange={toggleSidebar}
    >
      {children}
    </ResizeHandle>
  );
});

interface RightPanelShellProps {
  children: ReactNode;
}

export const RightPanelShell = memo(function RightPanelShell({ children }: RightPanelShellProps) {
  const rightPanelOpen = useLayoutStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useLayoutStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useLayoutStore((s) => s.setRightPanelWidth);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <ResizeHandle
      placement="right"
      defaultSize={rightPanelWidth}
      minSize={RIGHT_PANEL_MIN_WIDTH}
      maxSize={RIGHT_PANEL_MAX_WIDTH}
      onResize={setRightPanelWidth}
      expand={rightPanelOpen}
      onExpandChange={toggleRightPanel}
    >
      {children}
    </ResizeHandle>
  );
});

interface TerminalShellProps {
  children: ReactNode;
}

export const TerminalShell = memo(function TerminalShell({ children }: TerminalShellProps) {
  const terminalOpen = useLayoutStore((s) => s.terminalOpen);
  const terminalHeight = useLayoutStore((s) => s.terminalHeight);
  const setTerminalHeight = useLayoutStore((s) => s.setTerminalHeight);
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);

  return (
    <ResizeHandle
      placement="bottom"
      defaultSize={terminalHeight}
      minSize={TERMINAL_MIN_HEIGHT}
      maxSize={TERMINAL_MAX_HEIGHT}
      onResize={setTerminalHeight}
      expand={terminalOpen}
      onExpandChange={toggleTerminal}
    >
      {children}
    </ResizeHandle>
  );
});
