import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react';
import { Flexbox } from '@lobehub/ui';
import { Modal } from 'antd';
import { WorkbenchThemeProvider } from './theme/WorkbenchThemeProvider';
import { ExtensionUiHost } from './features/extensionUi/ExtensionUiHost';
import { FullAccessConfirmModal } from './features/chat/input/FullAccessConfirmModal';
import { useThemeStore } from './stores/themeStore';
import { MarkdownWarmup } from './features/chat/MarkdownWarmup';
import { CodeViewWarmup } from './features/tools/LazyHighlighter';
import { Sidebar } from './features/sessions/Sidebar';
import { DockPanel } from './features/dock/DockPanel';
import { DockDndProvider } from './features/dock/DockDndProvider';
import { closeVisualDockTab, forgetClosedVisualTab, openVisualDockTab, visualTabId } from './features/visual/openVisualDockTab';
import { useVisualStore } from './stores/visualStore';
import { useDockStore } from './stores/dockStore';
import { Titlebar } from './components/Titlebar';
import { useAskConfirm } from './components/askConfirm';
import { AgentStoreProvider, useAgentStoreContext } from './stores/AgentStoreContext';
import { agentStoreRegistry, useAgentRegistryStore } from './stores/agentStoreRegistry';
import { restoreRunningTurns } from './stores/restoreRunningTurns';
import { forgetRunningSession, resolveRunningSessionPaths, startRunningSessionTracking } from './stores/runningSessions';
import { forgetSessionAttention } from './stores/sessionAttention';
import { AttentionHost } from './features/attention/AttentionHost';
import { AppLinkGuard } from './features/links/AppLinkGuard';
import { FindShortcutHost } from './features/find/FindShortcutHost';
import { registerWorkbenchSessionOpener } from './lib/openWorkbenchSession';
import { useSessionStore } from './store';
import { useLayoutStore } from './stores/layoutStore';
import { MainChatColumn } from './features/layout/MainChatColumn';
import { RightPanelShell, SidebarShell, TerminalShell } from './features/layout/PanelShells';
import { ModuleRail } from './features/layout/ModuleRail';
import { ModuleContainer } from './features/workspace/ModuleContainer';
import { useModuleStore } from './stores/moduleStore';
import { dismissBootSplash } from './lib/bootSplash';
import { onPiEvent, pi, type OpenWorkspaceResult } from './lib/pi';
import { deleteUiHistoryForSession, readUiHistoryForSession } from './lib/uiHistory';
import { pickDirectory } from './lib/dialog';
import { IsolatedWorkspaceDialogs } from './features/isolatedWorkspace/IsolatedWorkspaceDialogs';
import { openReadonlyIfIsolatedGone } from './features/isolatedWorkspace/actions';
import { prewarmWorkspace } from './lib/prewarm';
import { createStartupPerf } from './lib/startupPerf';
import { IS_DEV } from './lib/devMode';
import { isUnder, pathsEquivalent } from './lib/pathUtils';
import { useStableCallback } from './lib/structuralShare';
import { applyOpenedProject, enterPendingNewSession } from './lib/pendingSession';
import { acquireDraftScratch, readRememberedScratch } from './lib/startupConversation';
import { useChatDraftStore } from './stores/chatDraftStore';
import { useComposerFilesStore } from './features/chat/input/composerFiles';
import { useSessionPreferencesStore } from './stores/sessionPreferencesStore';
import { useSessionViewStateStore } from './stores/sessionViewStateStore';
import { lastOpenEquals, lastOpenFromState, pickStartupTarget, readLastOpen, writeLastOpen } from './lib/lastOpen';
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
import { mergeAllSessions, visibleSessions } from './lib/mergeSessions';
import type { SessionInfo } from './lib/pi';
import { archiveSessionPaths, conversationSessionPaths, unarchiveSessionPath } from './features/sessions/archiveActions';
import { SessionProjectTransferDialog } from './features/sessions/SessionProjectTransferDialog';
import { useSessionProjectTransferStore } from './features/sessions/sessionProjectTransferStore';
import { applyTransferOpened } from './features/sessions/sessionProjectTransferActions';
import { consumeTransferOpen } from './features/sessions/sessionProjectTransferScope';
import { pickAutoSelected } from './lib/sessionSelect';
import { useCommandInputStore } from './stores/commandInputStore';
import { useSidebarPrefsStore } from './stores/sidebarPrefsStore';
import { useThinkingMemoryStore } from './stores/thinkingMemoryStore';

