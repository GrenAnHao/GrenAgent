import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react';
import { ThemeProvider, Flexbox, ConfigProvider } from '@lobehub/ui';
import { m } from 'motion/react';
import { ANTD_CSS_VAR_KEY, ThemeBridge } from './components/ThemeBridge';
import { ExtensionUiHost } from './features/extensionUi/ExtensionUiHost';
import { FullAccessConfirmModal } from './features/chat/input/FullAccessConfirmModal';
import { useThemeStore } from './stores/themeStore';
import { schemePrimary, schemeTokens } from './theme/colorSchemes';
import { MarkdownWarmup } from './features/chat/MarkdownWarmup';
import { CodeViewWarmup } from './features/tools/LazyHighlighter';
import { Sidebar } from './features/sessions/Sidebar';
import { DockPanel } from './features/dock/DockPanel';
import { DockDndProvider } from './features/dock/DockDndProvider';
import { closeVisualDockTab, openVisualDockTab } from './features/visual/openVisualDockTab';
import { useVisualStore } from './stores/visualStore';
import { useDockStore } from './stores/dockStore';
import { Titlebar } from './components/Titlebar';
import { useAskConfirm } from './components/askConfirm';
import { AgentStoreProvider, useAgentStoreContext } from './stores/AgentStoreContext';
import { agentStoreRegistry, useAgentRegistryStore } from './stores/agentStoreRegistry';
import { restoreRunningTurns } from './stores/restoreRunningTurns';
import { forgetRunningSession, resolveRunningSessionPaths, startRunningSessionTracking } from './stores/runningSessions';
import { useSessionStore } from './store';
import { useLayoutStore } from './stores/layoutStore';
import { MainChatColumn } from './features/layout/MainChatColumn';
import { RightPanelShell, SidebarShell, TerminalShell } from './features/layout/PanelShells';
import { ModuleRail } from './features/layout/ModuleRail';
import { ModuleContainer } from './features/workspace/ModuleContainer';
import { useModuleStore } from './stores/moduleStore';
import { dismissBootSplash } from './lib/bootSplash';
import { onPiEvent, pi, type OpenWorkspaceResult } from './lib/pi';
import { readUiHistoryForSession, sessionKeyFromPath } from './lib/uiHistory';
import { pickDirectory } from './lib/dialog';
import { prewarmWorkspace } from './lib/prewarm';
import { createStartupPerf } from './lib/startupPerf';
import { IS_DEV } from './lib/devMode';
import { pathsEquivalent } from './lib/pathUtils';
import { useStableCallback } from './lib/structuralShare';
import { applyOpenedProject, enterPendingNewSession } from './lib/pendingSession';
import { canReuseScratch, readRememberedScratch, rememberScratch } from './lib/startupConversation';
import {
  bumpSessionMutationEpoch,
  getAllSessionsInflight,
  getCachedAllSessions,
  getSessionMutationEpoch,
  invalidateAllSessionsCache,
  isFreshResponse,
  setAllSessionsInflight,
  setCachedAllSessions,
} from './lib/sessionCache';
import { invalidateCachedSession } from './lib/sessionMessageCache';
import { filterDeletedSessions, mergeAllSessions } from './lib/mergeSessions';
import { pickAutoSelected } from './lib/sessionSelect';
import { useCommandInputStore } from './stores/commandInputStore';
import { useSidebarPrefsStore } from './stores/sidebarPrefsStore';
import { useThinkingMemoryStore } from './stores/thinkingMemoryStore';

// 初始工作区由 App 启动时解析（恢复最近会话所属 cwd，否则新建对话）。

