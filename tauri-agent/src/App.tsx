import { useCallback, useEffect, useMemo, useRef, memo } from 'react';
import { ThemeProvider, Flexbox } from '@lobehub/ui';
import { ThemeBridge } from './components/ThemeBridge';
import { ExtensionUiHost } from './features/extensionUi/ExtensionUiHost';
import { useThemeStore } from './stores/themeStore';
import { ChatView } from './features/chat/ChatView';
import { Sidebar } from './features/sessions/Sidebar';
import { DockPanel } from './features/dock/DockPanel';
import { DockDndProvider } from './features/dock/DockDndProvider';
import { useDockStore } from './stores/dockStore';
import { Titlebar } from './components/Titlebar';
import { AgentStoreProvider, useAgentStoreContext } from './stores/AgentStoreContext';
import { agentStoreRegistry, useAgentRegistryStore } from './stores/agentStoreRegistry';
import { useSessionStore } from './store';
import { useLayoutStore } from './stores/layoutStore';
import { MainColumnHeader } from './features/layout/MainColumnHeader';
import { RightPanelShell, SidebarShell, TerminalShell } from './features/layout/PanelShells';
import { ModuleRail } from './features/layout/ModuleRail';
import { ModuleContainer } from './features/workspace/ModuleContainer';
import { FullscreenLoading } from './components/FullscreenLoading';
import { onPiEvent, pi, type OpenWorkspaceResult } from './lib/pi';
import { pickDirectory } from './lib/dialog';
import { createStartupPerf } from './lib/startupPerf';
import { isUnder, pathsEquivalent } from './lib/pathUtils';
import {
  getAllSessionsInflight,
  getCachedAllSessions,
  invalidateAllSessionsCache,
  setAllSessionsInflight,
  setCachedAllSessions,
} from './lib/sessionCache';

// 初始工作区由 App 启动时解析（恢复最近会话所属 cwd，否则新建对话）。

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
  runningSessionPaths,
  onNewConversation,
  onOpenProject,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onDeleteConversation,
  onRemoveProject,
  onSubmitRename,
}: {
  runningSessionPaths: Set<string>;
  onNewConversation: () => void;
  onOpenProject: () => void;
  onNewSession: (cwd: string) => void;
  onOpenSession: (cwd: string, path: string) => void;
  onDeleteSession: (cwd: string, path: string) => void;
  onDeleteConversation: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
}) {
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  return (
    <SidebarShell>
      <Sidebar
        runningSessionPaths={runningSessionPaths}
        onNewConversation={onNewConversation}
        onOpenProject={onOpenProject}
        onNewSession={onNewSession}
        onOpenSession={onOpenSession}
        onDeleteSession={onDeleteSession}
        onDeleteConversation={onDeleteConversation}
        onRemoveProject={onRemoveProject}
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
      <DockPanel region="right" onCollapse={toggleRightPanel} />
    </RightPanelShell>
  );
});

const TerminalColumn = memo(function TerminalColumn() {
  return (
    <TerminalShell>
      <DockPanel region="bottom" />
    </TerminalShell>
  );
});

