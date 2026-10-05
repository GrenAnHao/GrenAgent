import { create } from 'zustand';
import {
  applyEvent,
  initialAgentState,
  addUserMessage,
  messagesFromAgent,
  excludedFromAgent,
  assistantStopFromMessages,
  materializeToolDrafts,
  LARGE_PARSE_INTERVAL_MS,
  type AgentState,
  type ChatMessage,
  type UserImage,
} from './agentReducer';
import { parsePartialArgs } from '../lib/streamingJson';
import { pi, onPiEvent, onPiExit, type AgentEvent, type AgentMessage } from '../lib/pi';
import { getThinkingDuration, saveThinkingDuration } from '../lib/thinkingDurations';
import { getCachedSession, setCachedSession, sessionSignature } from '../lib/sessionMessageCache';
import { readUiHistoryForSession, sessionKeyFromPath, serializeHistory } from '../lib/uiHistory';
import { expandSystemWorkerChat } from '../lib/systemWorkerChat';
import { todoListFinishedInTranscript } from '@extensions/_shared/todo-model';
import {
  sendViaComposer,
  setComposerValue,
  type PromptImage,
} from '../features/chat/input/composerBridge';
import { backfillEntryIds, cutMessagesAfterEntry, mergeLiveTail } from './sessionMessageSync';
import { applyPendingAskUserOnLoad } from './pendingAskUserLoad';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import { restoreInlineQuestionOnLoad } from './restoreInlineQuestionOnLoad';
import { useInlineQuestionStore } from './inlineQuestionStore';
import { pathsEquivalent } from '../lib/pathUtils';
import {
  dropStashedUiRequests,
  parkVisibleUiRequests,
  restoreStashedUiRequests,
} from './backgroundUiRequests';

/**
 * 缓存是 ChatMessage 列表；restore 需要 agent 形态才能 findPendingAskUser。
 * 只从 running 的 ask_user 工具行合成一条，够恢复浮层。
 */
function agentMsgsForAskUserRestore(
  messages: ChatMessage[],
): Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.kind === 'tool' &&
      typeof m.toolName === 'string' &&
      m.toolName.toLowerCase() === 'ask_user' &&
      m.status === 'running' &&
      m.toolCallId
    ) {
      const args = m.args && typeof m.args === 'object' ? (m.args as Record<string, unknown>) : {};
      return [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: m.toolCallId,
              name: 'ask_user',
              arguments: args,
            },
          ],
        },
      ];
    }
  }
  return [];
}

export interface LoadMessagesOptions {
  force?: boolean;
  /** 本次载入对应的会话路径：记录后供切回时判断「内存内容是否已是目标会话」从而跳过重载。 */
  sessionPath?: string | null;
  /**
   * 前端持久化的 UI 完整历史（来自磁盘 ui-history）。pi auto-compaction 会让后端 getMessages 变短，
   * 传入后：若它比后端更完整，则以它为 UI 显示源，避免压缩后的短历史盖掉完整对话。
   * rewind 等需要后端权威结果的场景不传（走后端）。
   */
  uiHistory?: ChatMessage[];
}

export interface AgentStoreApi {
  useStore: {
    (): AgentState;
    <T>(selector: (s: AgentState) => T): T;
    getState: () => AgentState;
    setState: (partial: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
    subscribe: (listener: (s: AgentState, prev: AgentState) => void) => () => void;
  };
  setActive: (active: boolean) => void;
  pushUserMessage: (text: string, images?: UserImage[], steering?: boolean) => void;
  loadMessages: (msgs: AgentMessage[], options?: LoadMessagesOptions) => void;
  /** 把某条消息（按 timestamp）移出 LLM 上下文：乐观灰显 + 调后端命令；失败回滚。 */
  excludeMessage: (timestamp: number) => Promise<void>;
  /** 恢复被移出上下文的消息：乐观取消灰显 + 调后端命令；失败回滚。 */
  restoreMessage: (timestamp: number) => Promise<void>;
  /** 回退到某条消息：后端按 timestamp 映射 entry id 后 fork 出新分支并切换，随后重载消息。 */
  rewindTo: (timestamp: number) => Promise<void>;
  /**
   * 原地截断会话（drop-target / keep-target）。成功后把界面消息收成剩余对话并同步 ui-history；
   * 写失败则删除该会话的 ui-history。磁盘已截断但 reload 失败时仍按截断成功处理。
   */
  truncateTo: (entryId: string, mode: 'drop-target' | 'keep-target') => Promise<void>;
  /** 编辑发送：drop-target 截断后走普通发送；截断已成功但发送失败时把文字写入底部输入框。 */
  editAndSend: (
    entryId: string,
    text: string,
    images?: UserImage[],
  ) => Promise<'ok' | 'truncate-failed' | 'send-failed'>;
  /** 回退确认：记住文字 → 截断 drop-target → 写入底部输入框。 */
  rewindAndLoad: (entryId: string, text: string) => Promise<void>;
  /** 重新生成：keep-target 后用原文普通发送。 */
  regenerate: (entryId: string, text: string, images?: UserImage[]) => Promise<void>;
  /** 删除确认：drop-target，不写入输入框。 */
  deleteFrom: (entryId: string) => Promise<void>;
  /**
   * prompt 被后端接受后立刻补本地用户消息的 entryId/timestamp（不重排、不 loadMessages）。
   * 回合结束也会再跑一次，幂等。
   */
  syncEntryIdsAfterAccept: () => Promise<void>;
  reset: () => void;
  hasLiveActivity: () => boolean;
  /**
   * 当前内存内容对应的会话路径：
   * - `undefined`：从未载入过（需完整加载）
   * - `string | null`：已载入过该会话（切回时若与目标一致即可复用缓存、跳过重载）
   */
  getLoadedSessionPath: () => string | null | undefined;
  /**
   * 尝试用模块级缓存秒显某会话（命中且非实时流式时）。
   * 命中返回 true（已把缓存内容写入展示态，可跳过骨架屏）；未命中返回 false（调用方需走完整后端加载）。
   */
  showCachedSession: (sessionPath: string, fromPath?: string | null) => boolean;
  /**
   * 草稿首发刚落盘：把画面绑到这个会话。之后另一个会话的事件不会再灌进来，
   * 切走时这份内容也能按路径停靠。
   */
  bindSessionPath: (sessionPath: string) => void;
  destroy: () => void;
}

/** 非 active store 的 flush 间隔（rAF 在后台被节流，用 setTimeout 兜底）。 */
const BACKGROUND_FLUSH_MS = 60;

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return pathsEquivalent(a, b);
}

