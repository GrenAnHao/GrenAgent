import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { App } from 'antd';
import { ChatListView } from './ChatListView';
import { ChatListSkeleton } from './ChatListSkeleton';
import { ChatInput } from './ChatInput';
import { scrollerKeepsWheel } from './composerWheel';
import { CHAT_CONTENT_WIDTH } from './chatStyles';
import { EmptyChatPrompt } from './EmptyChatPrompt';
import type { TranscriptScrollHandle } from './VirtualizedMessageList';
import type { PromptImage } from './input/ChatInputContext';
import { createComposerItem, removeComposerItem } from './input/composerQueue';
import { settleAbortedSteers } from './steerAbort';
import {
  dropUnpersistedUserTail,
  pinRunClock,
  rollbackUnansweredSend,
  type AgentState,
  type UserImage,
} from '../../stores/agentReducer';
import { setComposerValue } from './input/composerBridge';
import { isExecutiveCommandMessage } from './input/commandClassification';
import { parseCommandToken } from './input/editor/commandPaste';
import { commitComposerModelToSession, peekComposerLevel, peekComposerModel } from './input/actions/ModelThinkingAction';
import { useCommandInputStore } from '../../stores/commandInputStore';
import { pi } from '../../lib/pi';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { needsSessionCreateOnSend } from '../../lib/pendingSession';
import { syncSidebarOnSend } from '../../lib/sidebarSessionSync';
import { fallbackSessionTitle } from '@extensions/_shared/session-title';
import { markScratchUsed } from '../../lib/startupConversation';
import { createStartupPerf } from '../../lib/startupPerf';
import { useSessionStore } from '../../store/session';
import { useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useModuleStore } from '../../stores/moduleStore';
import { commandLanes } from '../../lib/commandLanes';
import { refreshGoalStatus } from '../extensionUi/goalStatus';
import { awaitStreamingEnd } from '../../lib/streamingGate';

const COMPOSE_COLUMN: CSSProperties = {
  width: CHAT_CONTENT_WIDTH,
  marginInline: 'auto',
  paddingInline: 8,
};

const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  margin: '0 16px 8px',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  color: cssVar.colorError,
  background: cssVar.colorErrorBg,
  border: `1px solid ${cssVar.colorErrorBorder}`,
};
const errorTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
};
const errorCloseStyle: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};
const retryBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 16px 8px',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  color: cssVar.colorWarning,
  background: cssVar.colorWarningBg,
  border: `1px solid ${cssVar.colorWarningBorder}`,
};

const retryReasonStyle: CSSProperties = { display: 'block', opacity: 0.8 };

function retryLabel(retrying: NonNullable<AgentState['retrying']>): string {
  if (!retrying.auto) return `发送失败，正在重试（${retrying.attempt}/${retrying.max}）…`;
  if (retrying.attempt <= 0) return '接口出错，准备重试…';
  return `接口出错，正在重试（${retrying.attempt}/${retrying.max}）…`;
}

/** 发送失败时的自动重试次数（不含首次发送）。 */
const MAX_SEND_RETRIES = 5;
const EMPTY_TURN_MSG =
  '本轮没有返回任何内容：模型/供应商可能返回为空或出错。请检查该供应商的 Base URL、模型 ID 与 API Key；也可在启动 app 的终端查看 [pi stderr] 日志。';
/** 重试退避：第 n 次重试前等待，线性增长并封顶 4s。 */
const retryDelayMs = (attempt: number) => Math.min(800 * attempt, 4000);

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  return pathsEquivalent(a, b);
}

/** 发送串行按会话排队：同项目两个会话互不阻塞，同一会话仍然一条一条来。 */
export function laneKey(workspace: string, sessionPath: string | null | undefined): string {
  return `${workspace}\0${sessionPath ?? 'draft'}`;
}

function toUserImages(images?: PromptImage[]): UserImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map(({ mimeType, data }) => ({ mimeType, data }));
}

function toPromptImages(images?: UserImage[]): PromptImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }));
}

