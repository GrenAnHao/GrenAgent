import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, memo, type ReactNode } from 'react';
import { ThemeProvider, Flexbox, ConfigProvider } from '@lobehub/ui';
import { m } from 'motion/react';
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
import { pathsEquivalent } from './lib/pathUtils';
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
  const { syncAllSessions, setAllSessionsLoading, setError } = useSessionStore.getState();

  if (!force) {
    const cached = getCachedAllSessions();
    if (cached) {
      syncAllSessions(cached);
      return;
    }
    const inflight = getAllSessionsInflight();
    if (inflight) {
      setAllSessionsLoading(true);
      try {
        syncAllSessions(await inflight);
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
      syncAllSessions(sessions);
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

const MainAndRightRow = memo(function MainAndRightRow() {
  return (
    <Flexbox horizontal flex={1} style={{ minHeight: 0, minWidth: 0 }}>
      <MainChatColumn />
      <RightPanelColumn />
    </Flexbox>
  );
});

// 量「侧栏 + 对话区 + 右面板」整行的真实可用宽度写入 layoutStore，作为面板自适应折叠/封顶的依据。
// 仅用 ref + ResizeObserver 写 store（自身不订阅 availableWidth、不持有 state），故 resize 不会重渲染本组件子树；
// 用 useLayoutEffect 在首帧绘制前就量好，避免持久化的过宽面板闪一下再收回。
const ChatColumns = memo(function ChatColumns({ sidebar }: { sidebar: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const setAvailableWidth = useLayoutStore((s) => s.setAvailableWidth);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const update = () => setAvailableWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setAvailableWidth]);

  return (
    <Flexbox horizontal flex={1} style={{ minHeight: 0, height: '100%', minWidth: 0 }} ref={rowRef}>
      {sidebar}
      <Flexbox flex={1} style={{ minWidth: 0, height: '100%' }}>
        <DockDndProvider>
          <MainAndRightRow />
          <TerminalColumn />
        </DockDndProvider>
      </Flexbox>
    </Flexbox>
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
  const { store, workspace, setWorkspaceReady, appBooted } = useAgentStoreContext();
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

    // 缓存命中：该 store 已常驻、且内存内容正是目标会话（或正处于本会话的实时流式中）→
    // 直接复用，跳过 openWorkspace/getMessages/loadMessages 重载。既消除「每次打开都重新加载」，
    // 也不会冲掉后台仍在流式的会话。切走工作区时其 pi 进程从不关闭、活跃会话也未被切换，故切回即正确，
    // 无需任何后端调用（再调 openWorkspace 反而会把进程 restore 到 last_session、顶掉在跑的新会话）。
    if (workspace) {
      const target = useSessionStore.getState().activeSessionPath;
      const loaded = store.getLoadedSessionPath();
      const cached =
        (loaded !== undefined && loaded === target) || (store.hasLiveActivity() && !target);
      if (cached) {
        setWorkspaceReady(true);
        useSessionStore.getState().setLoading(false);
        if (target) useSessionStore.getState().setWorkspaceSessionPath(workspace, target);
        // 全量会话仍后台刷新（带 30s 缓存，不阻塞、不重载消息区）。
        void refreshAllSessions();
        return () => {
          alive = false;
        };
      }
    }

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
          if (alive) store.loadMessages(messages, { force: true, sessionPath: path });
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
    // 取新会话 path：(1) 写回 workspaceSessionPaths，避免运行指示停留在上一个会话；
    // (2) 乐观占位，让新会话立刻出现在侧栏（pi 延迟落盘，list_all_sessions 当下扫不到）。
    try {
      const state = (await pi.getState(cwd)) as { sessionFile?: string };
      const path = state.sessionFile;
      if (path) {
        st.setActiveSession(path);
        st.setWorkspaceSessionPath(cwd, path);
        st.upsertOptimisticSession({
          id: `opt-${path}`,
          path,
          cwd,
          timestamp: new Date().toISOString(),
          name: null,
        });
      }
    } catch {
      /* getState 失败则退回原有刷新路径 */
    }
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
        store.loadMessages(messages, { force: true, sessionPath: path });
      }
    },
    [store, switchProject],
  );

  const handleDeleteSession = useCallback(async (cwd: string, path: string) => {
    // 删除前判定是否为会话区正在显示的会话（pathsEquivalent 兜底分隔符/大小写差异）。
    const wasActive = pathsEquivalent(useSessionStore.getState().activeSessionPath ?? '', path);
    await pi.deleteSession(cwd, path);
    invalidateAllSessionsCache();
    // 清掉该会话的乐观占位，否则磁盘文件已删、它匹配不到磁盘会话、永不被 prune → 侧栏残留。
    useSessionStore.getState().removeOptimisticSession(path);
    if (wasActive) {
      // 删的是会话区正在显示的会话：后端 delete_pi_session 删活跃会话前已 new_session 切到新空会话。
      // 前端须同步 store.reset() 清空会话区并对齐到该新会话，否则被删会话的消息会残留在会话区。
      const st = useSessionStore.getState();
      store.reset();
      st.setActiveSession('');
      try {
        const state = (await pi.getState(cwd)) as { sessionFile?: string };
        const newPath = state.sessionFile;
        if (newPath) {
          st.setActiveSession(newPath);
          st.setWorkspaceSessionPath(cwd, newPath);
          st.upsertOptimisticSession({
            id: `opt-${newPath}`,
            path: newPath,
            cwd,
            timestamp: new Date().toISOString(),
            name: null,
          });
        }
      } catch {
        /* getState 失败则保持空会话区，由下方 refreshSessions 兜底选择会话 */
      }
    }
    await refreshSessions(cwd);
    void refreshAllSessions(true);
  }, [store]);

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
    // createConversation 只建空 works/<uuid> 目录，pi 在 newSession 前不会把 session 落盘到
    // ~/.pi/agent/sessions；而侧边栏「对话」列表来自 list_all_sessions 扫描已落盘的 session 文件。
    // 故对齐 handleNewSession：先 openWorkspace 起进程、再 newSession 落盘首个 session，
    // refreshAllSessions 才能扫到这条新对话（否则列表不刷新）。
    await pi.openWorkspace(cwd);
    const st = useSessionStore.getState();
    st.setActiveSession('');
    await pi.newSession(cwd);
    invalidateAllSessionsCache();
    st.setActiveWorkspace(cwd);
    void refreshAllSessions(true);
  }, []);

  const handleOpenProject = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    await pi.openWorkspace(dir);
    const st = useSessionStore.getState();
    st.setActiveSession('');
    st.registerProject(dir);
    st.setActiveWorkspace(dir);
    void refreshAllSessions(true);
  }, []);

  const handleDeleteConversation = useCallback(
    async (cwd: string) => {
      await pi.deleteConversation(cwd);
      invalidateAllSessionsCache();
      useSessionStore.getState().removeOptimisticByCwd(cwd);
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
      useSessionStore.getState().unregisterProject(cwd);
      useSessionStore.getState().removeOptimisticByCwd(cwd);
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
    // 标题由 sidecar 内的 auto-title 扩展在 agent_end 时「进程内」生成并写回；写回时 pi
    // 广播 session_info_changed。这里据此刷新侧边栏，让新标题立即显示（不再起冷子进程）。
    void onPiEvent((e) => {
      if (e.event.type !== 'session_info_changed') return;
      invalidateAllSessionsCache();
      void refreshAllSessions(true);
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
      // 当前 workspace 的运行会话以 activeSessionPath 为准：workspaceSessionPaths[ws]
      // 在「项目内新建会话」后可能仍指向上一个会话，若再叠加 activeSessionPath，会把同
      // 项目里的旧会话也点亮成「执行中」。后台 workspace 仍用其映射路径。
      const p = pathsEquivalent(ws, workspace) ? activeSessionPath : workspaceSessionPaths[ws];
      if (p) set.add(p);
    }
    return set;
  }, [runningWorkspaces, workspaceSessionPaths, workspace, activeSessionPath]);

  return (
    <Flexbox style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Titlebar />
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <ModuleRail />
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%', background: 'var(--gren-content-bg, transparent)' }}>
          <ModuleContainer
            chat={
              <ChatColumns
                sidebar={
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
                }
              />
            }
          />
        </Flexbox>
      </Flexbox>
      <FullscreenLoading visible={!appBooted} />
    </Flexbox>
  );
}

export default function App() {
  const appearance = useThemeStore((s) => s.appearance);
  const primaryColor = useThemeStore((s) => s.primaryColor);
  const neutralColor = useThemeStore((s) => s.neutralColor);
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
    <ThemeProvider themeMode={appearance} customTheme={{ primaryColor, neutralColor }}>
      <ConfigProvider motion={m}>
        <ThemeBridge />
        <ExtensionUiHost />
        <AgentStoreProvider workspace={activeWorkspace}>
          <Workspace />
        </AgentStoreProvider>
      </ConfigProvider>
    </ThemeProvider>
  );
}
