import { useCallback, useEffect, memo } from 'react';
import { ThemeProvider, Flexbox } from '@lobehub/ui';
import { ThemeBridge } from './components/ThemeBridge';
import { useThemeStore } from './stores/themeStore';
import { ChatView } from './features/chat/ChatView';
import { Sidebar } from './features/sessions/Sidebar';
import { RightPanel } from './features/panels';
import { TerminalPanel } from './features/terminal/TerminalPanel';
import { Titlebar } from './components/Titlebar';
import { AgentStoreProvider, useAgentStoreContext } from './stores/AgentStoreContext';
import { useSessionStore } from './store';
import { useLayoutStore } from './stores/layoutStore';
import { MainColumnHeader } from './features/layout/MainColumnHeader';
import { RightPanelShell, SidebarShell, TerminalShell } from './features/layout/PanelShells';
import { ModuleRail } from './features/layout/ModuleRail';
import { ModuleContainer } from './features/workspace/ModuleContainer';
import { FullscreenLoading } from './components/FullscreenLoading';
import { pi, type OpenWorkspaceResult } from './lib/pi';
import { createStartupPerf } from './lib/startupPerf';
import { pathsEquivalent } from './lib/pathUtils';
import {
  getAllSessionsInflight,
  getCachedAllSessions,
  invalidateAllSessionsCache,
  setAllSessionsInflight,
  setCachedAllSessions,
} from './lib/sessionCache';

// 初始工作区。activeWorkspace 由 sessionStore 维护，切项目时更新。
const INITIAL_WORKSPACE = '.';

/** 拉取并刷新当前工作区的会话列表。 */
async function refreshSessions(
  workspace: string,
  openResult?: OpenWorkspaceResult,
): Promise<void> {
  const { setSessions, setActiveSession, setError } = useSessionStore.getState();
  try {
    const sessions = await pi.listSessions(workspace);
    setSessions(sessions);
    const active = useSessionStore.getState().activeSessionPath;
    if (!active) {
      if (openResult?.sessionFile) {
        setActiveSession(openResult.sessionFile);
      } else if (sessions.length > 0) {
        setActiveSession(sessions[0].path);
      }
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

/** 拉取所有项目的全量会话（供侧边栏按项目分组），带短期缓存。 */
async function refreshAllSessions(force = false): Promise<void> {
  const { setAllSessions, setAllSessionsLoading, setError } = useSessionStore.getState();

  if (!force) {
    const cached = getCachedAllSessions();
    if (cached) {
      setAllSessions(cached);
      return;
    }
    const inflight = getAllSessionsInflight();
    if (inflight) {
      setAllSessionsLoading(true);
      try {
        setAllSessions(await inflight);
      } finally {
        setAllSessionsLoading(false);
      }
      return;
    }
  }

  setAllSessionsLoading(true);
  const request = pi
    .listAllSessions()
    .then((sessions) => {
      setCachedAllSessions(sessions);
      setAllSessions(sessions);
      return sessions;
    })
    .catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    })
    .finally(() => {
      setAllSessionsLoading(false);
      setAllSessionsInflight(null);
    });

  setAllSessionsInflight(request);
  await request;
}

function sessionAlreadyActive(path: string | null, openResult: OpenWorkspaceResult): boolean {
  if (!path) return false;
  if (openResult.sessionFile && pathsEquivalent(path, openResult.sessionFile)) return true;
  if (openResult.restoredSession && pathsEquivalent(path, openResult.restoredSession)) return true;
  return false;
}

const MainChatColumn = memo(function MainChatColumn() {
  return (
    <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
      <MainColumnHeader />
      <Flexbox flex={1} style={{ minHeight: 0, position: 'relative' }}>
        <ChatView />
      </Flexbox>
    </Flexbox>
  );
});

const SidebarPanel = memo(function SidebarPanel({
  runningSessionPath,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onSubmitRename,
}: {
  runningSessionPath: string | null;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
}) {
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  return (
    <SidebarShell>
      <Sidebar
        runningSessionPath={runningSessionPath}
        onNewSession={onNewSession}
        onOpenSession={onOpenSession}
        onDeleteSession={onDeleteSession}
        onSubmitRename={onSubmitRename}
        onToggleSidebar={toggleSidebar}
      />
    </SidebarShell>
  );
});

const RightPanelColumn = memo(function RightPanelColumn() {
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <RightPanelShell>
      <RightPanel onCollapse={toggleRightPanel} />
    </RightPanelShell>
  );
});

const TerminalColumn = memo(function TerminalColumn() {
  return (
    <TerminalShell>
      <TerminalPanel />
    </TerminalShell>
  );
});