export function ChatView() {
  const { workspace, store, workspaceReady } = useAgentStoreContext();
  const { message: messageApi } = App.useApp();
  const worksDir = useSessionStore((s) => s.worksDir);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const draftConversationCwd = useSessionStore((s) => s.draftConversationCwd);
  const messages = store.useStore((s) => s.messages);
  const lastError = store.useStore((s) => s.lastError);
  const retrying = store.useStore((s) => s.retrying);
  const isStreaming = store.useStore((s) => s.isStreaming);
  const awaitingResponse = store.useStore((s) => s.awaitingResponse);
  const composerQueue = store.useStore((s) => s.composerQueue) ?? [];
  const isEmpty = messages.length === 0;
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));
  const isDraftConversation = Boolean(draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace));
  const showEmptyLayout = isEmpty && workspaceReady;
  // 用户是否点了「停止」：abort 可能以抛错 / lastError / 空轮等多种形式体现，统一靠这个标记判定。
  const userAbortedRef = useRef(false);
  const cancelSleepRef = useRef<(() => void) | null>(null);
  const sleepOrAbort = (ms: number) =>
    new Promise<void>((resolve) => {
      if (userAbortedRef.current) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cancelSleepRef.current = null;
        resolve();
      }, ms);
      cancelSleepRef.current = () => {
        clearTimeout(timer);
        cancelSleepRef.current = null;
        resolve();
      };
    });
  const [seatHeight, setSeatHeight] = useState(0);
  const [gutter, setGutter] = useState(0);
  const transcriptRef = useRef<TranscriptScrollHandle>(null);
  const seatRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const seat = seatRef.current;
    if (!seat) return;
    const update = () => setSeatHeight(seat.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(seat);
    return () => ro.disconnect();
  }, [showEmptyLayout]);

  useEffect(() => {
    if (showEmptyLayout) return;
    const seat = seatRef.current;
    if (!seat) return;
    const onSeatWheel = (e: WheelEvent) => {
      const currentSeat = seatRef.current;
      if (!currentSeat) return;
      const start = e.target instanceof Element ? e.target : null;
      if (start?.closest('[data-composer-draft]')) return;
      if (start?.closest("[data-testid='composer-prompt-overlay']")) return;
      let node: Element | null = start;
      while (node && node !== currentSeat) {
        if (node instanceof HTMLElement) {
          const overflowY = getComputedStyle(node).overflowY;
          if (
            scrollerKeepsWheel({
              overflowY,
              scrollTop: node.scrollTop,
              clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight,
              deltaY: e.deltaY,
            })
          )
            return;
        }
        node = node.parentElement;
      }
      e.preventDefault();
      transcriptRef.current?.scrollBy(e.deltaY);
    };
    seat.addEventListener('wheel', onSeatWheel, { passive: false });
    return () => seat.removeEventListener('wheel', onSeatWheel);
  }, [showEmptyLayout]);

  // 切换到非对话视图（选项卡）时，若正在生成中则自动中止，避免切回时停止按钮残留显示。
  const activeWorkspaceView = useModuleStore((s) => s.activeWorkspaceView);
  useEffect(() => {
    if (activeWorkspaceView !== 'chat' && store.useStore.getState().isStreaming) {
      userAbortedRef.current = true;
      store.useStore.setState({ aborting: true });
      void pi.abort(workspace, store.getLoadedSessionPath());
    }
  }, [activeWorkspaceView, store, workspace]);

  const flushingIdRef = useRef<string | null>(null);
  const rollbackUnsent = (text: string): boolean => {
    const next = dropUnpersistedUserTail(store.useStore.getState().messages, text);
    if (!next) return false;
    store.useStore.setState({ messages: next, awaitingResponse: false });
    return true;
  };
  const flushComposerItem = useCallback(async (id: string) => {
    if (flushingIdRef.current === id) return;
    const item = store.useStore.getState().composerQueue.find((entry) => entry.id === id);
    if (!item) return;
    flushingIdRef.current = id;
    store.useStore.setState((s) => ({ composerQueue: removeComposerItem(s.composerQueue ?? [], id) }));
    const itemPath = store.getLoadedSessionPath() ?? null;
    try {
      store.pushUserMessage(item.text, item.images);
      // 跟进在本轮收尾时发出，Pi 可能等本轮 settled 后才开新回合：钉住起点，计时接着数。
      store.useStore.setState({
        awaitingResponse: true,
        lastError: undefined,
        ...pinRunClock(store.useStore.getState()),
      });
      await pi.prompt(workspace, item.text, undefined, toPromptImages(item.images), itemPath);
      if (samePath(store.getLoadedSessionPath(), itemPath)) void store.syncEntryIdsAfterAccept();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!samePath(store.getLoadedSessionPath(), itemPath)) return;
      if (!userAbortedRef.current && !/abort/i.test(msg)) {
        const rolled = rollbackUnsent(item.text);
        store.useStore.setState({ lastError: msg, awaitingResponse: false, runOriginPinned: false });
        if (rolled) setComposerValue(item.text);
      }
    } finally {
      if (flushingIdRef.current === id) flushingIdRef.current = null;
    }
  }, [store, workspace]);

  useEffect(() => {
    if (isStreaming || awaitingResponse) return;
    const first = composerQueue[0];
    if (!first) return;
    void flushComposerItem(first.id);
  }, [awaitingResponse, composerQueue, flushComposerItem, isStreaming]);

  const handleSend = async (
    message: string,
    images?: PromptImage[],
    behavior?: 'steer' | 'followUp',
  ) => {
    const text = message.trim();
    const hasContent = Boolean(text || images?.length);
    if (!hasContent && behavior !== 'followUp') return;
    // 新一轮发送：清掉上一轮可能遗留的「用户中断」标记。
    userAbortedRef.current = false;

    // 执行性命令（/dream 等）：不产生对话轮次。跳过乐观气泡与 awaitingResponse，
    // 改瞬态 toast，仍 pi.prompt 让 Pi 执行——切换/重载后不再有幽灵气泡。
    if (text && isExecutiveCommandMessage(text)) {
      const cmd = text.split(/\s/, 1)[0];
      try {
        const commandPath = store.getLoadedSessionPath();
        await pi.prompt(workspace, text, undefined, images, commandPath);
        // /goal 只在输入栏上方出 Goal 条，对话里不留命令行、也不弹「已执行」：条本身就是回执。
        // 回合跑着时也立刻生效；推送之外再按路径补拉一次，Goal 条不用等切换会话。
        if (cmd.toLowerCase() === '/goal') {
          void refreshGoalStatus(workspace, commandPath);
          return;
        }
        messageApi.info(`已执行 ${cmd}`);
        const sessionPath = useSessionStore.getState().activeSessionPath;
        if (sessionPath) {
          const parsed = parseCommandToken(text);
          useCommandInputStore.getState().append(sessionPath, {
            command: cmd,
            rest: parsed?.rest ?? text.slice(cmd.length).trim(),
          });
        }
      } catch (e) {
        messageApi.error(`${cmd} 执行失败：${e instanceof Error ? e.message : String(e)}`);
        return 'failed';
      }
      return;
    }

    // 执行中发送：先落成跟进条。点条上的引导才注入当前回合；否则本轮结束后自动跟进。
    if (behavior === 'followUp' && hasContent) {
      const st = store.useStore.getState();
      if (st.isStreaming || st.awaitingResponse) {
        store.useStore.setState((s) => ({
          composerQueue: [...(s.composerQueue ?? []), createComposerItem(text, toUserImages(images))],
        }));
        return;
      }
    } else if (behavior === 'followUp' && !hasContent) {
      const first = store.useStore.getState().composerQueue?.[0];
      if (first) {
        await flushComposerItem(first.id);
        return;
      }
      const followPath = store.getLoadedSessionPath() ?? null;
      try {
        await pi.prompt(workspace, '', 'followUp', undefined, followPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!samePath(store.getLoadedSessionPath(), followPath)) return;
        if (!userAbortedRef.current && !/abort/i.test(msg)) {
          store.useStore.setState({ lastError: msg });
          return 'failed';
        }
      }
      return;
    } else if (behavior === 'steer') {
      // pi 自己的接口重试条留着，引导不改变那一轮还在重试的事实。
      store.useStore.setState((s) => ({ lastError: undefined, retrying: s.retrying?.auto ? s.retrying : undefined }));
      if (!hasContent) return;
      // 引导赶上本轮收尾时，Pi 会把它推迟成下一回合；钉住起点，那一回合也接着计时。
      store.useStore.setState(pinRunClock(store.useStore.getState()));
      store.pushUserMessage(text, images, true);
      const steerPath = store.getLoadedSessionPath() ?? null;
      const steerHere = () => samePath(store.getLoadedSessionPath(), steerPath);
      for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
        try {
          await pi.prompt(workspace, text, 'steer', images, steerPath);
          if (!steerHere()) return;
          void store.syncEntryIdsAfterAccept();
          store.useStore.setState((s) => ({ retrying: s.retrying?.auto ? s.retrying : undefined }));
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!steerHere()) return;
          if (userAbortedRef.current || /abort/i.test(msg)) {
            store.useStore.setState({ retrying: undefined, aborting: false });
            return;
          }
          if (attempt === MAX_SEND_RETRIES) {
            store.useStore.setState({
              lastError: `已重试 ${MAX_SEND_RETRIES} 次仍失败：${msg}`,
              retrying: undefined,
              runOriginPinned: false,
            });
            if (rollbackUnsent(text)) return 'failed';
            return;
          }
          store.useStore.setState({
            retrying: { attempt: attempt + 1, max: MAX_SEND_RETRIES },
            lastError: undefined,
          });
          await sleepOrAbort(retryDelayMs(attempt + 1));
          if (!steerHere()) return;
          if (userAbortedRef.current) {
            store.useStore.setState({ retrying: undefined, aborting: false });
            return;
          }
        }
      }
      return;
    }

    store.useStore.setState({ lastError: undefined, retrying: undefined });
    if (text || images?.length) store.pushUserMessage(text, images);
    // 发送即置「准备响应中」：桥接到后端首个 agent_start 之间的冷启动/会话预备窗口，消除无反馈空档。
    store.useStore.setState({
      awaitingResponse: true,
      ...pinRunClock(store.useStore.getState()),
    });
    // 发送路径性能埋点：拆出 openWorkspace / newSession / getState / promptToStream 各耗时
    //（DEV 控制台 [PERF-startup] send:<ws>），用于定位「新对话/久置后发送」的延迟究竟卡在哪。
    const sendPerf = createStartupPerf(`send:${workspace}`);

    let createdPath: string | undefined;
    // 草稿首发前画面绑定的路径（通常为 undefined）。落盘期间切到别的会话时，失败也不能写到新画面上。
    const pathBeforeSend = store.getLoadedSessionPath();
    const ensureSessionForSend = async () => {
      const needsCreate = needsSessionCreateOnSend({ workspace, activeSessionPath, draftConversationCwd });
      const peekBefore = peekComposerModel(workspace);
      const levelBefore = needsCreate ? peekComposerLevel(workspace) : null;
      if (!needsCreate) return;
      const st = useSessionStore.getState();
      sendPerf.start('openWorkspace');
      const openResult = await pi.openWorkspace(workspace);
      sendPerf.end('openWorkspace');
      // 项目草稿的 openWorkspace 会带回 last_session；必须新建，不能把首发写进上一会话。
      if (isDraftConversation || !openResult.sessionFile) {
        sendPerf.start('newSession');
        await pi.newSession(workspace);
        sendPerf.end('newSession');
      }
      sendPerf.start('getState');
      let state: { sessionFile?: string };
      try {
        state = (await pi.getState(workspace)) as { sessionFile?: string };
      } catch (error) {
        // 草稿 worker 仍可能短暂带着外工作区 last_session；归属失败时新建本对话会话再读一次。
        if (!String(error).includes('SESSION_WORKSPACE_MISMATCH')) throw error;
        sendPerf.start('newSession');
        await pi.newSession(workspace);
        sendPerf.end('newSession');
        state = (await pi.getState(workspace)) as { sessionFile?: string };
      }
      sendPerf.end('getState');
      const path = state.sessionFile ?? openResult.sessionFile;
      if (path) {
        // 画面立刻绑到新会话：否则它的流和另一个在跑的会话分不开，切来切去都是最后那一份。
        store.bindSessionPath(path);
        createdPath = path;
        // 必须先于 setActiveSession：否则 loadState 会读到 SDK 默认模型并盖掉输入栏点选。
        // 用发送瞬间的 peek，不用 await 之后再读：openWorkspace/newSession 期间草稿 loadState
        // 可能把缓存套回设置默认。
        commitComposerModelToSession(workspace, path, peekBefore, levelBefore);
        // 右侧边栏按会话走：草稿里打开的标签和面板状态过户给刚落盘的会话，必须在 setActiveSession 之前。
        useDockStore.getState().adoptDraftView(workspace, path);
        st.setActiveSession(path);
        st.setWorkspaceSessionPath(workspace, path);
        st.upsertOptimisticSession({
          id: `opt-${path}`,
          path,
          cwd: workspace,
          timestamp: new Date().toISOString(),
          // 和主进程列会话时同一套兑底：粘贴块、/skill: 调用不原样当标题。
          name: fallbackSessionTitle(text, images?.length ?? 0),
        });
      }
      st.clearDraftConversation(workspace);
      if (peekBefore) await pi.setModel(workspace, peekBefore.provider, peekBefore.id);
      if (levelBefore) await pi.setThinkingLevel(workspace, levelBefore);
      // 该空白对话已被使用（已落盘会话）→ 清除复用记忆，下次「新建对话」改为新建而非复用它。
      markScratchUsed(workspace);
    };

    try {
      sendPerf.start('ensureSession');
      await ensureSessionForSend();
      sendPerf.end('ensureSession');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const loadedNow = store.getLoadedSessionPath();
      if (!samePath(loadedNow, pathBeforeSend) && !samePath(loadedNow, createdPath)) {
        sendPerf.report();
        return;
      }
      rollbackUnsent(text);
      store.useStore.setState({ lastError: msg, isStreaming: false, awaitingResponse: false, runOriginPinned: false });
      sendPerf.report();
      return 'failed';
    }
    if (text || images?.length) void syncSidebarOnSend(workspace, text, images?.length ?? 0);

    // 这一轮属于哪个会话在这里定下来。之后用户切到别的会话，本轮的提示、重试、回滚都不能落到新画面上。
    // 刚新建的会话优先：落盘期间切到了别的会话时 loadedSessionPath 已是那份，不能把首发打过去。
    const sendPath = createdPath ?? store.getLoadedSessionPath() ?? null;
    const stillHere = () => samePath(store.getLoadedSessionPath(), sendPath);
    if (!stillHere()) {
      // 落盘期间就切走了：消息照常发给它自己的会话，界面不再管这一轮。
      if (createdPath) void pi.prompt(workspace, text, undefined, images, createdPath).catch(() => {});
      sendPerf.report();
      return;
    }

    // 发送一轮：成功返回 ok；失败带错误信息（区分用户主动 abort，不计入重试）。
    // 失败判定含三类：pi.prompt 抛错、本轮产生错误事件(lastError)、本轮无任何助手/工具输出。
    // retryable 只在没有进入实际 turn 时为 true；一旦后端开始处理，就避免前端重发造成历史重复。
    const runOnce = async (): Promise<
      { ok: true } | { ok: false; error: string; aborted?: boolean; retryable: boolean }
    > => {
      const beforeCount = store.useStore.getState().messages.length;
      let turnStarted = store.useStore.getState().isStreaming;
      let streamTimed = turnStarted;
      sendPerf.start('promptToStream');
      const unsub = store.useStore.subscribe((s) => {
        if (s.isStreaming) {
          turnStarted = true;
          if (!streamTimed) {
            streamTimed = true;
            sendPerf.end('promptToStream');
          }
        }
      });
      try {
        store.useStore.setState({ lastError: undefined });
        await commandLanes.run(laneKey(workspace, sendPath), async () => {
          await pi.prompt(workspace, text, undefined, images, sendPath);
          if (!stillHere()) return;
          void store.syncEntryIdsAfterAccept();
          await awaitStreamingEnd(
            store.useStore,
            {
              ...(/^\//.test(text.trim()) ? { startTimeoutMs: 2000 } : {}),
              isDetached: () => !stillHere(),
            },
          );
        });
        if (!stillHere()) return { ok: true };
        const cur = store.useStore.getState();
        const retryable = !turnStarted && cur.messages.length === beforeCount;
        // 用户点了停止：无论中断以何种形式体现（lastError / 空轮 / 静默停流），都按中断收手，
        // 不报错、不重试；abort 也可能经事件流写入 lastError（而非 pi.prompt 抛出），一并识别。
        if (userAbortedRef.current || (cur.lastError && /abort/i.test(cur.lastError))) {
          return { ok: false, error: cur.lastError ?? 'aborted', aborted: true, retryable: false };
        }
        if (cur.lastError) return { ok: false, error: cur.lastError, retryable };
        const last = cur.messages[cur.messages.length - 1];
        // 「空轮」仅当一轮确实跑过却无任何输出（agent_start 已把 awaitingResponse 清掉）。
        // 若 awaitingResponse 仍为 true，说明首响应（agent_start）尚未到达——这是慢启动而非空轮，
        // 不可误判失败：否则会闪出「发送失败，正在重试」红条并重发 prompt（潜在重复轮次）。
        if (!text.startsWith('/') && !cur.isStreaming && !cur.awaitingResponse && last?.kind === 'user') {
          return { ok: false, error: EMPTY_TURN_MSG, retryable };
        }
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 失败时画面已经是另一个会话：不能把错误和回滚写到它上面。
        if (!stillHere()) return { ok: true };
        const cur = store.useStore.getState();
        const retryable = !turnStarted && cur.messages.length === beforeCount;
        if (userAbortedRef.current || /abort/i.test(msg)) {
          return { ok: false, error: msg, aborted: true, retryable: false };
        }
        return { ok: false, error: msg, retryable };
      } finally {
        unsub();
      }
    };

    // 出现异常不直接报错：自动重试最多 5 次，期间在会话中显示「正在重试」。
    let result = await runOnce();
    let retriesDone = 0;
    for (
      let attempt = 1;
      !result.ok && !result.aborted && result.retryable && attempt <= MAX_SEND_RETRIES;
      attempt++
    ) {
      store.useStore.setState({
        retrying: { attempt, max: MAX_SEND_RETRIES },
        isStreaming: false,
        lastError: undefined,
      });
      await sleepOrAbort(retryDelayMs(attempt));
      if (!stillHere()) {
        sendPerf.report();
        return;
      }
      if (userAbortedRef.current) {
        result = { ok: false, error: 'aborted', aborted: true, retryable: false };
        break;
      }
      result = await runOnce();
      retriesDone = attempt;
    }
    if (!stillHere()) {
      sendPerf.report();
      return;
    }
    store.useStore.setState({ retrying: undefined, awaitingResponse: false });
    sendPerf.report();

    if (!result.ok && result.aborted) {
      // 还没收到任何回复就手动取消：撤掉刚发出的气泡，原文放回输入框。
      const rolled = text ? rollbackUnansweredSend(store.useStore.getState().messages, text) : null;
      store.useStore.setState({
        isStreaming: false,
        lastError: undefined,
        aborting: false,
        awaitingResponse: false,
        runOriginPinned: false,
        ...(rolled && !rolled.entryId ? { messages: rolled.messages } : {}),
      });
      if (rolled?.entryId) {
        try {
          await store.rewindAndLoad(rolled.entryId, text);
        } catch {
          store.useStore.setState({ messages: rolled.messages });
          setComposerValue(text);
        }
      } else if (rolled) {
        setComposerValue(text);
      }
    } else if (!result.ok) {
      // 仅在确实重试过时才提示「已重试 N 次」；turn 已开始即失败（未重试）直接显示错误，避免误导。
      const prefix = retriesDone > 0 ? `已重试 ${retriesDone} 次仍失败：` : '';
      const rolled = Boolean(text || images?.length) && rollbackUnsent(text);
      store.useStore.setState({
        lastError: `${prefix}${result.error}`,
        isStreaming: false,
        awaitingResponse: false,
        runOriginPinned: false,
      });
      if (rolled) return 'failed';
    }
  };

  const dismissError = () => store.useStore.setState({ lastError: undefined });

  const errorBanner = lastError ? (
    <div style={errorBannerStyle}>
      <Icon icon={AlertTriangle} size={14} />
      <span style={errorTextStyle}>{lastError}</span>
      <button type="button" aria-label="关闭" onClick={dismissError} style={errorCloseStyle}>
        <Icon icon={X} size={14} />
      </button>
    </div>
  ) : null;

  const retryIndicator = retrying ? (
    <div style={retryBannerStyle} data-testid="send-retry-indicator">
      <Icon icon={RefreshCw} spin size={14} />
      <span style={errorTextStyle}>
        {retryLabel(retrying)}
        {retrying.error ? <span style={retryReasonStyle}>{retrying.error}</span> : null}
      </span>
      <button type="button" aria-label="取消" data-testid="send-retry-cancel" onClick={() => void handleAbort()} style={errorCloseStyle}>
        取消
      </button>
    </div>
  ) : null;

  const handleAbort = async () => {
    // 标记用户主动中断：runOnce 据此把本轮判为中断（不报错、不重试），无论中断如何体现。
    userAbortedRef.current = true;
    cancelSleepRef.current?.();
    // 置 aborting：reducer 据此丢弃 abort 触发的 "request aborted" 类报错，避免红条闪一下。
    // 同时清掉重试条和「准备响应中」，失败等待期间停止必须立刻生效。
    store.useStore.setState({ aborting: true, retrying: undefined, awaitingResponse: false });
    // 停的是画面上这个会话，不是项目前景里恰好在跑的另一个。
    const abortPath = store.getLoadedSessionPath() ?? null;
    await pi.abort(workspace, abortPath);
    // 暂停时 Pi 不会把没注入的引导继续发出。取出队列：第一条当新消息发送，其余回到输入区排队。
    let queued: string[] = [];
    try {
      queued = (await pi.takeSteering(workspace, abortPath)).steering;
    } catch {
      queued = [];
    }
    if (!samePath(store.getLoadedSessionPath(), abortPath)) return;
    const current = store.useStore.getState();
    const plan = settleAbortedSteers(current.messages, current.composerQueue ?? [], queued);
    if (!plan.send) {
      store.useStore.setState({ aborting: false });
      return;
    }
    userAbortedRef.current = false;
    store.useStore.setState({
      messages: plan.messages,
      composerQueue: plan.composerQueue,
      steering: [],
      awaitingResponse: true,
      ...pinRunClock(current, true),
      aborting: false,
      lastError: undefined,
      retrying: undefined,
    });
    if (!plan.send.alreadyShown) store.pushUserMessage(plan.send.text, plan.send.images);
    try {
      await pi.prompt(workspace, plan.send.text, undefined, toPromptImages(plan.send.images), abortPath);
      if (samePath(store.getLoadedSessionPath(), abortPath)) void store.syncEntryIdsAfterAccept();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!samePath(store.getLoadedSessionPath(), abortPath)) return;
      if (!userAbortedRef.current && !/abort/i.test(msg)) {
        store.useStore.setState({ lastError: msg, awaitingResponse: false, runOriginPinned: false });
      }
    }
  };

  return (
    <div
      style={{
        height: '100%',
        position: 'relative',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {showEmptyLayout ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            paddingBottom: seatHeight,
          }}
        >
          <AnimatePresence>
            <motion.div
              key="empty-prompt"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            >
              <EmptyChatPrompt workspace={workspace} isConversation={isConversation} />
            </motion.div>
          </AnimatePresence>
        </div>
      ) : (
        <div style={{ position: 'absolute', inset: 0 }}>
          {workspaceReady ? (
            <ChatListView
              paddingBottom={seatHeight}
              scrollRef={transcriptRef}
              onGutterChange={setGutter}
            />
          ) : (
            <ChatListSkeleton />
          )}
        </div>
      )}
      <div
        ref={seatRef}
        data-testid="composer-seat"
        style={{
          position: 'absolute',
          left: 0,
          right: gutter,
          bottom: 0,
          zIndex: 3,
          paddingBottom: 0,
          background: `var(--gren-content-bg, ${cssVar.colorBgContainer})`,
        }}
      >
        <div style={COMPOSE_COLUMN}>
          {retryIndicator}
          {errorBanner}
          <div style={{ width: '100%' }} data-testid="chat-input-region">
            <ChatInput
              onSend={handleSend}
              onAbort={handleAbort}
              scrollTranscript={showEmptyLayout ? undefined : (d) => transcriptRef.current?.scrollBy(d)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
