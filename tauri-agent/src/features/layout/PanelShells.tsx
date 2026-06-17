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
  panelMaxWidth,
  selectSidebarVisible,
  selectRightPanelVisible,
} from '../../stores/layoutStore';

interface SidebarShellProps {
  children: ReactNode;
}

export const SidebarShell = memo(function SidebarShell({ children }: SidebarShellProps) {
  const sidebarVisible = useLayoutStore(selectSidebarVisible);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const availableWidth = useLayoutStore((s) => s.availableWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const setLiveSidebarWidth = useLayoutStore((s) => s.setLiveSidebarWidth);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  // 自适应上限：拖到极限会让右面板自动让位（resolver 处理），故只需保证不溢出窗口。
  const maxSize = panelMaxWidth(availableWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);

  return (
    <ResizeHandle
      placement="left"
      defaultSize={sidebarWidth}
      minSize={SIDEBAR_MIN_WIDTH}
      maxSize={maxSize}
      onResize={setSidebarWidth}
      onResizeLive={setLiveSidebarWidth}
      expand={sidebarVisible}
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
  const rightPanelVisible = useLayoutStore(selectRightPanelVisible);
  const rightPanelWidth = useLayoutStore((s) => s.rightPanelWidth);
  const availableWidth = useLayoutStore((s) => s.availableWidth);
  const setRightPanelWidth = useLayoutStore((s) => s.setRightPanelWidth);
  const setLiveRightPanelWidth = useLayoutStore((s) => s.setLiveRightPanelWidth);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  // 自适应上限：拖到极限会让左侧栏自动让位，确保面板始终贴齐窗口右边并收在窗口内。
  const maxSize = panelMaxWidth(availableWidth, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH);

  return (
    <ResizeHandle
      placement="right"
      defaultSize={rightPanelWidth}
      minSize={RIGHT_PANEL_MIN_WIDTH}
      maxSize={maxSize}
      onResize={setRightPanelWidth}
      onResizeLive={setLiveRightPanelWidth}
      expand={rightPanelVisible}
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
