import { memo, type ReactNode } from 'react';
import { cssVar } from 'antd-style';
import { ResizeHandle } from '../../components/ResizeHandle';
import {
  useLayoutStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_REST_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  rightPanelOccupiedWidth,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_HEIGHT,
  panelMaxWidth,
  selectSidebarVisible,
  selectRightPanelVisible,
} from '../../stores/layoutStore';
import { SidebarDrawer, useSidebarDrawerPresence } from './SidebarDrawer';

interface SidebarShellProps {
  children: ReactNode;
}

export const SidebarShell = memo(function SidebarShell({ children }: SidebarShellProps) {
  const sidebarVisible = useLayoutStore(selectSidebarVisible);
  const sidebarDrawer = useLayoutStore((s) => s.sidebarDrawer);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const availableWidth = useLayoutStore((s) => s.availableWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const setLiveSidebarWidth = useLayoutStore((s) => s.setLiveSidebarWidth);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const drawerRequested = sidebarDrawer != null && !sidebarVisible;
  const drawerPresence = useSidebarDrawerPresence(drawerRequested, sidebarDrawer);

  // 上限取 520 与「可用宽度 - 240」的较小值。拖到极限时右面板由 resolver 让位。
  const maxSize = panelMaxWidth(
    availableWidth,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_REST_MIN_WIDTH,
  );

  return (
    <>
      <ResizeHandle
        placement="left"
        defaultSize={sidebarWidth}
        minSize={SIDEBAR_MIN_WIDTH}
        maxSize={maxSize}
        onResize={setSidebarWidth}
        onResizeLive={setLiveSidebarWidth}
        expand={sidebarVisible}
        onExpandChange={toggleSidebar}
        backgroundColor={cssVar.colorBgLayout}
      >
        {drawerPresence.present ? null : children}
      </ResizeHandle>
      {drawerPresence.present && drawerPresence.mode ? (
        <SidebarDrawer mode={drawerPresence.mode} entered={drawerPresence.entered}>
          {children}
        </SidebarDrawer>
      ) : null}
    </>
  );
});

interface RightPanelShellProps {
  children: ReactNode;
}

export const RightPanelShell = memo(function RightPanelShell({ children }: RightPanelShellProps) {
  const rightPanelVisible = useLayoutStore(selectRightPanelVisible);
  const rightPanelWidth = useLayoutStore((s) => s.rightPanelWidth);
  const rightPanelFill = useLayoutStore((s) => s.rightPanelFill);
  const sidebarVisible = useLayoutStore(selectSidebarVisible);
  const sidebarWidth = useLayoutStore((s) => s.liveSidebarWidth ?? s.sidebarWidth);
  const availableWidth = useLayoutStore((s) => s.availableWidth);
  const setRightPanelWidth = useLayoutStore((s) => s.setRightPanelWidth);
  const setLiveRightPanelWidth = useLayoutStore((s) => s.setLiveRightPanelWidth);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  const occupiedWidth = rightPanelOccupiedWidth({
    fill: rightPanelFill,
    availableWidth,
    sidebarWidth,
    sidebarVisible,
    preferredWidth: rightPanelWidth,
  });
  // 普通模式只给中间内容区留 MAIN_COLUMN_MIN_WIDTH。占满时上限就是侧栏让出后的整段宽度。
  const maxSize =
    rightPanelFill && availableWidth > 0
      ? Math.max(RIGHT_PANEL_MIN_WIDTH, occupiedWidth)
      : availableWidth > 0
        ? panelMaxWidth(availableWidth, RIGHT_PANEL_MIN_WIDTH, Number.POSITIVE_INFINITY)
        : DEFAULT_RIGHT_PANEL_WIDTH;

  return (
    <ResizeHandle
      placement="right"
      defaultSize={rightPanelFill ? occupiedWidth : rightPanelWidth}
      minSize={RIGHT_PANEL_MIN_WIDTH}
      maxSize={maxSize}
      onResize={setRightPanelWidth}
      onResizeLive={setLiveRightPanelWidth}
      expand={rightPanelVisible}
      onExpandChange={toggleRightPanel}
      backgroundColor={cssVar.colorBgContainer}
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
      backgroundColor={cssVar.colorBgContainer}
    >
      {children}
    </ResizeHandle>
  );
});