/** 为某工作区创建 agent 状态，并订阅 pi://event。 */
export function createAgentStore(workspace: string): AgentStoreApi {
  let liveActivity = false;
  // 内存内消息当前对应的会话路径（undefined = 从未载入）。用于切回工作区时判断是否可复用缓存。
  let loadedSessionPath: string | null | undefined = undefined;
  // 当前展示内容的轻量签名：后台刷新比对，未变则跳过 setState，避免整列重渲染闪一下。
  let currentSig = '';
  /**
   * 画面上的消息是否带着这份会话的完整历史。切到没有缓存的会话时为 false：画面只有实时尾巴，
   * 不能当完整内容写缓存 / UI 历史，后端快照到了要垫到尾巴前面，而不是被流式挡掉。
   */
  let viewHasHistory = true;
  /** 正在补后端快照的 partial shadow 路径。 */
  const backfilling = new Set<string>();
  let destroyed = false;
  const unsubs: Array<() => void> = [];

  const useStore = create<AgentState>(() => initialAgentState());

  const setFullState = (next: AgentState) => {
    useStore.setState(next, true);
  };

  // —— 事件按动画帧批量应用（对齐 lobehub 流式平滑的思路）——
  // 高频 thinking/text delta 一帧内合并为一次 setState，降低渲染压力；
  // 打字机视觉由 Markdown animated 承担，不丢任何事件、保持顺序。
  //
  // 渲染只吃 pi://event：它是 pi 子进程逐 token 转发的原始事件，无中间状态依赖，
  // 工作区一打开就能收到。此前还有一条 app://event（AppEvent 投影）与它抢渲染队列，
  // 但那条依赖 turn/item 追踪状态，追踪缺失时会静默丢事件，表现为「看不到过程，
  // 结果直接蹦出来」；权限确认走 pi://ui-request、MCP 状态走 setStatus，都有各自通道，
  // 因此 AppEvent 已整体移除。
  let queue: AgentEvent[] = [];
  let streamEpoch = 0;
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  /** 切走后仍在跑的会话。事件继续写进这里，不再灌进当前画面。 */
  const shadows = new Map<string, AgentState>();
  /** 没有任何历史打底、只靠后台事件攒出来的 shadow（缺前文），切回时消息以后端快照为准。 */
  const partialShadows = new Set<string>();
  /** 已经从画面解开、但 loadedSessionPath 还没换成目标时，这个路径的事件只进 shadow。 */
  let detachedPath: string | undefined;
  /** 停到后台的会话还没发出的跟进条。跟着会话走，不能在另一个会话结束时被冲进去。 */
  const parkedComposerQueues = new Map<string, AgentState['composerQueue']>();
  /** 刚停靠的那份画面已经带走了跟进条，下一份画面从空队列开始。 */
  let composerQueueParked = false;
  /** 切到 target 时它该显示的跟进条。 */
  const composerQueueFor = (target: string | null | undefined): AgentState['composerQueue'] => {
    let found: AgentState['composerQueue'] | undefined;
    if (target) {
      for (const [key, queued] of parkedComposerQueues) {
        if (!pathsEquivalent(key, target)) continue;
        found = queued;
        parkedComposerQueues.delete(key);
        break;
      }
    }
    const parked = composerQueueParked;
    composerQueueParked = false;
    return found ?? (parked ? [] : useStore.getState().composerQueue);
  };
  /** shadow 按路径等价查找（Windows 下大小写 / 分隔符可能不同）。 */
  const shadowKey = (path: string): string | undefined => {
    if (shadows.has(path)) return path;
    for (const key of shadows.keys()) if (pathsEquivalent(key, path)) return key;
    return undefined;
  };
  const getShadow = (path: string): AgentState | undefined => {
    const key = shadowKey(path);
    return key ? shadows.get(key) : undefined;
  };
  const dropShadow = (path: string) => {
    const key = shadowKey(path);
    if (key) {
      shadows.delete(key);
      partialShadows.delete(key);
    }
  };
  /** 这条事件 / 退出属于不在画面上的会话。 */
  const belongsElsewhere = (eventPath: string | undefined): eventPath is string => {
    if (!eventPath) return false;
    if (detachedPath && pathsEquivalent(eventPath, detachedPath)) return true;
    if (loadedSessionPath) return !pathsEquivalent(eventPath, loadedSessionPath);
    // 画面未绑定（草稿）：草稿首发先 bindSessionPath 再 prompt，绑定前没有属于它的带路径事件。
    // 带路径的一律是同项目别的会话——包括停靠时空闲、没留 shadow、之后才被唤醒的会话
    //（如后台子代理回报把父会话叫起来）。只认 shadow 会让这类会话的流灌进草稿。
    return true;
  };

  const hasDirtyDraft = (state: AgentState) =>
    Boolean(state.toolDrafts && Object.values(state.toolDrafts).some((draft) => draft.dirty));

  const scheduleDraftParse = () => {
    if (draftTimer != null) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      flush();
    }, LARGE_PARSE_INTERVAL_MS);
  };

  /** 推理结束后把实时计出的时长按消息 timestamp 落盘（供切换会话后回填）。 */
  const persistThinkingDurations = (state: AgentState) => {
    for (const m of state.messages) {
      if (
        m.kind === 'assistant' &&
        m.thinking &&
        m.timestamp != null &&
        m.thinkingDuration != null
      ) {
        saveThinkingDuration(m.timestamp, m.thinkingDuration);
      }
    }
  };

  const flush = () => {
    // 双保险下可能挂着一个未触发的调度：取消它，避免重复 flush（幂等但浪费一帧）。
    if (rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timeoutId != null) clearTimeout(timeoutId);
    rafId = null;
    timeoutId = null;
    if (!queue.length) {
      const current = useStore.getState();
      if (!hasDirtyDraft(current)) return;
      const { state: materialized, deferred } = materializeToolDrafts(current, Date.now(), parsePartialArgs);
      setFullState(materialized);
      if (deferred) scheduleDraftParse();
      return;
    }
    const events = queue;
    queue = [];
    let state = useStore.getState();
    let reachedEnd = false;
    for (const ev of events) {
      // 单个「毒事件」apply 失败只丢自己，不中断整批——否则长任务恢复时一批事件里
      // 一个异常会把其后的正文/thinking 全部丢弃，表现为「跑到一半直接停了」。
      try {
        state = applyEvent(state, ev);
      } catch {
        continue;
      }
      if (ev.type === 'agent_start' || ev.type === 'agent_end' || ev.type === 'agent_settled') {
        streamEpoch += 1;
      }
      if (ev.type === 'message_end' || ev.type === 'agent_end' || (ev.type === 'compaction_end' && ev.aborted !== true)) {
        reachedEnd = true;
      }
    }
    const { state: materialized, deferred } = materializeToolDrafts(state, Date.now(), parsePartialArgs);
    state = materialized;
    if (deferred) scheduleDraftParse();
    setFullState(state);
    if (reachedEnd) {
      // 持久化失败（localStorage 满 / 序列化异常）不影响已渲染内容。
      try {
        persistThinkingDurations(state);
        // 一轮结束后把当前会话最新内容写回缓存，使切走再切回时缓存即最新（不会先显旧快照再刷新闪动）。
        // 画面只有实时尾巴时不写：否则半截内容会盖掉磁盘上的完整 UI 历史。
        if (loadedSessionPath != null && viewHasHistory) {
          currentSig = sessionSignature(state.messages);
          setCachedSession(loadedSessionPath, state.messages, currentSig);
          // 持久化 UI 完整历史：state.messages 是前端累积的完整对话（reducer 不删），每轮结束覆盖写盘。
          // 即使随后 pi auto-compaction 压缩了后端会话，这份磁盘历史仍完整，重载时据此还原（fire-and-forget）。
          const key = sessionKeyFromPath(loadedSessionPath);
          if (key) void pi.writeUiHistory(workspace, key, serializeHistory(state.messages)).catch(() => {});
        }
      } catch {
        // ignore
      }
      // 轻量回填：只补本地用户消息缺失的 entryId/timestamp，不重排列表（fire-and-forget）。
      void syncEntryIdsAfterAccept();
    }
  };

  /** 按序把 getMessages 带回的 entryId/timestamp 补到本地用户消息；不重排、不整表重置。 */
  const syncEntryIdsAfterAccept = async () => {
    // 回包到达前画面可能已切到别的会话：只补发起时那个会话，且要按它的路径取消息。
    const pathAtStart = loadedSessionPath;
    try {
      const res = await pi.getMessages(workspace, pathAtStart);
      if (!samePath(loadedSessionPath, pathAtStart)) return;
      const current = useStore.getState().messages;
      const patched = backfillEntryIds(current, res.messages);
      if (patched === current) return;
      useStore.setState({ messages: patched });
      if (loadedSessionPath != null && viewHasHistory) {
        currentSig = sessionSignature(patched);
        setCachedSession(loadedSessionPath, patched, currentSig);
        const key = sessionKeyFromPath(loadedSessionPath);
        if (key) void pi.writeUiHistory(workspace, key, serializeHistory(patched)).catch(() => {});
      }
    } catch {
      // ignore：回填失败不阻断发送/回合结束路径
    }
  };

  const scheduleFlush = () => {
    if (rafId != null || timeoutId != null) return;
    if (active && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush);
      // 双保险：rAF 会被浏览器暂停（窗口最小化/隐藏/webview 节流），一旦暂停 rafId 永久非 null，
      // 此前的单 rAF 调度会把 setTimeout 兜底永久挡死（rafId != null 直接 return），queue 无限堆积、
      // UI 冻结成「跑到一半直接停了」。补一个 timeout 兜底唤醒，flush 时取消未触发的一方。
      timeoutId = setTimeout(flush, BACKGROUND_FLUSH_MS);
    } else {
      timeoutId = setTimeout(flush, BACKGROUND_FLUSH_MS);
    }
  };

  /** 丢弃未应用的排队事件（切换/重置会话时调用，避免旧会话事件串场）。 */
  const clearQueue = () => {
    queue = [];
    if (rafId != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
    rafId = null;
    timeoutId = null;
    if (draftTimer != null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  };

  const noteBackground = (eventPath: string, event: AgentEvent) => {
    const sessionPath = shadowKey(eventPath) ?? eventPath;
    let state = shadows.get(sessionPath);
    let needsBackfill = false;
    if (!state) {
      const cached = getCachedSession(sessionPath);
      if (!cached) {
        partialShadows.add(sessionPath);
        needsBackfill = true;
      }
      state = { ...initialAgentState(), messages: cached?.messages ?? [] };
    }
    try {
      state = applyEvent(state, event);
    } catch {
      return;
    }
    shadows.set(sessionPath, state);
    // 缺前文的 shadow 不能写缓存，否则切回时会把只有半轮的内容当完整历史秒显。
    // 它在后台补一份后端快照垫底，切回时就能直接显示完整内容。
    const partial = partialShadows.has(sessionPath);
    if (!partial) {
      setCachedSession(sessionPath, state.messages, sessionSignature(state.messages));
    }
    if (needsBackfill) scheduleBackfill(sessionPath);
    const type = (event as { type?: string }).type;
    if (type === 'agent_settled' || (type === 'agent_end' && (event as { willRetry?: boolean }).willRetry !== true)) {
      // 后台会话这一轮已结束，它挂起的交互请求后端已经不再等。
      dropStashedUiRequests(sessionPath);
      if (!state.isStreaming && !partial) {
        const key = sessionKeyFromPath(sessionPath);
        if (key) void pi.writeUiHistory(workspace, key, serializeHistory(state.messages)).catch(() => {});
      }
    }
  };

  /** 把画面上的会话停到后台：内容进 shadow，交互请求暂存，之后它的事件只写 shadow。 */
  const parkCurrent = (path: string) => {
    // 还没 flush 的事件属于画面上这份会话，先落进去再停靠，否则 clearQueue 会把它们丢掉。
    if (queue.length) flush();
    const state = useStore.getState();
    dropShadow(path);
    if (viewHasHistory) {
      if (state.isStreaming || state.awaitingResponse || state.runActive) shadows.set(path, state);
      setCachedSession(path, state.messages, sessionSignature(state.messages));
    } else {
      // 画面还没等到这份会话的历史，手里只有实时尾巴：停成 partial，不进缓存，后台补快照。
      shadows.set(path, state);
      partialShadows.add(path);
      scheduleBackfill(path);
    }
    detachedPath = path;
    if (state.composerQueue?.length) parkedComposerQueues.set(path, state.composerQueue);
    else parkedComposerQueues.delete(path);
    composerQueueParked = true;
    parkVisibleUiRequests(workspace, path);
  };

  /**
   * 画面要换成另一个会话前调用。已绑定路径时按它停靠；还没绑定（草稿首发刚落盘、
   * bindSessionPath 尚未赶上）时用调用方给的上一会话路径兜底。都没有就只能丢弃画面态。
   */
  const leaveView = (fromPath?: string | null) => {
    const path = loadedSessionPath ?? (liveActivity ? fromPath ?? undefined : undefined);
    if (path) parkCurrent(path);
    liveActivity = false;
  };

  /** 切到目标会话后，它在后台时的流式标记和暂存请求要跟着回来。 */
  const takeShadowRunState = (path: string): Partial<AgentState> => {
    const shadow = getShadow(path);
    dropShadow(path);
    if (!shadow || !(shadow.isStreaming || shadow.awaitingResponse)) return {};
    liveActivity = true;
    return {
      isStreaming: Boolean(shadow.isStreaming),
      runActive: Boolean(shadow.runActive ?? shadow.isStreaming),
      awaitingResponse: Boolean(shadow.awaitingResponse),
      // 计时起点跟着会话走：切回来「正在处理」接着数，不从切回的那一刻重算。
      ...(shadow.runStartedAt ? { runStartedAt: shadow.runStartedAt } : {}),
      ...(shadow.runOpening ? { runOpening: true } : {}),
      ...(shadow.runOriginPinned ? { runOriginPinned: true } : {}),
    };
  };

  /** 后端快照 → 界面消息。UI 完整历史更长时用它（压缩后后端历史会变短），并补回未完成的 ask_user 行。 */
  function snapshotMessages(msgs: AgentMessage[], uiHistory?: ChatMessage[]) {
    const backend = messagesFromAgent(msgs, getThinkingDuration);
    const processed = expandSystemWorkerChat(uiHistory && uiHistory.length > backend.length ? uiHistory : backend);
    return { backend, processed, sanitized: applyPendingAskUserOnLoad(processed, findPendingAskUser(msgs)) };
  }

  /**
   * partial shadow 只有实时尾巴。趁它还在后台，去后端取这份会话的快照垫在尾巴前面，
   * 之后它就是完整内容，切回时不必再等后端。快照回来时这份会话已经被接回画面、且画面仍缺历史，
   * 就直接垫进画面。
   */
  function scheduleBackfill(path: string): void {
    for (const pending of backfilling) if (pathsEquivalent(pending, path)) return;
    backfilling.add(path);
    void Promise.all([pi.getMessages(workspace, path), readUiHistoryForSession(workspace, path)])
      .then(([res, uiHistory]) => {
        if (destroyed) return;
        const key = shadowKey(path);
        const shadow = key ? shadows.get(key) : undefined;
        if (key && shadow && partialShadows.has(key)) {
          const merged = mergeLiveTail(snapshotMessages(res.messages, uiHistory).sanitized, shadow.messages);
          shadows.set(key, { ...shadow, messages: merged, excluded: excludedFromAgent(res.messages) });
          partialShadows.delete(key);
          setCachedSession(key, merged, sessionSignature(merged));
          return;
        }
        if (!viewHasHistory && loadedSessionPath != null && samePath(loadedSessionPath, path)) {
          loadMessages(res.messages, { force: true, sessionPath: loadedSessionPath, uiHistory });
        }
      })
      .catch(() => {
        // 取不到就留着 partial：切回时走骨架，等切换链自己取快照。
      })
      .finally(() => {
        backfilling.delete(path);
      });
  }

  onPiEvent((env) => {
    // Goal workers share the pi://event channel but are headless; their stream
    // must never be applied to the interactive session's message reducer.
    if (env.workspace !== workspace || env.source === 'goal' || env.source === 'subagent') return;
    if (env.event?.type === 'subagent_catalog_changed') return;
    const eventPath = typeof env.sessionPath === 'string' && env.sessionPath ? env.sessionPath : undefined;
    if (belongsElsewhere(eventPath)) {
      noteBackground(eventPath, env.event);
      return;
    }
    queue.push(env.event);
    scheduleFlush();
  }).then((un) => unsubs.push(un));

  onPiExit((env) => {
    if (env.workspace !== workspace || env.source === 'goal' || env.source === 'subagent') return;
    const eventPath = typeof env.sessionPath === 'string' && env.sessionPath ? env.sessionPath : undefined;
    if (belongsElsewhere(eventPath)) {
      const key = shadowKey(eventPath);
      const shadow = key ? shadows.get(key) : undefined;
      if (key && shadow) {
        shadows.set(key, { ...shadow, isStreaming: false, runActive: false, awaitingResponse: false });
      }
      dropStashedUiRequests(eventPath);
      return;
    }
    useStore.setState({ isStreaming: false });
  }).then((un) => unsubs.push(un));

  const pushUserMessage = (text: string, images?: UserImage[], steering?: boolean) => {
    liveActivity = true;
    setFullState(addUserMessage(useStore.getState(), text, images, steering));
  };

  const loadMessages = (msgs: AgentMessage[], options?: LoadMessagesOptions) => {
    if (liveActivity && !options?.force) return;
    const sessionPath =
      options && 'sessionPath' in options ? options.sessionPath ?? null : undefined;
    const previousLoaded = loadedSessionPath;
    // 后台 getMessages 可能与 prompt 并发返回。实时轮次尚未 flush 时，强制重载会 clearQueue()
    // 并把 store 重置为 initialAgentState()，后果是：已排队的 message_update（含 thinking delta）
    // 与 tool_execution_start 永久丢失、isStreaming/awaitingResponse 被清零、流式累积的推理内容
    // 被后端快照覆盖 —— 表现为「看不到过程、没有正在工作提示、没有深度思考，结果直接蹦出来」，
    // 且运行中的工具卡会被下方 sanitized 误标成 error。
    // 同一会话在等待首响应或已进入流式后，实时事件是唯一权威来源，快照延后到本轮结束再取；
    // 切换到另一会话仍允许强制加载。
    // 切到另一个已知路径的会话：先把画面上那份停到后台。目标会话自己还在后台跑时，
    // 它的 shadow 比后端快照新（含未落盘的流式内容），直接显示 shadow。
    if (sessionPath != null && !samePath(sessionPath, loadedSessionPath)) {
      const targetKey = shadowKey(sessionPath);
      const target = targetKey ? shadows.get(targetKey) : undefined;
      if (target && !partialShadows.has(targetKey!) && (target.isStreaming || target.awaitingResponse)) {
        showCached(sessionPath);
        return;
      }
      // 只有实时尾巴的 shadow：先接回画面，下面按同一会话把快照垫到尾巴前面。
      if (target && partialShadows.has(targetKey!)) showCached(sessionPath);
      else leaveView();
    }
    const liveState = useStore.getState();
    // 只有确实是同一会话时，才让实时流挡住强制重载；显式给了另一个路径一律按切换处理。
    const sameSession = sessionPath === undefined || samePath(sessionPath, loadedSessionPath);
    // 画面只有实时尾巴、缺历史：这份快照必须垫进去，不能被流式挡掉，也不能把尾巴冲掉。
    const fillHistory = sessionPath != null && sameSession && !viewHasHistory;
    if (options?.force && sameSession && !fillHistory && (liveState.isStreaming || liveState.awaitingResponse)) return;
    // UI 完整历史优先：pi auto-compaction 会让后端历史变短，前端持久化的完整历史（uiHistory）更长时用它，
    // 避免压缩后的短历史盖掉完整对话（rewind 等需要后端权威时调用方不传 uiHistory，自然走后端）。
    // 先补回当前未完成 ask_user 的 waiting 行，再算签名 / 写缓存，避免 uiHistory 盖掉 backend
    // 后缓存缺行；切回时 showCachedSession + sig 命中会永久跳过补行。
    const { backend, processed, sanitized } = snapshotMessages(msgs, options?.uiHistory);
    if (fillHistory) {
      const merged = mergeLiveTail(sanitized, liveState.messages);
      viewHasHistory = true;
      currentSig = sessionSignature(merged);
      setCachedSession(sessionPath, merged, currentSig);
      if (detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
      useStore.setState({
        messages: merged,
        excluded: excludedFromAgent(msgs),
        todoListFinished: liveState.todoListFinished ?? todoListFinishedInTranscript(msgs),
      });
      restoreInlineQuestionOnLoad(workspace, msgs, sessionPath);
      return;
    }
    const sig = sessionSignature(sanitized);
    // 浮层恢复：正常写入与「签名未变提前 return」两条路径都要跑，否则缓存命中会跳过浮层。
    // 读草稿异步，不 await，以免打乱上面「先补行再算签名」的顺序。
    const restoreOverlay = () => restoreInlineQuestionOnLoad(workspace, msgs, sessionPath);
    // 后台刷新命中「同一会话 + 内容未变」→ 跳过 setState：缓存已秒显，无谓重渲染会让整列闪一下。
    if (sessionPath != null && samePath(sessionPath, loadedSessionPath) && sig === currentSig) {
      const runState = takeShadowRunState(sessionPath);
      if (Object.keys(runState).length) useStore.setState(runState);
      liveActivity = Boolean(liveState.isStreaming || liveState.awaitingResponse || runState.isStreaming || runState.awaitingResponse);
      if (detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
      viewHasHistory = true;
      restoreOverlay();
      return;
    }
    liveActivity = false;
    viewHasHistory = true;
    const switching = sessionPath != null && !samePath(sessionPath, previousLoaded);
    if (sessionPath !== undefined) {
      loadedSessionPath = sessionPath;
      if (sessionPath && detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
    }
    currentSig = sig;
    if (sessionPath != null) setCachedSession(sessionPath, sanitized, sig);
    clearQueue();
    // 从会话树重建上下文排除集（best-effort），切换 / 重载会话后恢复灰显。
    const composerQueue = switching ? composerQueueFor(sessionPath) : useStore.getState().composerQueue;
    const runState = sessionPath != null ? takeShadowRunState(sessionPath) : {};
    // 同一会话重载（回退、截断、重新打开）不换计时起点：还在跑的回合接着数。
    const keepClock = !switching && liveState.runStartedAt ? { runStartedAt: liveState.runStartedAt } : {};
    setFullState({
      ...initialAgentState(),
      ...keepClock,
      messages: sanitized,
      excluded: excludedFromAgent(msgs),
      composerQueue,
      assistantStop: assistantStopFromMessages(msgs),
      todoListFinished: todoListFinishedInTranscript(msgs),
      ...runState,
    });
    if (switching && sessionPath) restoreStashedUiRequests(workspace, sessionPath);
    // 首次（无 uiHistory / uiHistory 更短）用后端起底：写一份 UI 历史，之后运行中每轮结束再覆盖为完整。
    if (sessionPath != null && processed === backend) {
      const key = sessionKeyFromPath(sessionPath);
      if (key) void pi.writeUiHistory(workspace, key, serializeHistory(backend)).catch(() => {});
    }
    restoreOverlay();
  };

  // excluded 是 Set：每次以新 Set 替换，保证 zustand 浅比较能触发订阅者重渲染。
  const setExcluded = (mutate: (s: Set<number>) => void) => {
    const next = new Set(useStore.getState().excluded);
    mutate(next);
    useStore.setState({ excluded: next });
  };

  const excludeMessage = async (timestamp: number) => {
    setExcluded((s) => {
      s.add(timestamp);
    });
    try {
      await pi.excludeEntry(workspace, timestamp);
    } catch (e) {
      setExcluded((s) => {
        s.delete(timestamp);
      });
      throw e;
    }
  };

  const restoreMessage = async (timestamp: number) => {
    setExcluded((s) => {
      s.delete(timestamp);
    });
    try {
      await pi.restoreEntry(workspace, timestamp);
    } catch (e) {
      setExcluded((s) => {
        s.add(timestamp);
      });
      throw e;
    }
  };

  const rewindTo = async (timestamp: number) => {
    await pi.rewindTo(workspace, timestamp);
    // fork 后 pi 会话指针已移到新分支：重载消息以反映回退结果（保留原路径，符合树模型）。
    const res = await pi.getMessages(workspace);
    loadMessages(res.messages, { force: true });
  };

  const isTruncatedOnDiskError = (error: unknown): boolean => {
    const msg = error instanceof Error ? error.message : String(error);
    return /truncated on disk/i.test(msg);
  };

  const deleteUiHistoryFailClosed = async () => {
    if (loadedSessionPath == null) return;
    const key = sessionKeyFromPath(loadedSessionPath);
    if (!key) return;
    try {
      await pi.deleteUiHistory(workspace, key);
    } catch {
      // ignore
    }
  };

  const persistUiHistoryAfterCut = async (messages: ChatMessage[]) => {
    if (loadedSessionPath == null) return;
    const key = sessionKeyFromPath(loadedSessionPath);
    if (!key) return;
    try {
      await pi.writeUiHistory(workspace, key, serializeHistory(messages));
    } catch {
      await deleteUiHistoryFailClosed();
    }
  };

  /**
   * 磁盘截断已成功后同步界面。若本地列表找不到 entryId，禁止把未裁短的长列表写回 ui-history：
   * 优先 getMessages 重建；失败则删除该会话 ui-history。
   */
  const applyCutToUi = async (entryId: string, mode: 'drop-target' | 'keep-target') => {
    useStore.setState({ isStreaming: false, awaitingResponse: false, runActive: false });
    const cut = cutMessagesAfterEntry(useStore.getState().messages, entryId, mode);
    if (!cut) {
      liveActivity = false;
      // 截断以后端为准：整份替换，不把画面上的旧内容当尾巴合并回去。
      viewHasHistory = true;
      try {
        const res = await pi.getMessages(workspace);
        // 必须带 sessionPath：否则短列表只进内存，磁盘上更长的 ui-history 仍会在下次加载盖回已删消息。
        loadMessages(res.messages, { force: true, sessionPath: loadedSessionPath });
      } catch {
        await deleteUiHistoryFailClosed();
      }
      return;
    }
    currentSig = sessionSignature(cut);
    if (loadedSessionPath != null) setCachedSession(loadedSessionPath, cut, currentSig);
    useStore.setState({ messages: cut });
    await persistUiHistoryAfterCut(cut);
  };

  const truncateTo = async (entryId: string, mode: 'drop-target' | 'keep-target') => {
    try {
      const result = await pi.truncateTo(workspace, entryId, mode);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error(
          result.reason === 'branched'
            ? '会话存在旁支，无法截断'
            : result.reason === 'missing'
              ? '截断失败：目标条目不存在'
              : '截断失败',
        );
      }
    } catch (error) {
      if (!isTruncatedOnDiskError(error)) throw error;
      // 磁盘已截断：按成功处理，继续同步界面。
    }
    await applyCutToUi(entryId, mode);
  };

  const toPromptImages = (images?: UserImage[]): PromptImage[] | undefined => {
    if (!images?.length) return undefined;
    return images.map((img) => ({ type: 'image' as const, mimeType: img.mimeType, data: img.data }));
  };

  const editAndSend = async (
    entryId: string,
    text: string,
    images?: UserImage[],
  ): Promise<'ok' | 'truncate-failed' | 'send-failed'> => {
    try {
      await truncateTo(entryId, 'drop-target');
    } catch {
      return 'truncate-failed';
    }
    try {
      await sendViaComposer(text, toPromptImages(images));
      return 'ok';
    } catch {
      setComposerValue(text);
      return 'send-failed';
    }
  };

  const rewindAndLoad = async (entryId: string, text: string) => {
    await truncateTo(entryId, 'drop-target');
    setComposerValue(text);
  };

  const regenerate = async (entryId: string, text: string, images?: UserImage[]) => {
    await truncateTo(entryId, 'keep-target');
    await sendViaComposer(text, toPromptImages(images));
  };

  const deleteFrom = async (entryId: string) => {
    await truncateTo(entryId, 'drop-target');
  };

  const reset = () => {
    if (loadedSessionPath) parkCurrent(loadedSessionPath);
    else detachedPath = undefined;
    // reset 自己就清空了画面，草稿里新排的跟进条不该再被当成「已停靠」丢掉。
    composerQueueParked = false;
    liveActivity = false;
    // 新会话尚无落盘路径：标记为未载入，切回时按完整加载处理（届时会话已有路径）。
    loadedSessionPath = undefined;
    currentSig = '';
    // 草稿从空白开始，画面上的就是它的全部内容。
    viewHasHistory = true;
    clearQueue();
    setFullState(initialAgentState());
  };

  function showCached(sessionPath: string, fromPath?: string | null): boolean {
    const previousPath = loadedSessionPath;
    const sameAsCurrent = samePath(previousPath, sessionPath);
    // 实时流式中不可被同一会话的缓存覆盖（会冲掉正在跑的内容）。画面已经是它：带着历史就算已显示，
    // 调用方不必退回骨架；还在等历史时照旧返回 false。
    if (sameAsCurrent && liveActivity) return viewHasHistory;
    const key = shadowKey(sessionPath);
    const partial = key != null && partialShadows.has(key);
    // 缺前文的 shadow 不当完整内容秒显，只作为实时尾巴接回画面。
    const targetShadow = key && !partial ? shadows.get(key) : undefined;
    const tail = key && partial ? shadows.get(key) : undefined;
    const entry = getCachedSession(sessionPath);
    if (!targetShadow && !entry) {
      // 没有缓存也要先把画面上的会话停到后台，否则它的流还会继续写进即将显示的目标会话。
      if (!sameAsCurrent) {
        leaveView(fromPath);
        loadedSessionPath = sessionPath;
        if (detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
        currentSig = '';
        clearQueue();
        const composerQueue = composerQueueFor(sessionPath);
        // 只有实时尾巴的 shadow 接回来继续收事件（含流式标记），历史等快照到了再垫到前面。
        const runState = takeShadowRunState(sessionPath);
        const base = tail && (runState.isStreaming || runState.awaitingResponse)
          ? { ...tail, retrying: undefined }
          : { ...initialAgentState(), messages: tail?.messages ?? [] };
        setFullState({ ...base, composerQueue, ...runState });
        viewHasHistory = false;
        // 之后的 loadMessages 已不算「切换」，暂存的交互请求在这里放回。
        restoreStashedUiRequests(workspace, sessionPath);
        return false;
      }
      return viewHasHistory;
    }
    if (!sameAsCurrent) leaveView(fromPath);
    const cachedMessages = targetShadow?.messages ?? entry!.messages;
    // 缓存是完整历史，partial shadow 是之后的实时尾巴：两者拼起来才是现在的样子。
    const messages = tail ? mergeLiveTail(cachedMessages, tail.messages) : cachedMessages;
    loadedSessionPath = sessionPath;
    if (detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
    currentSig = sessionSignature(messages);
    clearQueue();
    const composerQueue = sameAsCurrent ? useStore.getState().composerQueue : composerQueueFor(sessionPath);
    const runState = takeShadowRunState(sessionPath);
    // 还在跑的 shadow 整份接回（含工具参数草稿、引导队列），后续事件接着它往下应用。
    const live = Boolean(runState.isStreaming || runState.awaitingResponse);
    const base = targetShadow && live
      ? { ...targetShadow, retrying: undefined }
      : tail && live
        ? { ...tail, retrying: undefined, messages }
        : { ...initialAgentState(), messages };
    setFullState({ ...base, composerQueue, ...runState });
    viewHasHistory = true;
    // 同项目切会话：消息已是目标会话，浮层必须立刻对齐，否则用户会点到上一会话的卡。
    // live 且仍属同一会话时保留；切到另一 sessionPath 则清掉后按缓存恢复。
    const cur = useInlineQuestionStore.getState().byWorkspace[workspace];
    if (!(cur?.mode === 'live' && sameAsCurrent)) {
      if (cur?.mode === 'live') useInlineQuestionStore.getState().clear(workspace);
      restoreInlineQuestionOnLoad(workspace, agentMsgsForAskUserRestore(messages), sessionPath);
    }
    if (!sameAsCurrent) restoreStashedUiRequests(workspace, sessionPath);
    return true;
  }

  function bindSessionPath(sessionPath: string): void {
    if (samePath(loadedSessionPath, sessionPath)) return;
    // 草稿画面在等首发：已经绑到别的路径说明用户切走了，不能把那份内容改名。
    if (loadedSessionPath != null) return;
    loadedSessionPath = sessionPath;
    if (detachedPath && pathsEquivalent(detachedPath, sessionPath)) detachedPath = undefined;
    // 绑定前这个路径若有零星事件被当成后台收进了 shadow，现在画面就是它，旧 shadow 作废。
    dropShadow(sessionPath);
    const state = useStore.getState();
    currentSig = sessionSignature(state.messages);
    setCachedSession(sessionPath, state.messages, currentSig);
  }

  return {
    useStore,
    setActive: (next) => {
      active = next;
    },
    pushUserMessage,
    loadMessages,
    excludeMessage,
    restoreMessage,
    rewindTo,
    truncateTo,
    editAndSend,
    rewindAndLoad,
    regenerate,
    deleteFrom,
    syncEntryIdsAfterAccept,
    reset,
    hasLiveActivity: () => liveActivity,
    getStreamEpoch: () => streamEpoch,
    getLoadedSessionPath: () => loadedSessionPath,
    showCachedSession: showCached,
    bindSessionPath,
    destroy: () => {
      destroyed = true;
      clearQueue();
      for (const un of unsubs) un();
      unsubs.length = 0;
    },
  };
}