// 初始工作区由 App 启动时解析：回到上次停的会话 / 项目草稿，否则进空白对话。
// 见 .agents/notes/implemented/feature/2026-10-19-startup-restores-last-session.md

/** 拉取并刷新当前工作区的会话列表。 */
async function refreshSessions(
  workspace: string,
  openResult?: OpenWorkspaceResult,
  options?: { autoSelect?: boolean },
): Promise<void> {
  const autoSelect = options?.autoSelect ?? true;
  const { setSessions, setActiveSession, setError } = useSessionStore.getState();
  // 与全量列表同一套逻辑代次：迁移 / 删除 / 重命名期间发出的旧请求不能在成功后把会话放回源项目。
  const startedEpoch = getSessionMutationEpoch();
  try {
    const sessions = await pi.listSessions(workspace);
    if (!isFreshResponse(startedEpoch)) return;
    setSessions(sessions);
    if (!autoSelect) return;
    const active = useSessionStore.getState().activeSessionPath;
    const pick = pickAutoSelected(active, openResult, sessions);
    if (pick) setActiveSession(pick);
  } catch (err) {
    if (!isFreshResponse(startedEpoch)) return;
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
async function refreshAllSessions(force = false): Promise<SessionInfo[] | undefined> {
  void syncRememberedProjects();
  const { syncAllSessions, setAllSessionsLoading, setError } = useSessionStore.getState();
  // 记录发起时的代次：响应回来若代次已变（期间发生删除/新建/重命名），丢弃该响应——
  // 否则"删前/删中"扫到的旧列表会被灌回，表现为删后回弹/需重删。
  const startedEpoch = getSessionMutationEpoch();

  if (!force) {
    const cached = getCachedAllSessions();
    if (cached) {
      if (!isFreshResponse(startedEpoch)) return;
      syncAllSessions(cached);
      return cached;
    }
    const inflight = getAllSessionsInflight();
    if (inflight) {
      const sessions = await inflight;
      return isFreshResponse(startedEpoch) ? sessions : undefined;
    }
  }

  setAllSessionsLoading(true);
  const request = pi
    .listAllSessions()
    .then((sessions) => {
      if (!isFreshResponse(startedEpoch)) return;
      setCachedAllSessions(sessions);
      syncAllSessions(sessions);
      return sessions;
    })
    .catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    })
    .finally(() => {
      if (getAllSessionsInflight() === request) {
        setAllSessionsLoading(false);
        setAllSessionsInflight(null);
      }
    });

  setAllSessionsInflight(request);
  const sessions = await request;
  return isFreshResponse(startedEpoch) ? sessions : undefined;
}

function sessionAlreadyActive(path: string | null, openResult: OpenWorkspaceResult): boolean {
  if (!path) return false;
  if (openResult.sessionFile && pathsEquivalent(path, openResult.sessionFile)) return true;
  if (openResult.restoredSession && pathsEquivalent(path, openResult.restoredSession)) return true;
  return false;
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
  onArchiveSession,
  onArchiveConversation,
  onUnarchiveSession,
  onRegenerateTitle,
  onTransferSession,
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
  onArchiveSession: (cwd: string, path: string) => void;
  onArchiveConversation: (cwd: string) => void;
  onUnarchiveSession: (session: SessionInfo) => void;
  onRegenerateTitle: (cwd: string, path: string) => Promise<string>;
  onTransferSession: (cwd: string, path: string, title: string) => void;
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
        onArchiveSession={onArchiveSession}
        onArchiveConversation={onArchiveConversation}
        onUnarchiveSession={onUnarchiveSession}
        onRegenerateTitle={onRegenerateTitle}
        onTransferSession={onTransferSession}
      />
    </SidebarShell>
  );
});

