import { useEffect } from 'react';
import { ThemeProvider, Header, ActionIcon, Flexbox } from '@lobehub/ui';
import { PanelLeft, PanelRight, SquareTerminal } from 'lucide-react';
import { ChatView } from './features/chat/ChatView';
import { SessionList } from './features/sessions/SessionList';
import { RightPanel } from './features/panels';
import { TerminalPanel } from './features/terminal/TerminalPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { AgentStoreProvider, useAgentStoreContext } from './stores/AgentStoreContext';
import { useSessionStore } from './store';
import {
  useLayoutStore,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_HEIGHT,
} from './stores/layoutStore';
import { pi } from './lib/pi';

// 暂以当前目录为单一工作区。后续可接入工作区选择/审批流程。
const WORKSPACE = '.';

/** 拉取并刷新会话列表。 */
async function refreshSessions(workspace: string): Promise<void> {
  const { setSessions, setActiveSession, setError } = useSessionStore.getState();
  try {
    const sessions = await pi.listSessions(workspace);
    setSessions(sessions);
    const active = useSessionStore.getState().activeSessionPath;
    if (!active && sessions.length > 0) {
      setActiveSession(sessions[0].path);
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

function Workspace() {
  const { store } = useAgentStoreContext();

  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  const rightPanelOpen = useLayoutStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useLayoutStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useLayoutStore((s) => s.setRightPanelWidth);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  const terminalOpen = useLayoutStore((s) => s.terminalOpen);
  const terminalHeight = useLayoutStore((s) => s.terminalHeight);
  const setTerminalHeight = useLayoutStore((s) => s.setTerminalHeight);
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);

  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const handleCreateSession = async () => {
    await pi.newSession(WORKSPACE);
    store.reset();
    await refreshSessions(WORKSPACE);
  };

  const handleSwitchSession = async (path: string) => {
    setActiveSession(path);
    await pi.switchSession(WORKSPACE, path);
    const { messages } = await pi.getMessages(WORKSPACE);
    store.loadMessages(messages, { force: true });
  };

  const handleDeleteSession = async (path: string) => {
    await pi.deleteSession(WORKSPACE, path);
    const active = useSessionStore.getState().activeSessionPath;
    if (active === path) {
      useSessionStore.getState().setActiveSession('');
    }
    await refreshSessions(WORKSPACE);
  };

  return (
    // 根容器：Sidebar | 右容器
    <Flexbox horizontal style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      {sidebarOpen && (
        <ResizeHandle
          placement="left"
          defaultSize={sidebarWidth}
          minSize={SIDEBAR_MIN_WIDTH}
          maxSize={SIDEBAR_MAX_WIDTH}
          onResize={setSidebarWidth}
        >
          <SessionList
            onCreateSession={handleCreateSession}
            onSwitchSession={handleSwitchSession}
            onDeleteSession={handleDeleteSession}
          />
        </ResizeHandle>
      )}

      {/* 右容器：上部(Main+Right) / Terminal 竖向分割 */}
      <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
        {/* 上部：Main / RightPanel 横向分割 */}
        <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
          {/* 主列：Header + Chat */}
          <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
            <Header
              logo={<span style={{ fontWeight: 700, fontSize: 16 }}>Hermes</span>}
              actions={
                <>
                  <ActionIcon
                    icon={SquareTerminal}
                    active={terminalOpen}
                    title="Terminal"
                    onClick={toggleTerminal}
                  />
                  <ActionIcon
                    icon={PanelRight}
                    active={rightPanelOpen}
                    title="Panel"
                    onClick={toggleRightPanel}
                  />
                  <ActionIcon
                    icon={PanelLeft}
                    active={sidebarOpen}
                    title="Sidebar"
                    onClick={toggleSidebar}
                  />
                </>
              }
            />
            <Flexbox flex={1} style={{ minHeight: 0, position: 'relative' }}>
              <ChatView />
            </Flexbox>
          </Flexbox>

          {/* Right Panel */}
          {rightPanelOpen && (
            <ResizeHandle
              placement="right"
              defaultSize={rightPanelWidth}
              minSize={RIGHT_PANEL_MIN_WIDTH}
              maxSize={RIGHT_PANEL_MAX_WIDTH}
              onResize={setRightPanelWidth}
            >
              <RightPanel />
            </ResizeHandle>
          )}
        </Flexbox>

        {/* Terminal（仅在 Main+Right 下方）*/}
        {terminalOpen && (
          <ResizeHandle
            placement="bottom"
            defaultSize={terminalHeight}
            minSize={TERMINAL_MIN_HEIGHT}
            maxSize={TERMINAL_MAX_HEIGHT}
            onResize={setTerminalHeight}
          >
            <TerminalPanel />
          </ResizeHandle>
        )}
      </Flexbox>
    </Flexbox>
  );
}

export default function App() {
  useEffect(() => {
    let active = true;
    pi.openWorkspace(WORKSPACE)
      .then(() => {
        if (active) void refreshSessions(WORKSPACE);
      })
      .catch((err) => {
        useSessionStore.getState().setError(
          err instanceof Error ? err.message : String(err),
        );
      });

    return () => {
      active = false;
      void pi.closeWorkspace(WORKSPACE);
    };
  }, []);

  return (
    <ThemeProvider themeMode="dark">
      <AgentStoreProvider workspace={WORKSPACE}>
        <Workspace />
      </AgentStoreProvider>
    </ThemeProvider>
  );
}
