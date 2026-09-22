import { create } from 'zustand';
import {
  applyEvent,
  initialAgentState,
  addUserMessage,
  messagesFromAgent,
  excludedFromAgent,
  assistantStopFromMessages,
  type AgentState,
  type ChatMessage,
  type UserImage,
} from './agentReducer';
import { pi, onPiEvent, onPiExit, type AgentEvent, type AgentMessage } from '../lib/pi';
import { getThinkingDuration, saveThinkingDuration } from '../lib/thinkingDurations';
import { getCachedSession, setCachedSession, sessionSignature } from '../lib/sessionMessageCache';
import { sessionKeyFromPath, serializeHistory } from '../lib/uiHistory';
import { expandSystemWorkerChat } from '../lib/systemWorkerChat';
import { todoListFinishedInTranscript } from '@extensions/_shared/todo-model';
import {
  sendViaComposer,
  setComposerValue,
  type PromptImage,
} from '../features/chat/input/composerBridge';
import { backfillEntryIds, cutMessagesAfterEntry } from './sessionMessageSync';

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
  showCachedSession: (sessionPath: string) => boolean;
  destroy: () => void;
}

/** 非 active store 的 flush 间隔（rAF 在后台被节流，用 setTimeout 兜底）。 */
const BACKGROUND_FLUSH_MS = 60;

/** 为某工作区创建 agent 状态，并订阅 pi://event。 */
export function createAgentStore(workspace: string): AgentStoreApi {
  let liveActivity = false;
  // 内存内消息当前对应的会话路径（undefined = 从未载入）。用于切回工作区时判断是否可复用缓存。
  let loadedSessionPath: string | null | undefined = undefined;
  // 当前展示内容的轻量签名：后台刷新比对，未变则跳过 setState，避免整列重渲染闪一下。
  let currentSig = '';
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
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let active = true;

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
    if (!queue.length) return;
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
      if (ev.type === 'message_end' || ev.type === 'agent_end') reachedEnd = true;
    }
    setFullState(state);
    if (reachedEnd) {
      // 持久化失败（localStorage 满 / 序列化异常）不影响已渲染内容。
      try {
        persistThinkingDurations(state);
        // 一轮结束后把当前会话最新内容写回缓存，使切走再切回时缓存即最新（不会先显旧快照再刷新闪动）。
        if (loadedSessionPath != null) {
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
    try {
      const res = await pi.getMessages(workspace);
      const current = useStore.getState().messages;
      const patched = backfillEntryIds(current, res.messages);
      if (patched === current) return;
      useStore.setState({ messages: patched });
      if (loadedSessionPath != null) {
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
  };

  onPiEvent((env) => {
    // Goal workers share the pi://event channel but are headless; their stream
    // must never be applied to the interactive session's message reducer.
    if (env.workspace !== workspace || env.source === 'goal' || env.source === 'subagent') return;
    if (env.event?.type === 'subagent_catalog_changed') return;
    queue.push(env.event);
    scheduleFlush();
  }).then((un) => unsubs.push(un));

  onPiExit((env) => {
    if (env.workspace !== workspace || env.source === 'goal' || env.source === 'subagent') return;
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
    // 后台 getMessages 可能与 prompt 并发返回。实时轮次尚未 flush 时，强制重载会 clearQueue()
    // 并把 store 重置为 initialAgentState()，后果是：已排队的 message_update（含 thinking delta）
    // 与 tool_execution_start 永久丢失、isStreaming/awaitingResponse 被清零、流式累积的推理内容
    // 被后端快照覆盖 —— 表现为「看不到过程、没有正在工作提示、没有深度思考，结果直接蹦出来」，
    // 且运行中的工具卡会被下方 sanitized 误标成 error。
    // 同一会话在等待首响应或已进入流式后，实时事件是唯一权威来源，快照延后到本轮结束再取；
    // 切换到另一会话仍允许强制加载。
    const liveState = useStore.getState();
    const sameSession =
      sessionPath === undefined ||
      (loadedSessionPath != null && sessionPath === loadedSessionPath) ||
      (loadedSessionPath === undefined && liveActivity);
    if (options?.force && sameSession && (liveState.isStreaming || liveState.awaitingResponse)) return;
    const backend = messagesFromAgent(msgs, getThinkingDuration);
    // UI 完整历史优先：pi auto-compaction 会让后端历史变短，前端持久化的完整历史（uiHistory）更长时用它，
    // 避免压缩后的短历史盖掉完整对话（rewind 等需要后端权威时调用方不传 uiHistory，自然走后端）。
    const uiHistory = options?.uiHistory;
    const processed = expandSystemWorkerChat(
      uiHistory && uiHistory.length > backend.length ? uiHistory : backend,
    );
    const sig = sessionSignature(processed);
    // 后台刷新命中「同一会话 + 内容未变」→ 跳过 setState：缓存已秒显，无谓重渲染会让整列闪一下。
    if (sessionPath != null && sessionPath === loadedSessionPath && sig === currentSig) {
      liveActivity = false;
      return;
    }
    liveActivity = false;
    if (sessionPath !== undefined) loadedSessionPath = sessionPath;
    currentSig = sig;
    if (sessionPath != null) setCachedSession(sessionPath, processed, sig);
    clearQueue();
    // 从会话树重建上下文排除集（best-effort），切换 / 重载会话后恢复灰显。
    // 重启后残留的 status:'running' 工具消息（进程被杀、未收到 tool_execution_end）标为 error，
    // 避免永久显示「运行中…」。
    const sanitized = processed.map((m) =>
      m.kind === 'tool' && m.status === 'running' ? { ...m, status: 'error' as const } : m,
    );
    const composerQueue = useStore.getState().composerQueue;
    setFullState({
      ...initialAgentState(),
      messages: sanitized,
      excluded: excludedFromAgent(msgs),
      composerQueue,
      assistantStop: assistantStopFromMessages(msgs),
      todoListFinished: todoListFinishedInTranscript(msgs),
    });
    // 首次（无 uiHistory / uiHistory 更短）用后端起底：写一份 UI 历史，之后运行中每轮结束再覆盖为完整。
    if (sessionPath != null && processed === backend) {
      const key = sessionKeyFromPath(sessionPath);
      if (key) void pi.writeUiHistory(workspace, key, serializeHistory(backend)).catch(() => {});
    }
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
    liveActivity = false;
    // 新会话尚无落盘路径：标记为未载入，切回时按完整加载处理（届时会话已有路径）。
    loadedSessionPath = undefined;
    currentSig = '';
    clearQueue();
    setFullState(initialAgentState());
  };

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
    getLoadedSessionPath: () => loadedSessionPath,
    showCachedSession: (sessionPath) => {
      // 实时流式中不可被缓存覆盖（会冲掉正在跑的会话）。
      if (liveActivity) return false;
      const entry = getCachedSession(sessionPath);
      if (!entry) return false;
      loadedSessionPath = sessionPath;
      currentSig = entry.sig;
      clearQueue();
      const composerQueue = useStore.getState().composerQueue;
      setFullState({ ...initialAgentState(), messages: entry.messages, composerQueue });
      return true;
    },
    destroy: () => {
      clearQueue();
      for (const un of unsubs) un();
      unsubs.length = 0;
    },
  };
}