const RightPanelColumn = memo(function RightPanelColumn() {
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
  // 视觉设计按发起它的会话分开记：每个会话各自一个标签，归属、内容、回写都不看当前停在哪个会话。
  const visualEntries = useVisualStore((s) => s.entries);
  const visualTabIds = useDockStore((s) =>
    s.tabs.filter((tab) => tab.kind === 'visual').map((tab) => tab.id).join('\n'),
  );
  /** key → 已为这个 rev 开过标签（同一页不重复抢焦点，用户关掉后也不自动再开） */
  const shownRevRef = useRef(new Map<string, number>());
  const sawTabRef = useRef(new Set<string>());

  useEffect(() => {
    const shown = shownRevRef.current;
    for (const [key, entry] of Object.entries(visualEntries)) {
      if (entry.mode === 'panel' && entry.html) {
        if (shown.get(key) !== entry.rev) {
          openVisualDockTab(entry);
          shown.set(key, entry.rev);
        }
      } else if (shown.has(key)) {
        closeVisualDockTab(key);
        shown.delete(key);
        sawTabRef.current.delete(key);
      }
    }
    for (const key of [...shown.keys()]) {
      if (visualEntries[key]) continue;
      closeVisualDockTab(key);
      shown.delete(key);
      sawTabRef.current.delete(key);
    }
  }, [visualEntries]);

  useEffect(() => {
    const open = new Set(visualTabIds ? visualTabIds.split('\n') : []);
    for (const [key, entry] of Object.entries(visualEntries)) {
      if (open.has(visualTabId(key))) {
        sawTabRef.current.add(key);
        continue;
      }
      // 打开的同一帧标签还不在列表里，不能当成用户关掉。
      if (!sawTabRef.current.has(key) || entry.mode !== 'panel') continue;
      sawTabRef.current.delete(key);
      // 用户关掉标签：视觉设计还在等确认就保留条目（可从「最近关闭」重新打开），否则这一页到此为止。
      if (entry.pending) continue;
      shownRevRef.current.delete(key);
      forgetClosedVisualTab(key);
      useVisualStore.getState().clearVisual(entry);
    }
  }, [visualTabIds, visualEntries]);

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
  const { store, workspace, workspaceReady, setWorkspaceReady, appBooted } = useAgentStoreContext();
  const ask = useAskConfirm();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const prevWorkspaceRef = useRef(workspace);
  /** 归档时要查运行态；下面算出 runningSessionPaths 后写进来。 */
  const runningPathsRef = useRef<Set<string>>(new Set());

  // 冷启动加载页是 index.html 的静态首屏，首个对话就绪后收起。
  useEffect(() => {
    if (appBooted) dismissBootSplash();
  }, [appBooted]);

  // 目录只服务于侧栏。不能仅仅“不 await”：它和目标会话共享磁盘及主进程，提前发 IPC 仍会互相排队。
  // 等首个工作区已提交并绘制，再调全局目录；用同一份结果填当前项目列表，不重复扫描。
  const prunedAfterBoot = useRef(false);
  useEffect(() => {
    if (!appBooted || !workspaceReady || !workspace) return;
    let alive = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const startedEpoch = getSessionMutationEpoch();
        void refreshAllSessions().then((sessions) => {
          if (!alive || !sessions || !isFreshResponse(startedEpoch)) return;
          const state = useSessionStore.getState();
          if (!pathsEquivalent(state.activeWorkspace, workspace)) return;
          state.setSessions(sessions.filter((s) => s.cwd && pathsEquivalent(s.cwd, workspace)));
          if (prunedAfterBoot.current) return;
          prunedAfterBoot.current = true;
          const keep = state.draftConversationCwd || readRememberedScratch();
          void pi.pruneOrphanConversations(keep ? [keep] : []).catch(() => {});
        }).catch(() => { /* refreshAllSessions 已报告失败，不挡对话。 */ });
      });
    });
    return () => { alive = false; cancelAnimationFrame(frame); };
  }, [workspace, workspaceReady, appBooted]);

  // 切换工作区：dispose 旧终端（TerminalBody 卸载会停 shell）、终端重置为 1 个 idle，page 结构保留。
  // 同时把主列视图重置回「对话」，避免带着上个项目的工具面板（检查点/审查等）切到新项目看到错配内容。
  // 会话跨项目移动是例外：那一跳要保留旧文件标签、脏编辑和旧终端，只让新入口使用目标根。
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      if (!consumeTransferOpen(workspace)) useDockStore.getState().resetWorkspaceTabs();
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

        // 只有手动打开一个未指定会话的项目才靠项目列表挑选；定点恢复不提前发任何目录扫描。
        if (!useSessionStore.getState().activeSessionPath) {
          perf.start('refreshSessions');
          await refreshSessions(workspace, openResult);
          perf.end('refreshSessions');
        }
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
          const [snapshot, uiHistory] = await Promise.all([
            pi.getMessages(workspace, path),
            readUiHistoryForSession(workspace, path),
          ]);
          if (alive) {
            store.loadMessages(snapshot.messages, {
              force: true,
              sessionPath: path,
              uiHistory,
              leafId: snapshot.leafId,
              ...(snapshot.transfer ? { transfer: snapshot.transfer } : {}),
            });
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
      // 独立工作区已删除：目录不在，运行时开不起来；会话 jsonl 还在，改成只读查看。
      if (openReadonlyIfIsolatedGone(cwd, path)) return;
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
          const [snapshot, uiHistory] = await Promise.all([
            pi.getMessages(cwd, path),
            readUiHistoryForSession(cwd, path),
          ]);
          if (selectTokenRef.current !== token) return;
          // 命中缓存且内容未变时 loadMessages 内部会跳过重渲染（见 agent store），不会闪动。
          store.loadMessages(snapshot.messages, {
            force: true,
            sessionPath: path,
            uiHistory,
            leafId: snapshot.leafId,
            ...(snapshot.transfer ? { transfer: snapshot.transfer } : {}),
          });
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
  // 通知与用量统计都走侧栏的加载路径，同项目也要真正切换会话并读取正文。
  useEffect(() => registerWorkbenchSessionOpener(handleOpenSourceSession), [handleOpenSourceSession]);

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
      if (pathsEquivalent(st.workspaceSessionPaths[cwd] ?? '', path)) st.setWorkspaceSessionPath(cwd, '');
    }
    try {
      await pi.deleteSession(cwd, path);
      // 删除成功才清该会话的偏好/输入/视图；墓碑阻止在途保存把它复活。
      useSessionPreferencesStore.getState().remove(path);
      useChatDraftStore.getState().remove(path);
      useComposerFilesStore.getState().remove(path);
      useSessionViewStateStore.getState().remove(path);
      // 主进程已经停掉并摘下这份会话；停靠的 handle 被拆时不再发 agent_end，这里自己熄灭运行态。
      forgetRunningSession(path);
      forgetSessionAttention(path);
      // 会话删成功后再删 UI 历史：若 deleteSession 失败（会话仍在），不应抹掉其完整历史。
      void deleteUiHistoryForSession(cwd, path).catch(() => {});
      bumpSessionMutationEpoch();
      invalidateAllSessionsCache();
      const afterDelete = useSessionStore.getState();
      if (wasActive && !afterDelete.activeSessionPath && !afterDelete.draftConversationCwd) {
        // 删除等待期间若用户已经打开 B 或新草稿，就保留其新选择，不抢回画面。
        // 从"已过滤隐藏集"的可见列表里挑下一个，避免选到刚隐藏的已删项。
        const cur = useSessionStore.getState();
        const visible = visibleSessions(cur.allSessions, cur.optimisticSessions, cur.deletedSessionPaths);
        const nextInProject = visible
          .filter((s) => s.cwd && pathsEquivalent(s.cwd, cwd))
          .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
        if (nextInProject) {
          // 复用手动切换的 token/回滚流程：用户随后选择 B 时，整条自动切换链都会失效。
          await handleOpenSession(cwd, nextInProject.path);
        } else {
          // 最后一份会话删掉后按普通新建流程进入草稿，四项从项目/应用默认初始化；
          // 不接管后端为释放被删 handle 而临时创建的、仍带 SDK 默认的空会话。
          ++selectTokenRef.current;
          enterPendingNewSession(cwd, () => store.reset());
        }
      }
      void refreshAllSessions(true);
    } catch (e) {
      // 后端删除失败：撤销乐观隐藏，列表项恢复，并提示错误。
      st.unhideDeletedSession(path);
      st.setError(e instanceof Error ? e.message : String(e));
    }
  }, [store, handleOpenSession]);

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

  // 「重新生成标题」：主进程按第一条用户消息起名，写回和手动重命名同一条路。
  const handleRegenerateTitle = useCallback(async (cwd: string, path: string) => {
    const title = await pi.generateSessionTitle(path);
    if (title) await handleSubmitRename(cwd, path, title);
    return title;
  }, [handleSubmitRename]);

  const goToSafeWorkspace = useCallback(async () => {
    await refreshAllSessions(true);
    const all = useSessionStore.getState().allSessions;
    const next = all.find((s) => !s.archived)?.cwd;
    const st = useSessionStore.getState();
    st.setActiveSession('');
    if (next) {
      st.setActiveWorkspace(next);
    } else {
      const cwd = await acquireDraftScratch(pi);
      st.setDraftConversation(cwd);
      st.setActiveWorkspace(cwd);
    }
  }, []);

  const handleNewConversation = useCallback(async () => {
    // 复用上一个未使用的空白对话，避免每次点「新建对话」都建一个 works 目录而堆积。
    // 不落盘会话：首条消息或 /goal 才 newSession。
    const cwd = await acquireDraftScratch(pi);
    ++selectTokenRef.current;
    enterPendingNewSession(cwd, () => store.reset());
  }, [store]);

  /** 把一个目录当项目打开：选文件夹、新建独立工作区都走这里。 */
  const openProjectAt = useCallback(async (dir: string) => {
    const openResult = await pi.openWorkspace(dir);
    const st = useSessionStore.getState();
    st.registerProject(dir);
    useSidebarPrefsStore.getState().keepProject(dir);
    applyOpenedProject(dir, openResult.sessionFile, () => store.reset());
    void refreshAllSessions(true);
  }, [store]);

  const handleOpenProject = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    await openProjectAt(dir);
  }, [openProjectAt]);

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
        const visible = visibleSessions(cur.allSessions, cur.optimisticSessions, cur.deletedSessionPaths);
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

  /**
   * 归档一组会话（项目里的一份，或对话目录下的全部）。回合还在跑的不归档。
   * 归档的是正在看的会话：项目切到同项目最近的可见会话、没有就进新会话；对话切到最近的另一个对话、没有就新建。
   */
  const archiveSessions = useCallback(
    async (cwd: string, paths: string[], conversation: boolean) => {
      const wasActive = paths.some((p) => pathsEquivalent(useSessionStore.getState().activeSessionPath ?? '', p));
      if (!(await archiveSessionPaths(paths, runningPathsRef.current))) return;
      if (wasActive) {
        const cur = useSessionStore.getState();
        const next = visibleSessions(cur.allSessions, cur.optimisticSessions, cur.deletedSessionPaths)
          .filter((s) => s.cwd && (conversation ? cur.worksDir && isUnder(s.cwd, cur.worksDir) : pathsEquivalent(s.cwd, cwd)))
          .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
        if (next?.cwd) await handleOpenSession(next.cwd, next.path);
        else if (conversation) await handleNewConversation();
        else handleNewSession(cwd);
      }
      void refreshAllSessions(true);
    },
    [handleOpenSession, handleNewConversation, handleNewSession],
  );

  const handleArchiveSession = useCallback(
    (cwd: string, path: string) => void archiveSessions(cwd, [path], false),
    [archiveSessions],
  );

  const handleArchiveConversation = useCallback(
    (cwd: string) => void archiveSessions(cwd, conversationSessionPaths(cwd), true),
    [archiveSessions],
  );

  const handleUnarchiveSession = useCallback(async (session: SessionInfo) => {
    if (await unarchiveSessionPath(session.path)) void refreshAllSessions(true);
  }, []);

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
          forgetSessionAttention(path);
          void deleteUiHistoryForSession(cwd, path).catch(() => {});
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

  // 删掉了一个独立工作区：不再记成空项目（有会话的话组还在，标「已删除」）；正停在它上面就回父项目。
  const handleIsolatedDeleted = useCallback(
    (path: string, parentRoot: string) => {
      invalidateAllSessionsCache();
      useSessionStore.getState().unregisterProject(path);
      useSidebarPrefsStore.getState().dropKeptProject(path);
      if (pathsEquivalent(useSessionStore.getState().activeWorkspace, path)) handleNewSession(parentRoot);
      void refreshAllSessions(true);
    },
    [handleNewSession],
  );

  /** 菜单「移动到项目…」：只打开弹窗，不预检、不请求。已归档和未落盘会话不会走到这里。 */
  const handleTransferSession = useCallback((cwd: string, path: string, title: string) => {
    useSessionProjectTransferStore.getState().open({ sourceWorkspace: cwd, sessionPath: path, title });
  }, []);

  /**
   * 移动已提交（opened / retry-open 成功）：把两侧列表、会话缓存与「上次打开」绑定投影到目标，
   * 再走普通打开链。会话 ID / 路径 / 标题 / 置顶都不变；草稿在输入框恢复时按来源绝对化。
   */
  const handleTransferOpened = useCallback(
    async (result: { sourceWorkspace: string; targetWorkspace: string; sessionPath: string }) => {
      const { sessionPath, targetWorkspace } = result;
      applyTransferOpened(result);
      const st = useSessionStore.getState();
      st.setActiveSession(sessionPath);
      st.setWorkspaceSessionPath(targetWorkspace, sessionPath);
      if (!pathsEquivalent(st.activeWorkspace, targetWorkspace)) {
        // 切 workspace 由上面的 effect 统一完成；consumeTransferOpen 已立好标记，不重置停靠面板。
        st.setActiveWorkspace(targetWorkspace);
      } else {
        await handleOpenSession(targetWorkspace, sessionPath);
      }
      void refreshAllSessions(true);
    },
    [handleOpenSession],
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
    // 标题由 会话宿主 内的 auto-title 扩展在 agent_end 时「进程内」生成并写回；写回时 pi
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
  runningPathsRef.current = runningSessionPaths;

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
  const sidebarRegenerateTitle = useStableCallback(handleRegenerateTitle);
  const sidebarArchiveSession = useStableCallback(handleArchiveSession);
  const sidebarArchiveConversation = useStableCallback(handleArchiveConversation);
  const sidebarUnarchiveSession = useStableCallback(handleUnarchiveSession);
  const sidebarTransferSession = useStableCallback(handleTransferSession);
  const isolatedOpenProject = useStableCallback(openProjectAt);
  const isolatedDeleted = useStableCallback(handleIsolatedDeleted);

  return (
    <Flexbox style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
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
                    onNewConversation={sidebarNewConversation}
                    onOpenProject={sidebarOpenProject}
                    onNewSession={sidebarNewSession}
                    onOpenSession={sidebarOpenSession}
                    onDeleteSession={sidebarDeleteSession}
                    onDeleteConversation={sidebarDeleteConversation}
                    onClearProjectSessions={sidebarClearProjectSessions}
                    onRemoveProject={sidebarRemoveProject}
                    onSubmitRename={sidebarSubmitRename}
                    onArchiveSession={sidebarArchiveSession}
                    onArchiveConversation={sidebarArchiveConversation}
                    onUnarchiveSession={sidebarUnarchiveSession}
                    onRegenerateTitle={sidebarRegenerateTitle}
                    onTransferSession={sidebarTransferSession}
                  />
                }
              />
            }
          />
        </Flexbox>
      </Flexbox>
      <IsolatedWorkspaceDialogs openProject={isolatedOpenProject} onDeleted={isolatedDeleted} />
      <SessionProjectTransferDialog
        onOpened={handleTransferOpened}
        onRetryOpened={handleTransferOpened}
        onNeedsRefresh={() => void refreshAllSessions(true)}
      />
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