/** 拉取并刷新当前工作区的会话列表。 */
async function refreshSessions(
  workspace: string,
  openResult?: OpenWorkspaceResult,
  options?: { autoSelect?: boolean },
): Promise<void> {
  const autoSelect = options?.autoSelect ?? true;
  const { setSessions, setActiveSession, setError } = useSessionStore.getState();
  try {
    const sessions = await pi.listSessions(workspace);
    setSessions(sessions);
    if (!autoSelect) return;
    const active = useSessionStore.getState().activeSessionPath;
    const pick = pickAutoSelected(active, openResult, sessions);
    if (pick) setActiveSession(pick);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

let projectSyncEpoch = 0;

/** 把主进程登记的空项目灌回侧栏。过期响应直接丢掉，避免「移除项目」和列表刷新交错时又加回来。 */
async function syncRememberedProjects(): Promise<void> {
  const epoch = ++projectSyncEpoch;
  try {
    const projects = await pi.listProjects();
    if (epoch !== projectSyncEpoch) return;
    const session = useSessionStore.getState();
    const prefs = useSidebarPrefsStore.getState();
    for (const cwd of projects) {
      session.registerProject(cwd);
      prefs.keepProject(cwd);
    }
  } catch {
    /* 登记读失败不挡会话列表；下次刷新再试 */
  }
}

/** 拉取所有项目的全量会话（供侧边栏按项目分组），带短期缓存。 */
async function refreshAllSessions(force = false): Promise<void> {
  void syncRememberedProjects();
  const { syncAllSessions, setAllSessionsLoading, setError } = useSessionStore.getState();
  // 记录发起时的代次：响应回来若代次已变（期间发生删除/新建/重命名），丢弃该响应——
  // 否则"删前/删中"扫到的旧列表会被灌回，表现为删后回弹/需重删。
  const startedEpoch = getSessionMutationEpoch();

  if (!force) {
    const cached = getCachedAllSessions();
    if (cached) {
      if (isFreshResponse(startedEpoch)) syncAllSessions(cached);
      return;
    }
    const inflight = getAllSessionsInflight();
    if (inflight) {
      setAllSessionsLoading(true);
      try {
        const s = await inflight;
        if (isFreshResponse(startedEpoch)) syncAllSessions(s);
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
      if (!isFreshResponse(startedEpoch)) return sessions;
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

/**
 * 取一个空白对话 cwd：优先复用上次记住、至今未使用（无落盘会话）的 draft，否则新建并记住。
 * 启动与「新建对话」共用此逻辑，把磁盘上的空对话目录收敛到最多 1 个，避免无限堆积。
 */
async function acquireDraftScratch(): Promise<string> {
  let worksDir = '';
  try {
    worksDir = await pi.getWorksDir();
  } catch {
    /* ignore — worksDir 取不到时仅靠「是否已落盘」判定复用 */
  }
  let sessionCwds: Array<string | null> = [];
  try {
    sessionCwds = (await pi.listAllSessions()).map((s) => s.cwd);
  } catch {
    /* ignore */
  }
  const remembered = readRememberedScratch();
  if (canReuseScratch(remembered, worksDir, sessionCwds)) return remembered;
  const { cwd } = await pi.createConversation();
  rememberScratch(cwd);
  return cwd;
}

const SidebarPanel = memo(function SidebarPanel({
  runningSessionPaths,
  onNewConversation,
  onOpenProject,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onDeleteConversation,
  onClearProjectSessions,
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
  onClearProjectSessions: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onSubmitRename: (cwd: string, path: string, name: string) => void;
}) {
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
        onClearProjectSessions={onClearProjectSessions}
        onRemoveProject={onRemoveProject}
        onSubmitRename={onSubmitRename}
      />
    </SidebarShell>
  );
});

const RightPanelColumn = memo(function RightPanelColumn() {
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
  const visualMode = useVisualStore((s) => s.mode);
  const visualHtml = useVisualStore((s) => s.html);
  const sessionId = useVisualStore((s) => s.sessionId);
  const visualTabOpen = useDockStore((s) => s.tabs.some((tab) => tab.id === 'visual:panel'));
  const openedRef = useRef(false);
  const sawTabRef = useRef(false);

  useEffect(() => {
    if (visualMode === 'panel' && visualHtml) {
      openVisualDockTab(sessionId);
      openedRef.current = true;
      return;
    }
    if (openedRef.current) {
      closeVisualDockTab();
      openedRef.current = false;
      sawTabRef.current = false;
    }
  }, [visualMode, visualHtml, sessionId]);

  useEffect(() => {
    if (visualTabOpen) {
      sawTabRef.current = true;
      return;
    }
    // 打开的同一帧标签还不在列表里，不能当成用户关掉。
    if (!sawTabRef.current || visualMode !== 'panel') return;
    sawTabRef.current = false;
    openedRef.current = false;
    useVisualStore.getState().clearVisual();
  }, [visualTabOpen, visualMode]);

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
  const setRowNode = useCallback((el: HTMLDivElement | null) => {
    rowRef.current = el;
    if (el) el.setAttribute('data-sidebar-row', '');
  }, []);

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
    <Flexbox horizontal flex={1} style={{ minHeight: 0, height: '100%', minWidth: 0 }} ref={setRowNode}>
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

const Workspace = memo(function Workspace() {
  const { store, workspace, setWorkspaceReady, appBooted } = useAgentStoreContext();
  const ask = useAskConfirm();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const prevWorkspaceRef = useRef(workspace);

  // 冷启动加载页是 index.html 的静态首屏，首个对话就绪后收起。
  useEffect(() => {
    if (appBooted) dismissBootSplash();
  }, [appBooted]);

  // 切换工作区：dispose 旧终端（TerminalBody 卸载会停 shell）、终端重置为 1 个 idle，page 结构保留。
  // 同时把主列视图重置回「对话」，避免带着上个项目的工具面板（检查点/审查等）切到新项目看到错配内容。
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      useDockStore.getState().resetWorkspaceTabs();
      useModuleStore.getState().setActiveWorkspaceView('chat');
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
      const draftConversationCwd = useSessionStore.getState().draftConversationCwd;
      if (draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace)) {
        store.reset();
        setWorkspaceReady(true);
        useSessionStore.getState().setLoading(false);
        // 草稿对话不走 openWorkspace（避免 restore last_session 顶掉在跑的会话），但仍需后台 warm
        // 把 pi 进程拉起来：否则 getAvailableModels / getState 因「workspace not open」始终报错，
        // 模型、模式、思考档位选择器永久禁用（新建会话无法选模型）。warm 幂等、不恢复/创建 session。
        prewarmWorkspace(workspace);
        void refreshAllSessions();
        return () => {
          alive = false;
        };
      }
      const target = useSessionStore.getState().activeSessionPath;
      const loaded = store.getLoadedSessionPath();
      const cached =
        (loaded !== undefined && loaded === target) || (store.hasLiveActivity() && !target);
      if (cached) {
        setWorkspaceReady(true);
        useSessionStore.getState().setLoading(false);
        if (target) useSessionStore.getState().setWorkspaceSessionPath(workspace, target);
        void restoreRunningTurns();
        // 全量会话仍后台刷新（带 30s 缓存，不阻塞、不重载消息区）。
        void refreshAllSessions();
        return () => {
          alive = false;
        };
      }
      // 目标会话命中模块级缓存（该 workspace 的 store 可能新建/曾被 LRU 驱逐）→ 先秒显缓存内容并
      // 结束骨架屏；下方完整后端流程仍会跑以对齐活跃会话并刷新，刷新内容与缓存一致时 loadMessages
      // 会跳过重渲染（不闪动）。让「看过的会话」切回即时可见，不必干等 openWorkspace/getMessages。
      // 没命中时画面已被清成这份会话的空壳：常驻 store 的 workspaceReady 初值是 true，
      // 不压回 false 会把空壳当成「空对话」展示，看起来像草稿，直到后端流程跑完。
      if (target) setWorkspaceReady(store.showCachedSession(target));
    }

    const perf = createStartupPerf(workspace);
    // 兜底：openWorkspace 异常或挂起时，最多 12s 后强制结束加载，避免永久停在加载页。
    const readyGuard = setTimeout(() => {
      if (alive) setWorkspaceReady(true);
    }, 12000);

    void (async () => {
      if (!workspace) {
        useSessionStore.getState().setLoading(false);
        await restoreRunningTurns();
        return;
      }
      useSessionStore.getState().setLoading(true);

      try {
        perf.start('openWorkspace');
        const openResult = await pi.openWorkspace(workspace);
        perf.end('openWorkspace');
        if (!alive) return;

        // 已经知道要打开哪份会话时，会话列表只是侧栏数据，不该挡在 switchSession / getMessages 前面。
        // 它会扫这个项目的全部会话文件，主进程正忙着跑任务时要好几秒。
        const knownTarget = Boolean(useSessionStore.getState().activeSessionPath);
        perf.start('refreshSessions');
        const sessionsTask = refreshSessions(workspace, openResult, { autoSelect: !knownTarget });
        if (!knownTarget) await sessionsTask;
        perf.end('refreshSessions');
        if (!alive) return;

        const stAfter = useSessionStore.getState();
        const alreadyDraft = Boolean(
          stAfter.draftConversationCwd && pathsEquivalent(stAfter.draftConversationCwd, workspace),
        );
        if (!stAfter.activeSessionPath && !alreadyDraft) {
          applyOpenedProject(workspace, null, () => store.reset());
          if (alive) {
            await restoreRunningTurns();
            setWorkspaceReady(true);
          }
          return;
        }

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
          const [{ messages }, uiHistory] = await Promise.all([
            pi.getMessages(workspace, path),
            readUiHistoryForSession(workspace, path),
          ]);
          if (alive) {
            store.loadMessages(messages, { force: true, sessionPath: path, uiHistory });
            await restoreRunningTurns();
          }
        } catch {
          if (alive) await restoreRunningTurns();
        }
        perf.end('getMessages');
        // 消息加载完成后再就绪：内容区骨架屏直接切到最终内容（消息列表或空对话占位），
        // 避免「openWorkspace 完成即就绪、消息却还没到」时先闪一帧空对话布局（白底 + 居中输入框），
        // 再跳到消息列表（伴随输入框上下滑动）。
        if (alive) setWorkspaceReady(true);
      } catch (err) {
        useSessionStore.getState().setError(err instanceof Error ? err.message : String(err));
        if (alive) {
          await restoreRunningTurns();
          setWorkspaceReady(true);
        }
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

  const selectTokenRef = useRef(0);

  const handleNewSession = useCallback((cwd: string) => {
    ++selectTokenRef.current;
    enterPendingNewSession(cwd, () => store.reset());
  }, [store]);

  const handleOpenSession = useCallback(
    async (cwd: string, path: string) => {
      const st = useSessionStore.getState();
      const previousPath = st.activeSessionPath;
      const previousWorkspacePath = st.workspaceSessionPaths[cwd];
      st.clearDraftConversation();
      st.setActiveSession(path);
      st.setWorkspaceSessionPath(cwd, path);
      useThinkingMemoryStore.getState().bumpSwitch(cwd);
      if (st.activeWorkspace !== cwd) {
        // 跨项目切换：立即切 activeWorkspace，内容区即刻进入骨架屏；
        // openWorkspace / switchSession / getMessages 由切换工作区的 effect 统一完成，
        // 不在此 await 阻塞——否则骨架屏要等 openWorkspace 返回才出现，表现为「先卡顿一下再骨架屏」。
        st.setActiveWorkspace(cwd);
      } else {
        // 同项目切会话：命中前端缓存先秒显（看过的会话立即出现）；未命中则置骨架屏给即时反馈，
        // 避免在 switchSession/getMessages 的后端往返期间界面冻在旧内容上「等好几秒才切过去」。
        const token = ++selectTokenRef.current;
        const shown = store.showCachedSession(path, previousWorkspacePath ?? previousPath);
        // 命中→就绪(秒显缓存内容)，未命中→骨架屏。之后仅最新 token 的链能再改就绪态与内容。
        setWorkspaceReady(shown);
        try {
          await pi.switchSession(cwd, path);
          // 已被更新的切换超越 → 丢弃本次后端结果，避免旧链用旧会话消息覆盖当前显示 / 污染缓存。
          if (selectTokenRef.current !== token) return;
          const [{ messages }, uiHistory] = await Promise.all([
            pi.getMessages(cwd, path),
            readUiHistoryForSession(cwd, path),
          ]);
          if (selectTokenRef.current !== token) return;
          // 命中缓存且内容未变时 loadMessages 内部会跳过重渲染（见 agent store），不会闪动。
          store.loadMessages(messages, { force: true, sessionPath: path, uiHistory });
          await restoreRunningTurns();
        } catch (error) {
          if (selectTokenRef.current === token) {
            const cur = useSessionStore.getState();
            const restorePath = previousWorkspacePath ?? previousPath;
            if (!previousPath) cur.setActiveSession('');
            else cur.setActiveSession(previousPath);
            if (restorePath) cur.setWorkspaceSessionPath(cwd, restorePath);
            if (previousPath) store.showCachedSession(previousPath);
            store.useStore.setState({ lastError: `切换会话失败：${error instanceof Error ? error.message : String(error)}` });
          }
        } finally {
          if (selectTokenRef.current === token) setWorkspaceReady(true);
        }
      }
    },
    [store, setWorkspaceReady],
  );

  const handleOpenSourceSession = useCallback(async (cwd: string, path: string) => {
    useModuleStore.getState().setActiveModule('chat');
    await handleOpenSession(cwd, path);
  }, [handleOpenSession]);

  const handleDeleteSession = useCallback(async (cwd: string, path: string) => {
    const st = useSessionStore.getState();
    // 删除前判定是否为会话区正在显示的会话（pathsEquivalent 兜底分隔符/大小写差异）。
    const wasActive = pathsEquivalent(st.activeSessionPath ?? '', path);
    // 乐观：隐藏集为唯一真相（渲染层 filterDeletedSessions 即时移除）；同时失效两级缓存 + bump epoch
    // 作废在途重拉。不再裸 setAllSessions(remaining)——那会与重拉互相覆盖造成删后回弹。
    st.hideDeletedSession(path);
    useDockStore.getState().dropSessionTabs(path, wasActive);
    st.removeOptimisticSession(path);
    invalidateCachedSession(path);
    bumpSessionMutationEpoch();
    invalidateAllSessionsCache();
    if (wasActive) {
      // 删的是会话区正在显示的会话：先同步清空会话区，避免被删会话消息残留。
      store.reset();
      st.setActiveSession('');
    }
    try {
      await pi.deleteSession(cwd, path);
      // 主进程已经停掉并摘下这份会话；停靠的 handle 被拆时不再发 agent_end，这里自己熄灭运行态。
      forgetRunningSession(path);
      // 会话删成功后再删 UI 历史：若 deleteSession 失败（会话仍在），不应抹掉其完整历史。
      const histKey = sessionKeyFromPath(path);
      if (histKey) void pi.deleteUiHistory(cwd, histKey).catch(() => {});
      bumpSessionMutationEpoch();
      invalidateAllSessionsCache();
      if (wasActive) {
        // 从"已过滤隐藏集"的可见列表里挑下一个，避免选到刚隐藏的已删项。
        const cur = useSessionStore.getState();
        const visible = filterDeletedSessions(
          mergeAllSessions(cur.allSessions, cur.optimisticSessions),
          cur.deletedSessionPaths,
        );
        const nextInProject = visible
          .filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
          .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
        if (nextInProject) {
          // 让本次「删除后自动切」超越之前在途的手动切链（旧链 await 回来会因 token 变化被丢弃），
          // 避免删除后的显示被更早、更慢返回的手动切结果覆盖。
          ++selectTokenRef.current;
          try {
            await pi.switchSession(cwd, nextInProject.path);
            const [{ messages }, uiHistory] = await Promise.all([
              pi.getMessages(cwd, nextInProject.path),
              readUiHistoryForSession(cwd, nextInProject.path),
            ]);
            store.loadMessages(messages, { force: true, sessionPath: nextInProject.path, uiHistory });
            await restoreRunningTurns();
            st.setActiveSession(nextInProject.path);
            st.setWorkspaceSessionPath(cwd, nextInProject.path);
            useThinkingMemoryStore.getState().bumpSwitch(cwd);
          } catch {
            /* 切换失败：保持空会话区 */
          }
        } else {
          // 项目内已无其它会话：对齐后端 delete_pi_session 删活跃会话前 new_session 切到的新空会话。
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
            /* getState 失败保持空会话区 */
          }
        }
      }
      void refreshAllSessions(true);
    } catch (e) {
      // 后端删除失败：撤销乐观隐藏，列表项恢复，并提示错误。
      st.unhideDeletedSession(path);
      st.setError(e instanceof Error ? e.message : String(e));
    }
  }, [store]);

  const handleSubmitRename = useCallback(async (cwd: string, path: string, name: string) => {
    await pi.setSessionDisplayName(path, name);
    const st = useSessionStore.getState();
    const viewingTarget =
      Boolean(st.activeWorkspace && pathsEquivalent(cwd, st.activeWorkspace)) &&
      Boolean(path && st.activeSessionPath && pathsEquivalent(path, st.activeSessionPath));
    if (viewingTarget) {
      try {
        await pi.setSessionName(cwd, name);
      } catch {
        /* 文件已写入；内存同步失败不回滚侧栏标题 */
      }
    }
    const applyName = <T extends { path: string; name: string | null }>(list: T[]) =>
      list.map((s) => (pathsEquivalent(s.path, path) ? { ...s, name } : s));
    useSessionStore.setState((s) => ({
      sessions: applyName(s.sessions),
      allSessions: applyName(s.allSessions),
      optimisticSessions: applyName(s.optimisticSessions),
    }));
    invalidateAllSessionsCache();
    if (st.activeWorkspace && pathsEquivalent(cwd, st.activeWorkspace)) {
      await refreshSessions(cwd, undefined, { autoSelect: false });
    }
    void refreshAllSessions(true);
  }, []);

  const goToSafeWorkspace = useCallback(async () => {
    await refreshAllSessions(true);
    const all = useSessionStore.getState().allSessions;
    const next = all[0]?.cwd;
    const st = useSessionStore.getState();
    st.setActiveSession('');
    if (next) {
      st.setActiveWorkspace(next);
    } else {
      const cwd = await acquireDraftScratch();
      st.setDraftConversation(cwd);
      st.setActiveWorkspace(cwd);
    }
  }, []);

  const handleNewConversation = useCallback(async () => {
    // 复用上一个未使用的空白对话，避免每次点「新建对话」都建一个 works 目录而堆积。
    // 不落盘会话：首条消息或 /goal 才 newSession。
    const cwd = await acquireDraftScratch();
    ++selectTokenRef.current;
    enterPendingNewSession(cwd, () => store.reset());
  }, [store]);

  const handleOpenProject = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    const openResult = await pi.openWorkspace(dir);
    const st = useSessionStore.getState();
    st.registerProject(dir);
    useSidebarPrefsStore.getState().keepProject(dir);
    applyOpenedProject(dir, openResult.sessionFile, () => store.reset());
    void refreshAllSessions(true);
  }, [store]);

  const handleDeleteConversation = useCallback(
    (cwd: string) => {
      const st = useSessionStore.getState();
      // 失效该 cwd 下所有会话的消息缓存（删除前先收集 path）。
      const pathsUnderCwd = st.allSessions
        .filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
        .map((s) => s.path);
      st.hideDeletedConversation(cwd);
      st.removeOptimisticByCwd(cwd);
      for (const p of pathsUnderCwd) invalidateCachedSession(p);
      bumpSessionMutationEpoch();
      invalidateAllSessionsCache();
      if (pathsEquivalent(st.activeWorkspace, cwd)) {
        // 从"已过滤隐藏集 + 排除已删对话 cwd"的可见列表里挑下一个，
        // 不再选到另一个已隐藏未清理的对话（消除切到已删 cwd 的闪/错）。
        const cur = useSessionStore.getState();
        const visible = filterDeletedSessions(
          mergeAllSessions(cur.allSessions, cur.optimisticSessions),
          cur.deletedSessionPaths,
        );
        const next = visible
          .filter(
            (s) =>
              s.cwd &&
              !pathsEquivalent(s.cwd, cwd) &&
              !cur.deletedConversationCwds.some((d) => pathsEquivalent(d, s.cwd ?? '')),
          )
          .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
        st.setActiveSession(next?.path ?? '');
        if (next?.cwd) {
          st.setActiveWorkspace(next.cwd);
        } else {
          void handleNewConversation();
        }
      }
      void (async () => {
        try {
          await pi.deleteConversation(cwd);
          bumpSessionMutationEpoch();
          invalidateAllSessionsCache();
          await refreshAllSessions(true);
        } catch (e) {
          st.unhideDeletedConversation(cwd);
          st.setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [handleNewConversation],
  );

  const handleClearProjectSessions = useCallback(
    async (cwd: string) => {
      if (!(await ask({ title: '清空该项目下的全部会话？', content: '项目会保留。', danger: true }))) return;
      const st = useSessionStore.getState();
      const pathsUnderCwd = mergeAllSessions(st.allSessions, st.optimisticSessions)
        .filter((session) => session.cwd && pathsEquivalent(session.cwd, cwd))
        .map((session) => session.path);
      const wasActive = pathsEquivalent(st.activeWorkspace, cwd);
      for (const path of pathsUnderCwd) {
        st.hideDeletedSession(path);
        useDockStore.getState().dropSessionTabs(path, wasActive);
        st.removeOptimisticSession(path);
        invalidateCachedSession(path);
        useCommandInputStore.getState().dropSession(path);
      }
      bumpSessionMutationEpoch();
      invalidateAllSessionsCache();
      st.registerProject(cwd);
      useSidebarPrefsStore.getState().keepProject(cwd);
      if (wasActive) {
        store.reset();
        st.setActiveSession('');
      }
      try {
        await pi.removeProject(cwd);
        st.registerProject(cwd);
        useSidebarPrefsStore.getState().keepProject(cwd);
        for (const path of pathsUnderCwd) {
          forgetRunningSession(path);
          const histKey = sessionKeyFromPath(path);
          if (histKey) void pi.deleteUiHistory(cwd, histKey).catch(() => {});
        }
        if (wasActive) {
          await handleNewSession(cwd);
        }
        void refreshAllSessions(true);
      } catch (error) {
        for (const path of pathsUnderCwd) st.unhideDeletedSession(path);
        st.setError(error instanceof Error ? error.message : String(error));
      }
    },
    [ask, handleNewSession, store],
  );

  const handleRemoveProject = useCallback(
    async (cwd: string) => {
      await pi.removeProject(cwd);
      invalidateAllSessionsCache();
      useSessionStore.getState().unregisterProject(cwd);
      useSidebarPrefsStore.getState().dropKeptProject(cwd);
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

  // DEV 专属快捷键：Ctrl/Cmd + Shift + D 直达开发者工作台。生产构建里 IS_DEV 为 false，
  // 监听器根本不注册（组件树里也没有这个模块）。
  useEffect(() => {
    if (!IS_DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        useModuleStore.getState().setActiveModule('devWorkbench');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const listedRunningPaths = useAgentRegistryStore((s) => s.runningSessionPaths);
  const allSessions = useSessionStore((s) => s.allSessions);
  const optimisticSessions = useSessionStore((s) => s.optimisticSessions);
  const runningSessionPaths = useMemo(
    () => resolveRunningSessionPaths(listedRunningPaths, allSessions, optimisticSessions),
    [listedRunningPaths, allSessions, optimisticSessions],
  );

  // 这些回调依赖当前工作区的 store，切到别的项目就全换了引用，侧栏每一行跟着重渲。
  // 侧栏只在点击时调用它们，给它恒定引用、调用时转到最新实现。
  const sidebarNewConversation = useStableCallback(handleNewConversation);
  const sidebarOpenProject = useStableCallback(handleOpenProject);
  const sidebarNewSession = useStableCallback(handleNewSession);
  const sidebarOpenSession = useStableCallback(handleOpenSession);
  const sidebarDeleteSession = useStableCallback(handleDeleteSession);
  const sidebarDeleteConversation = useStableCallback(handleDeleteConversation);
  const sidebarClearProjectSessions = useStableCallback(handleClearProjectSessions);
  const sidebarRemoveProject = useStableCallback(handleRemoveProject);
  const sidebarSubmitRename = useStableCallback(handleSubmitRename);

  return (
    <Flexbox style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <Titlebar />
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <ModuleRail />
        <Flexbox flex={1} style={{ minWidth: 0, height: '100%', background: 'var(--gren-content-bg, transparent)' }}>
          <ModuleContainer
            onOpenSession={handleOpenSourceSession}
            chat={
              <ChatColumns
                sidebar={
                  <SidebarPanel
                    runningSessionPaths={runningSessionPaths}
                    onNewConversation={sidebarNewConversation}
                    onOpenProject={sidebarOpenProject}
                    onNewSession={sidebarNewSession}
                    onOpenSession={sidebarOpenSession}
                    onDeleteSession={sidebarDeleteSession}
                    onDeleteConversation={sidebarDeleteConversation}
                    onClearProjectSessions={sidebarClearProjectSessions}
                    onRemoveProject={sidebarRemoveProject}
                    onSubmitRename={sidebarSubmitRename}
                  />
                }
              />
            }
          />
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );
});

/**
 * 只在这里订阅 activeWorkspace。放在 App 里时，切到别的项目的会话会让 App 连同外层的主题 Provider、
 * 全局样式和弹窗一起重渲，切会话那一帧多出几十毫秒。
 */
function ActiveWorkspace() {
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  return (
    <AgentStoreProvider workspace={activeWorkspace}>
      <Workspace />
    </AgentStoreProvider>
  );
}

export default function App() {
  useEffect(() => startRunningSessionTracking(), []);
  const appearance = useThemeStore((s) => s.appearance);
  const primaryColor = useThemeStore((s) => s.primaryColor);
  const neutralColor = useThemeStore((s) => s.neutralColor);
  const colorScheme = useThemeStore((s) => s.colorScheme);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    if (appearance !== 'auto' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [appearance]);
  const isDark = appearance === 'dark' || (appearance === 'auto' && systemDark);
  // cssVar 模式：antd 组件样式改为引用 CSS 变量，切主题/方案只换变量值，不再为整棵
  // 组件树重新序列化样式表（这是切换卡顿的主因）。token 为方案覆盖（含明暗）。
  const antdTheme = useMemo(() => {
    const token = schemeTokens(colorScheme, isDark);
    // hashed:false 配合 cssVar：组件样式只有一份（不按 token 哈希隔离），切主题仅换变量值。
    // cssVar.key 必须显式指定：留空时 antd 用 useId 生成随机 key（如 css-var-_r_0_），
    // 而整份 --ant-* 只被序列化成 `.<key>{...}` 这一条类规则，antd 又从不把该 key 加到任何
    // 元素上。于是靠继承取 --ant-* 的消费者（@lobehub/ui 组件、cssVar.* 静态样式、--gren-*）
    // 全部取空值 → 深色下退回浅色兜底。给定固定 key 后由 ThemeBridge 挂到根元素上。
    return { cssVar: { key: ANTD_CSS_VAR_KEY }, hashed: false, ...(token ? { token } : {}) };
  }, [colorScheme, isDark]);
  const worksDir = useSessionStore((s) => s.worksDir);

  // worksDir 决定侧栏「对话 / 项目」归类（works 目录下的会话算「对话」，其余算「项目」）。
  // getWorksDir 偶发失败时若只在启动试一次并吞掉异常，worksDir 会永久为空 → 所有对话被错分到「项目」。
  // 自愈：只要 worksDir 为空就持续重试拉取，直到拿到（含热更新后修复当前会话，无需重启）。
  useEffect(() => {
    if (worksDir) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryLoad = () => {
      pi.getWorksDir()
        .then((dir) => {
          if (cancelled) return;
          if (dir) useSessionStore.getState().setWorksDir(dir);
          else timer = setTimeout(tryLoad, 800);
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tryLoad, 800);
        });
    };
    tryLoad();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [worksDir]);

  useEffect(() => {
    void (async () => {
      try {
        const bootWorksDir = await pi.getWorksDir();
        useSessionStore.getState().setWorksDir(bootWorksDir);
      } catch {
        /* ignore — 上面的自愈 effect 会持续重试补上 worksDir */
      }

      // 首屏默认空的新对话：不恢复最近项目会话。优先复用上次留下、至今未使用过的空白对话，
      // 一旦被用过（首发落盘后 markScratchUsed 清除记忆）就改为新建，既保证首屏干净又避免堆积。
      let ws = '';
      try {
        ws = await acquireDraftScratch();
      } catch {
        /* ignore */
      }

      if (ws) {
        useSessionStore.getState().setDraftConversation(ws);
        useSessionStore.getState().setActiveSession('');
        useSessionStore.getState().setActiveWorkspace(ws);
      }

      // 清理历史 / 崩溃残留的空对话目录：删掉 works 下所有无会话的孤儿，仅保留当前草稿。
      // 配合「统一复用未使用 draft」把磁盘空目录收敛到最多 1 个。
      // 要再扫一遍全部会话，放在进入草稿之后、不等它：它不碰当前草稿，也不该挡加载页。
      void pi.pruneOrphanConversations(ws ? [ws] : []).catch(() => {
        /* ignore — 清理失败无害，下次启动再试 */
      });
    })();
    return () => {
      // store 由 registry 常驻；卸载时统一取消所有订阅（后端进程由窗口关闭事件 close_all 兜底）。
      agentStoreRegistry.destroyAll();
    };
  }, []);

  // appearance 必须显式传确定亮暗。@lobehub/ui 的 ThemeProvider 把 theme 作为函数交给
  // antd-style 的 AntdProvider，后者调 themeProp(appearance) 拿到 createLobeAntdTheme 的结果，
  // 再拼成 algorithm: [baseAlgorithm, ...lobe算法]。lobe 的算法在数组末位、会覆盖 baseAlgorithm，
  // 所以真正决定颜色的是传进 themeProp 的 appearance，而不是 isDarkMode：实测 appearance='light'
  // 配 darkAlgorithm 仍算出 colorBgContainer/colorBgElevated=#ffffff（与纯浅色完全一致）。
  // 而只传 themeMode 时 appearance 是非受控的、初值恒为 'light'，要等内部 ThemeObserver 在
  // useLayoutEffect 里 setAppearance 才纠正，themeMode='auto' 更要多绕一层 setTimeout。
  // 传确定值让首帧就算对，同时消掉 auto 那次注定被覆盖的多余状态更新；跟随系统已由上面的 isDark 处理。
  const resolvedMode = isDark ? 'dark' : 'light';

  // 主题色只能走 customTheme.primaryColor（预设名）：lobe 的算法在 antd 基础算法之后无条件展开
  // 自己的 base token，那份 token 把整套 primary 家族写成灰阶，所以 theme.token.colorPrimary
  // 一定被覆盖，见 theme/colorSchemes 的注释。用户在设置里显式选过的色优先于方案自带的默认色。
  const resolvedPrimary = primaryColor ?? schemePrimary(colorScheme, isDark);

  return (
    <ThemeProvider
      themeMode={resolvedMode}
      appearance={resolvedMode}
      customTheme={{ primaryColor: resolvedPrimary, neutralColor }}
      theme={antdTheme}
    >
      <ConfigProvider motion={m}>
        <ThemeBridge />
        <ExtensionUiHost />
        <FullAccessConfirmModal />
        <MarkdownWarmup />
        <CodeViewWarmup />
        <ActiveWorkspace />
      </ConfigProvider>
    </ThemeProvider>
  );
}