function Workspace() {
  const { store, workspace, setWorkspaceReady, workspaceReady } = useAgentStoreContext();
  const isStreaming = store.useStore((s) => s.isStreaming);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);

  // 首屏先渲染 UI 骨架；openWorkspace 完成后并行加载会话与消息，全量会话后台刷新。
  useEffect(() => {
    let alive = true;
    const perf = createStartupPerf(workspace);

    void (async () => {
      setWorkspaceReady(false);
      useSessionStore.getState().setLoading(true);

      try {
        perf.start('openWorkspace');
        const openResult = await pi.openWorkspace(workspace);
        perf.end('openWorkspace');
        if (!alive) return;

        setWorkspaceReady(true);

        perf.start('refreshSessions');
        await refreshSessions(workspace, openResult);
        perf.end('refreshSessions');
        if (!alive) return;

        const path = useSessionStore.getState().activeSessionPath;
        if (path && !sessionAlreadyActive(path, openResult)) {
          perf.start('switchSession');
          try {
            await pi.switchSession(workspace, path);
          } catch {
            /* 会话可能已不存在，忽略 */
          }
          perf.end('switchSession');
        }

        perf.start('getMessages');
        try {
          const { messages } = await pi.getMessages(workspace);
          if (alive) store.loadMessages(messages, { force: true });
        } catch {
          /* 无消息或加载失败，保持空 */
        }
        perf.end('getMessages');
      } catch (err) {
        useSessionStore.getState().setError(err instanceof Error ? err.message : String(err));
      } finally {
        useSessionStore.getState().setLoading(false);
        perf.report();
      }
    })();

    // 全量会话不阻塞消息区首屏
    void refreshAllSessions();

    return () => {
      alive = false;
      setWorkspaceReady(false);
    };
  }, [store, workspace, setWorkspaceReady]);

  const switchProject = useCallback(async (cwd: string) => {
    const st = useSessionStore.getState();
    if (st.activeWorkspace === cwd) return;
    await pi.openWorkspace(cwd);
    st.setActiveWorkspace(cwd);
  }, []);

  const handleNewSession = useCallback(async (cwd: string) => {
    await pi.openWorkspace(cwd);
    const st = useSessionStore.getState();
    st.setActiveSession('');
    await pi.newSession(cwd);
    invalidateAllSessionsCache();
    if (st.activeWorkspace !== cwd) {
      st.setActiveWorkspace(cwd);
    } else {
      store.reset();
      await refreshSessions(cwd);
    }
    void refreshAllSessions(true);
  }, [store]);

  const handleOpenSession = useCallback(
    async (cwd: string, path: string) => {
      const st = useSessionStore.getState();
      st.setActiveSession(path);
      if (st.activeWorkspace !== cwd) {
        await switchProject(cwd);
      } else {
        await pi.switchSession(cwd, path);
        const { messages } = await pi.getMessages(cwd);
        store.loadMessages(messages, { force: true });
      }
    },
    [store, switchProject],
  );

  const handleDeleteSession = useCallback(async (cwd: string, path: string) => {
    await pi.deleteSession(cwd, path);
    invalidateAllSessionsCache();
    if (useSessionStore.getState().activeSessionPath === path) {
      useSessionStore.getState().setActiveSession('');
    }
    await refreshSessions(cwd);
    void refreshAllSessions(true);
  }, []);

  const handleSubmitRename = useCallback(async (cwd: string, _path: string, name: string) => {
    if (cwd !== useSessionStore.getState().activeWorkspace) {
      await switchProject(cwd);
    }
    await pi.setSessionName(cwd, name);
    invalidateAllSessionsCache();
    await refreshSessions(cwd);
    void refreshAllSessions(true);
  }, [switchProject]);

  const runningSessionPath = isStreaming ? activeSessionPath : null;

  return (
    <Flexbox style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Titlebar />
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <ModuleRail />
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%', background: 'var(--gren-content-bg, transparent)' }}>
          <ModuleContainer
            chat={
              <Flexbox horizontal flex={1} style={{ minHeight: 0, height: '100%' }}>
                <SidebarPanel
                  runningSessionPath={runningSessionPath}
                  onNewSession={handleNewSession}
                  onOpenSession={handleOpenSession}
                  onDeleteSession={handleDeleteSession}
                  onSubmitRename={handleSubmitRename}
                />
                <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
                  <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
                    <MainChatColumn />
                    <RightPanelColumn />
                  </Flexbox>
                  <TerminalColumn />
                </Flexbox>
              </Flexbox>
            }
          />
        </Flexbox>
      </Flexbox>
      <FullscreenLoading visible={!workspaceReady} />
    </Flexbox>
  );
}

export default function App() {
  const appearance = useThemeStore((s) => s.appearance);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);

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