async function initialLocation() {
  const target = await pickStartupTarget(readLastOpen(), pi);
  return target ?? { kind: 'projectDraft' as const, workspace: await acquireDraftScratch(pi), draftId: undefined };
}

export default function App() {
  useEffect(() => startRunningSessionTracking(), []);
  const appearance = useThemeStore((s) => s.appearance);
  const worksDir = useSessionStore((s) => s.worksDir);
  const initial = useRef<ReturnType<typeof initialLocation> | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupError, setStartupError] = useState<{ title: string; detail: string } | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<'restore' | 'draft' | null>(null);

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
    // 记住停在哪：工作区 + 会话（草稿时没有会话）。启动过程里的空态不写，免得还没恢复就把记忆清掉。
    const unsubscribeLastOpen = useSessionStore.subscribe((state, prev) => {
      const next = lastOpenFromState(state);
      if (!next || lastOpenEquals(next, lastOpenFromState(prev))) return;
      writeLastOpen(next);
    });
    return () => {
      unsubscribeLastOpen();
      agentStoreRegistry.destroyAll();
    };
  }, []);

  useEffect(() => {
    if (useSessionStore.getState().activeWorkspace) return;
    let alive = true;
    // StrictMode 重挂效果时共用同一次解析，尤其不能重复创建空白对话。
    initial.current ??= initialLocation();
    void initial.current.then((target) => {
      if (!alive) return;
      setStartupError(null);
      setRecoveryAction(null);
      const st = useSessionStore.getState();
      if (st.activeWorkspace) return;
      if (target.kind === 'session') {
        const { path } = target.session;
        // 首屏标题、选中行也只需这一条；其余历史项目稍后补齐。
        st.setSessions([target.session]);
        st.setAllSessions(mergeAllSessions(st.allSessions, [target.session]));
        st.clearDraftConversation();
        st.setActiveSession(path);
        st.setWorkspaceSessionPath(target.workspace, path);
        st.setActiveWorkspace(target.workspace);
      } else {
        st.setDraftConversation(target.workspace, target.draftId);
        st.setActiveSession('');
        st.setActiveWorkspace(target.workspace);
      }
    }).catch((error: unknown) => {
      if (!alive) return;
      setRecoveryAction(null);
      if (useSessionStore.getState().activeWorkspace) return;
      setStartupError({ title: '未能恢复上次的位置', detail: error instanceof Error ? error.message : String(error) });
      dismissBootSplash();
    });
    return () => { alive = false; };
  }, [startupAttempt]);

  return (
    <WorkbenchThemeProvider appearance={appearance}>
      <ExtensionUiHost />
      <AttentionHost />
      <AppLinkGuard />
      <FindShortcutHost />
      <FullAccessConfirmModal />
      <MarkdownWarmup />
      <CodeViewWarmup />
      <ActiveWorkspace />
      {startupError !== null && (
        <Modal title={startupError.title} open centered okText="重试恢复" cancelText="新建对话"
          closable={false} keyboard={false} mask={{ closable: false }}
          confirmLoading={recoveryAction === 'restore'} okButtonProps={{ autoFocus: true, disabled: recoveryAction === 'draft' }}
          cancelButtonProps={{ loading: recoveryAction === 'draft', disabled: recoveryAction === 'restore' }}
          onCancel={async () => {
            if (recoveryAction) return;
            setRecoveryAction('draft');
            try {
              const cwd = await acquireDraftScratch(pi);
              enterPendingNewSession(cwd);
              setStartupError(null);
            } catch (error) {
              setStartupError({ title: '未能新建对话', detail: error instanceof Error ? error.message : String(error) });
            } finally {
              setRecoveryAction(null);
            }
          }}
          onOk={() => {
            if (recoveryAction) return;
            initial.current = null;
            setRecoveryAction('restore');
            setStartupAttempt((attempt) => attempt + 1);
          }}>
          {startupError.detail}
        </Modal>
      )}
    </WorkbenchThemeProvider>
  );
}
