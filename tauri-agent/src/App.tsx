import { useEffect } from 'react';
import { ThemeProvider, ActionIcon, Flexbox } from '@lobehub/ui';
import { Moon, PanelLeftOpen, PanelRightOpen, SquareTerminal, Sun } from 'lucide-react';
import { PanelHeader } from './components/PanelHeader';
import { ThemeBridge } from './components/ThemeBridge';
import { useThemeStore } from './stores/themeStore';
import { ChatView } from './features/chat/ChatView';
import { Sidebar } from './features/sessions/Sidebar';
import { RightPanel } from './features/panels';
import { TerminalPanel } from './features/terminal/TerminalPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { Titlebar } from './components/Titlebar';
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

// 初始工作区。activeWorkspace 由 sessionStore 维护，切项目时更新。
const INITIAL_WORKSPACE = '.';

/** 拉取并刷新当前工作区的会话列表。 */
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

/** 拉取所有项目的全量会话（供侧边栏按项目分组）。 */
async function refreshAllSessions(): Promise<void> {
  const { setAllSessions, setError } = useSessionStore.getState();
  try {
    setAllSessions(await pi.listAllSessions());
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

function Workspace() {
  const { store, workspace } = useAgentStoreContext();
  const isStreaming = store.useStore((s) => s.isStreaming);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);

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

  const appearance = useThemeStore((s) => s.appearance);
  const toggleAppearance = useThemeStore((s) => s.toggleAppearance);

  // 当前工作区变化（含首挂载与跨项目切换）：打开 → 刷新会话 → 切到活跃会话 → 载入消息。
  // 由 [store, workspace] 驱动：切项目时 AgentStoreProvider 重建 store，本 effect 随之重跑。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await pi.openWorkspace(workspace);
      } catch (err) {
        useSessionStore.getState().setError(err instanceof Error ? err.message : String(err));
        return;
      }
      await refreshSessions(workspace);
      await refreshAllSessions();
      const path = useSessionStore.getState().activeSessionPath;
      if (path) {
        try {
          await pi.switchSession(workspace, path);
        } catch {
          /* 会话可能已不存在，忽略 */
        }
      }
      try {
        const { messages } = await pi.getMessages(workspace);
        if (alive) store.loadMessages(messages, { force: true });
      } catch {
        /* 无消息或加载失败，保持空 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [store, workspace]);

  const switchProject = async (cwd: string) => {
    const st = useSessionStore.getState();
    if (st.activeWorkspace === cwd) return;
    await pi.openWorkspace(cwd);
    st.setActiveWorkspace(cwd); // 触发 store 重建 + 上面的 effect 重载
  };

  const handleNewSession = async (cwd: string) => {
    await pi.openWorkspace(cwd);
    const st = useSessionStore.getState();
    st.setActiveSession('');
    await pi.newSession(cwd);
    if (st.activeWorkspace !== cwd) {
      st.setActiveWorkspace(cwd); // effect 重建后会载入新会话
    } else {
      store.reset();
      await refreshSessions(cwd);
    }
    await refreshAllSessions();
  };

  const handleOpenSession = async (cwd: string, path: string) => {
    const st = useSessionStore.getState();
    st.setActiveSession(path);
    if (st.activeWorkspace !== cwd) {
      await switchProject(cwd); // effect 重建后载入该会话
    } else {
      await pi.switchSession(cwd, path);
      const { messages } = await pi.getMessages(cwd);
      store.loadMessages(messages, { force: true });
    }
  };

  const handleDeleteSession = async (cwd: string, path: string) => {
    await pi.deleteSession(cwd, path);
    if (useSessionStore.getState().activeSessionPath === path) {
      useSessionStore.getState().setActiveSession('');
    }
    await refreshSessions(cwd);
    await refreshAllSessions();
  };

  const handleSubmitRename = async (cwd: string, _path: string, name: string) => {
    if (cwd !== useSessionStore.getState().activeWorkspace) {
      await switchProject(cwd);
    }
    await pi.setSessionName(cwd, name);
    await refreshSessions(cwd);
    await refreshAllSessions();
  };

  return (
    <Flexbox style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Titlebar />
      {/* 根容器：Sidebar | 右容器 */}
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        {/* Sidebar：始终挂载，靠 DraggablePanel 的 expand 做收起/展开动画 */}
        <ResizeHandle
          placement="left"
          defaultSize={sidebarWidth}
          minSize={SIDEBAR_MIN_WIDTH}
          maxSize={SIDEBAR_MAX_WIDTH}
          onResize={setSidebarWidth}
          expand={sidebarOpen}
          onExpandChange={toggleSidebar}
        >
          <Sidebar
            runningSessionPath={isStreaming ? activeSessionPath : null}
            onNewSession={handleNewSession}
            onOpenSession={handleOpenSession}
            onDeleteSession={handleDeleteSession}
            onSubmitRename={handleSubmitRename}
            onToggleSidebar={toggleSidebar}
            onOpenSettings={() => {}}
          />
        </ResizeHandle>

      {/* 右容器：上部(Main+Right) / Terminal 竖向分割 */}
      <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
        {/* 上部：Main / RightPanel 横向分割 */}
        <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
          {/* 主列：Header + Chat */}
          <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
            <PanelHeader
              left={
                !sidebarOpen ? (
                  <ActionIcon icon={PanelLeftOpen} title="Sidebar" onClick={toggleSidebar} />
                ) : undefined
              }
              actions={
                <>
                  {/* 主题：亮/暗切换 */}
                  <ActionIcon
                    icon={appearance === 'dark' ? Sun : Moon}
                    title={appearance === 'dark' ? 'Light mode' : 'Dark mode'}
                    onClick={toggleAppearance}
                  />
                  {/* 终端：顶部常驻 toggle（active 表示已打开），点击切换收起/展开 */}
                  <ActionIcon
                    icon={SquareTerminal}
                    active={terminalOpen}
                    title="Terminal"
                    onClick={toggleTerminal}
                  />
                  {/* 右面板：仅折叠时显示打开按钮，展开后由面板内折叠图标收起（对齐左侧栏） */}
                  {!rightPanelOpen && (
                    <ActionIcon icon={PanelRightOpen} title="Panel" onClick={toggleRightPanel} />
                  )}
                </>
              }
            />
            <Flexbox flex={1} style={{ minHeight: 0, position: 'relative' }}>
              <ChatView />
            </Flexbox>
          </Flexbox>

          {/* Right Panel：始终挂载，靠 DraggablePanel 的 expand 做收起/展开动画 */}
          <ResizeHandle
            placement="right"
            defaultSize={rightPanelWidth}
            minSize={RIGHT_PANEL_MIN_WIDTH}
            maxSize={RIGHT_PANEL_MAX_WIDTH}
            onResize={setRightPanelWidth}
            expand={rightPanelOpen}
            onExpandChange={toggleRightPanel}
          >
            <RightPanel onCollapse={toggleRightPanel} />
          </ResizeHandle>
        </Flexbox>

        {/* Terminal（仅在 Main+Right 下方）：始终挂载，靠 DraggablePanel 的 expand 做收起/展开动画 */}
        <ResizeHandle
          placement="bottom"
          defaultSize={terminalHeight}
          minSize={TERMINAL_MIN_HEIGHT}
          maxSize={TERMINAL_MAX_HEIGHT}
          onResize={setTerminalHeight}
          expand={terminalOpen}
          onExpandChange={toggleTerminal}
        >
          <TerminalPanel />
        </ResizeHandle>
      </Flexbox>
      </Flexbox>
    </Flexbox>
  );
}

export default function App() {
  const appearance = useThemeStore((s) => s.appearance);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);

  // 初始化 activeWorkspace 并在卸载时关闭当前工作区。
  // 工作区的打开/会话加载由 Workspace 内的 effect（按 store/workspace）负责。
  useEffect(() => {
    useSessionStore.getState().setActiveWorkspace(INITIAL_WORKSPACE);
    return () => {
      void pi.closeWorkspace(useSessionStore.getState().activeWorkspace);
    };
  }, []);

  return (
    <ThemeProvider themeMode={appearance}>
      <ThemeBridge />
      <AgentStoreProvider workspace={activeWorkspace}>
        <Workspace />
      </AgentStoreProvider>
    </ThemeProvider>
  );
}