function Workspace() {
  const { store, workspace, setWorkspaceReady, workspaceReady } = useAgentStoreContext();
  const isStreaming = store.useStore((s) => s.isStreaming);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const messages = store.useStore((s) => s.messages);
  const prevWorkspaceRef = useRef(workspace);

  // 主对话的 spawn_agent 变化时，统一在此处把 subagent tab 与 messages 对齐（单点，避免多坞重复 sync）。
  useEffect(() => {
    useDockStore.getState().syncSubAgentTabs(messages);
  }, [messages]);

  // 切换工作区：dispose 旧终端（TerminalBody 卸载会停 shell）、终端重置为 1 个 idle，page 结构保留。
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      useDockStore.getState().resetWorkspaceTabs();
    }
  }, [workspace]);

  // 首屏先渲染 UI 骨架；openWorkspace 完成后并行加载会话与消息，全量会话后台刷新。
  useEffect(() => {
    let alive = true;
    const perf = createStartupPerf(workspace);
    // 兜底：openWorkspace 异常或挂起时，最多 12s 后强制结束加载，避免永久停在加载页。
    const readyGuard = setTimeout(() => {
      if (alive) setWorkspaceReady(true);
    }, 12000);

    void (async () => {
      if (!workspace) {
        useSessionStore.getState().setLoading(false);
        return;
      }
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
        if (path) useSessionStore.getState().setWorkspaceSessionPath(workspace, path);
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
        if (alive) setWorkspaceReady(true); // 失败也结束加载，显示界面与错误，避免永久 loading
      } finally {
        clearTimeout(readyGuard);
        useSessionStore.getState().setLoading(false);
        perf.report();
      }
    })();

    // 全量会话不阻塞消息区首屏
    void refreshAllSessions();

    return () => {
      alive = false;
      clearTimeout(readyGuard);
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
      st.setWorkspaceSessionPath(cwd, path);
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

  const goToSafeWorkspace = useCallback(async () => {
    await refreshAllSessions(true);
    const all = useSessionStore.getState().allSessions;
    const next = all[0]?.cwd;
    const st = useSessionStore.getState();
    st.setActiveSession('');
    if (next) {
      st.setActiveWorkspace(next);
    } else {
      const { cwd } = await pi.createConversation();
      st.setActiveWorkspace(cwd);
    }
  }, []);

  const handleNewConversation = useCallback(async () => {
    const { cwd } = await pi.createConversation();
    invalidateAllSessionsCache();
    const st = useSessionStore.getState();
    st.setActiveSession('');
    st.setActiveWorkspace(cwd);
    void refreshAllSessions(true);
  }, []);

  const handleOpenProject = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    const st = useSessionStore.getState();
    st.setActiveSession('');
    st.setActiveWorkspace(dir);
    void refreshAllSessions(true);
  }, []);

  const handleDeleteConversation = useCallback(
    async (cwd: string) => {
      await pi.deleteConversation(cwd);
      invalidateAllSessionsCache();
      if (useSessionStore.getState().activeWorkspace === cwd) {
        await goToSafeWorkspace();
      } else {
        void refreshAllSessions(true);
      }
    },
    [goToSafeWorkspace],
  );

  const handleRemoveProject = useCallback(
    async (cwd: string) => {
      await pi.removeProject(cwd);
      invalidateAllSessionsCache();
      if (useSessionStore.getState().activeWorkspace === cwd) {
        await goToSafeWorkspace();
      } else {
        void refreshAllSessions(true);
      }
    },
    [goToSafeWorkspace],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        void handleNewConversation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNewConversation]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void onPiEvent((e) => {
      if (e.event.type !== 'agent_end') return;
      const ws = e.workspace;
      if (!isUnder(ws, useSessionStore.getState().worksDir)) return;
      void (async () => {
        const title = await pi.autoTitleSession(ws);
        if (title) {
          invalidateAllSessionsCache();
          void refreshAllSessions(true);
        }
      })();
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  const runningWorkspaces = useAgentRegistryStore((s) => s.runningWorkspaces);
  const workspaceSessionPaths = useSessionStore((s) => s.workspaceSessionPaths);
  const runningSessionPaths = useMemo(() => {
    const set = new Set<string>();
    for (const ws of runningWorkspaces) {
      const p = workspaceSessionPaths[ws];
      if (p) set.add(p);
    }
    // 兜底：当前 active 正在 streaming（首条消息可能早于映射落地）
    if (isStreaming && activeSessionPath) set.add(activeSessionPath);
    return set;
  }, [runningWorkspaces, workspaceSessionPaths, isStreaming, activeSessionPath]);

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
                  runningSessionPaths={runningSessionPaths}
                  onNewConversation={handleNewConversation}
                  onOpenProject={handleOpenProject}
                  onNewSession={handleNewSession}
                  onOpenSession={handleOpenSession}
                  onDeleteSession={handleDeleteSession}
                  onDeleteConversation={handleDeleteConversation}
                  onRemoveProject={handleRemoveProject}
                  onSubmitRename={handleSubmitRename}
                />
                <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
                  <DockDndProvider>
                    <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
                      <MainChatColumn />
                      <RightPanelColumn />
                    </Flexbox>
                    <TerminalColumn />
                  </DockDndProvider>
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
    void (async () => {
      try {
        const wd = await pi.getWorksDir();
        useSessionStore.getState().setWorksDir(wd);
      } catch {
        /* ignore */
      }
      let ws = '';
      try {
        const all = await pi.listAllSessions();
        ws = all[0]?.cwd ?? '';
      } catch {
        /* ignore */
      }
      if (!ws) {
        try {
          ws = (await pi.createConversation()).cwd;
        } catch {
          /* ignore */
        }
      }
      if (ws) useSessionStore.getState().setActiveWorkspace(ws);
    })();
    return () => {
      // store 由 registry 常驻；卸载时统一取消所有订阅（后端进程由窗口关闭事件 close_all 兜底）。
      agentStoreRegistry.destroyAll();
    };
  }, []);

  return (
    <ThemeProvider themeMode={appearance}>
      <ThemeBridge />
      <ExtensionUiHost />
      <AgentStoreProvider workspace={activeWorkspace}>
        <Workspace />
      </AgentStoreProvider>
    </ThemeProvider>
  );
}
