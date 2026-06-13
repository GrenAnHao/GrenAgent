import { memo } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { PanelLeftOpen, PanelRightOpen, SquareTerminal } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { useLayoutStore } from '../../stores/layoutStore';

/** 仅订阅侧栏开关，避免布局其它变化时重渲染主列 header。 */
export const SidebarToggleButton = memo(function SidebarToggleButton() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  if (sidebarOpen) return null;

  return <ActionIcon icon={PanelLeftOpen} title="Sidebar" onClick={toggleSidebar} />;
});

/** 主题与面板开关，与聊天区解耦订阅。 */
export const MainHeaderActions = memo(function MainHeaderActions() {
  const terminalOpen = useLayoutStore((s) => s.terminalOpen);
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);
  const rightPanelOpen = useLayoutStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <>
      <ActionIcon
        icon={SquareTerminal}
        active={terminalOpen}
        title="Terminal"
        onClick={toggleTerminal}
      />
      {!rightPanelOpen && (
        <ActionIcon icon={PanelRightOpen} title="Panel" onClick={toggleRightPanel} />
      )}
    </>
  );
});

export const MainColumnHeader = memo(function MainColumnHeader() {
  return (
    <PanelHeader
      left={<SidebarToggleButton />}
      actions={
        <>
          <MainHeaderActions />
        </>
      }
    />
  );
});
