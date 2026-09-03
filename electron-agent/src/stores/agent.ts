import { create } from 'zustand';
import {
  applyEvent,
  initialAgentState,
  addUserMessage,
  messagesFromAgent,
  excludedFromAgent,
  type AgentState,
  type ChatMessage,
  type UserImage,
} from './agentReducer';
import { pi, onAppEvent, onPiEvent, onPiExit, type AgentEvent, type AgentMessage, type AppEvent } from '../lib/pi';
import { getThinkingDuration, saveThinkingDuration } from '../lib/thinkingDurations';
import { getCachedSession, setCachedSession, sessionSignature } from '../lib/sessionMessageCache';
import { sessionKeyFromPath, serializeHistory } from '../lib/uiHistory';
import { useUiPromptStore } from './uiPromptStore';
import { useMcpStatusStore, type McpServerStatus } from './mcpStatusStore';

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

const PROJECTED_PI_EVENTS = new Set([
  'agent_start', 'agent_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isProjectedPiEvent(event: AgentEvent): boolean {
  if (!PROJECTED_PI_EVENTS.has(event.type)) return false;
  if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
    return (event as { message?: { role?: unknown } }).message?.role === 'assistant';
  }
  return true;
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
  let queue: Array<AgentEvent | AppEvent> = [];
  let appEventsActive = false;
  const seenAppEvents = new Set<string>();
  const appEventCursorKey = `pi-app-event-cursor:${workspace}`;
  let appEventCursor = readAppEventCursor(appEventCursorKey);
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
    rafId = null;
    timeoutId = null;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    let state = useStore.getState();
    let reachedEnd = false;
    for (const ev of events) {
      state = applyEvent(state, ev);
      if (ev.type === 'message_end' || ev.type === 'agent_end') reachedEnd = true;
    }
    setFullState(state);
    if (reachedEnd) {
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
    }
  };

  const scheduleFlush = () => {
    if (rafId != null || timeoutId != null) return;
    if (active && typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush);
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
    if (env.workspace !== workspace) return;
    if (appEventsActive && isProjectedPiEvent(env.event)) return;
    queue.push(env.event);
    scheduleFlush();
  }).then((un) => unsubs.push(un));

  onAppEvent((env) => {
    if (env.workspace !== workspace) return;
    if (!acceptAppEvent(env.event)) return;
    appEventsActive = true;
    const data = isRecord(env.event.data) ? env.event.data : {};
    if (env.event.type === 'permission.requested') {
      const request = isRecord(data.request) ? data.request : undefined;
      const id = request && typeof request.id === 'string' ? request.id : undefined;
      if (id) {
        const operation = isRecord(request.operation) ? request.operation : {};
        useUiPromptStore.getState().setRequest({
          workspace,
          request: {
            id,
            method: 'confirm',
            source: 'permission',
            title: '权限请求',
            message: typeof operation.kind === 'string' ? operation.kind : '允许本次操作？',
          },
        });
      }
    } else if (env.event.type === 'permission.resolved') {
      const id = typeof data.requestId === 'string' ? data.requestId : undefined;
      useUiPromptStore.getState().clear(workspace, id);
    } else if (env.event.type === 'mcp.state_changed' && Array.isArray(data.servers)) {
      useMcpStatusStore.getState().setServers(data.servers as McpServerStatus[]);
    }
    queue.push(env.event);
    scheduleFlush();
  }).then((un) => unsubs.push(un));

  if (typeof pi.replayAppEvents === 'function' && appEventCursor > 0) {
    void pi.replayAppEvents(appEventCursor, 1024).then((events) => {
      for (const event of events) {
        if (!acceptAppEvent(event) || event.projectId !== workspace) continue;
        appEventsActive = true;
        queue.push(event);
      }
      if (events.some((event) => event.projectId === workspace)) scheduleFlush();
    }).catch(() => {});
  }

  onPiExit((env) => {
    if (env.workspace !== workspace) return;
    useStore.setState({ isStreaming: false });
  }).then((un) => unsubs.push(un));

  const pushUserMessage = (text: string, images?: UserImage[], steering?: boolean) => {
    liveActivity = true;
    setFullState(addUserMessage(useStore.getState(), text, images, steering));
  };

  function acceptAppEvent(event: AppEvent): boolean {
    if (seenAppEvents.has(event.id)) return false;
    seenAppEvents.add(event.id);
    if (Number.isFinite(event.sequence) && event.sequence > appEventCursor) {
      appEventCursor = event.sequence;
      try { localStorage.setItem(appEventCursorKey, String(appEventCursor)); } catch { /* storage unavailable */ }
    }
    return true;
  }

  const loadMessages = (msgs: AgentMessage[], options?: LoadMessagesOptions) => {
    if (liveActivity && !options?.force) return;
    const sessionPath =
      options && 'sessionPath' in options ? options.sessionPath ?? null : undefined;
    const backend = messagesFromAgent(msgs, getThinkingDuration);
    // UI 完整历史优先：pi auto-compaction 会让后端历史变短，前端持久化的完整历史（uiHistory）更长时用它，
    // 避免压缩后的短历史盖掉完整对话（rewind 等需要后端权威时调用方不传 uiHistory，自然走后端）。
    const uiHistory = options?.uiHistory;
    const processed = uiHistory && uiHistory.length > backend.length ? uiHistory : backend;
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
    setFullState({ ...initialAgentState(), messages: sanitized, excluded: excludedFromAgent(msgs) });
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
      setFullState({ ...initialAgentState(), messages: entry.messages });
      return true;
    },
    destroy: () => {
      clearQueue();
      for (const un of unsubs) un();
      unsubs.length = 0;
    },
  };
}

function readAppEventCursor(key: string): number {
  try {
    const value = Number(localStorage.getItem(key) ?? '0');
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
