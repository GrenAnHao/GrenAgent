import { todoListFinishedInTranscript, type TodoTranscriptMessage } from '@extensions/_shared/todo-model';
import { closedChainSteps, closedParallelTasks, closedStringField, closedTopLevelString, type NormalizedTask } from '@extensions/multi-agent/tasks';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import type { AgentEvent, AgentMessage, AssistantMessageEvent } from '../lib/pi';
import type { WaitingUiPrompt } from './waitingUiPrompt';

/** 用户消息里的图片（base64），用于在气泡中回显发送的图片。 */
export interface UserImage {
  mimeType: string;
  data: string;
}

/**
 * 引导消息在当前回合里的下落，对齐 Kiro 的 steerState：
 * written 已收下、尚未注入；consumed 已注入正在跑的这一轮；requeued 这一轮结束前没注入。
 */
export type SteerState = 'written' | 'consumed' | 'requeued';

export type ChatMessage =
  | {
      kind: 'user';
      id: string;
      text: string;
      images?: UserImage[];
      steering?: boolean;
      steerState?: SteerState;
      /** pi 消息自带的 Unix ms 时间戳；作为「移出上下文 / 回退到此」的稳定 key。本地新发的消息在落盘前为 undefined。 */
      timestamp?: number;
      /** 会话文件条目 id；截断 / 回退 / 重新生成 / 删除的定位键。后端投影带回前可能缺省。 */
      entryId?: string;
      /** 子代理任务提示词：气泡内限高，不把全文铺在面板上。 */
      promptFrame?: boolean;
    }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      thinking: string;
      streaming: boolean;
      /** pi 消息自带的 Unix ms 时间戳，用作推理时长持久化的 key。 */
      timestamp?: number;
      /** 推理开始时间戳（首个 thinking 出现时记起点），用于计算时长。 */
      thinkingStartedAt?: number;
      /** 推理耗时（ms），推理结束（正文开始或消息结束）时定格，用于「已深度思考（用时 X 秒）」。 */
      thinkingDuration?: number;
    }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      status: 'running' | 'done' | 'error';
      /** false = 参数仍在生成；缺省视为完整。不进历史文件。 */
      argsComplete?: boolean;
      /** 真正开始执行的时刻（tool_execution_start），用于运行中实时计时；参数生成阶段不计。 */
      startedAt?: number;
      /** 执行耗时（ms），tool_execution_end 时定格，用于卡片右侧显示固定时长。 */
      durationMs?: number;
      /** 嵌套调用的父工具。codemode 里的 MCP 调用带这个 id，时间线挂到父卡片下面。 */
      parentToolCallId?: string;
      /** 助手消息中止 / 出错时按「已中断」收掉的卡片。随后到的工具结果消息会把它换成真实结果。 */
      interrupted?: boolean;
    }
  | { kind: 'notice'; id: string; customType: string; content: string; /** 原消息的 timestamp：同一条的 message_start / message_end 靠它认出来。 */ sourceTimestamp?: number }
  /** 一次成功的上下文压缩留在会话里的分隔。进行中只显示「正在压缩」，结束后写成这一条。 */
  | { kind: 'compaction'; id: string };

export interface AgentState {
  messages: ChatMessage[];
  /** 被用户「移出上下文」的消息 timestamp 集合（对模型不可见，不删盘，可恢复）。UI 据此灰显。 */
  excluded: Set<number>;
  isStreaming: boolean;
  steering: string[];
  followUp: string[];
  /** 执行中发送后停在输入栏的跟进条；点引导才注入当前回合，否则本轮结束后自动跟进。 */
  composerQueue: Array<{ id: string; text: string; images?: UserImage[] }>;
  lastError?: string;
  /**
   * 自动重试中的进度（attempt 从 1 起，max 为总重试次数）；非重试时为 undefined。
   * auto 表示是 pi 自己的接口错误重试（auto_retry_*），这期间的报错写进 error、不弹红条；
   * 没有 auto 的是界面发送没被收下时的重试。attempt 为 0 表示 pi 已说要重试、还没报次数。
   */
  retrying?: { attempt: number; max: number; auto?: boolean; error?: string };
  /** 用户主动中断进行中：abort 触发的 "request aborted" 类报错不该弹红条，置位期间 reducer 丢弃这些
   * 错误（仅抑制用户主动中断，不影响真实失败）。由 ChatView 点停止时置位，agent_start/agent_end 清位。 */
  aborting?: boolean;
  /** 发送后到后端首个 agent_start 之间的「准备响应中」占位态：发送即置位，agent_start/agent_end/出错清位。
   * 用于在 isStreaming 尚未为 true 的冷启动/会话预备窗口立即给出等待反馈（消除「不知道在等什么」的空档）。 */
  awaitingResponse?: boolean;
  /** 上下文压缩进行中：由 pi 的 compaction_start/compaction_end 事件驱动，UI 据此显示「正在压缩上下文…」。
   * 此前这两个事件被前端丢弃，压缩（手动 /compact 或自动）全程无任何状态反馈。 */
  compacting?: boolean;
  /** 扩展正在等 ctx.ui 提示（批准 / 确认 / 输入）。由 setStatus('ui-prompt') 写入，agent_end 清掉。 */
  waitingUiPrompt?: WaitingUiPrompt;
  /**
   * 一次 prompt 仍占用 session：agent_start 置位，直到 agent_settled 才清。
   * 中间的 turn_end / agent_end(willRetry) 都还不算空闲（自动重试、compaction、排队续跑仍可能发生）。
   */
  runActive?: boolean;
  /**
   * 「正在处理」的起点：用户这次请求开始的时刻。agent_settled 不清，之后由子代理回报、自动压缩续跑、
   * 排队跟进等接着跑的回合沿用它；用户从空闲发起新请求时才重新起算。
   */
  runStartedAt?: number;
  /**
   * 界面发送时已经定好了下一回合的 runStartedAt（新请求起算、或跟进 / 引导沿用）。
   * 下一个从空闲开始的回合照办，或被任一条用户消息用掉。
   */
  runOriginPinned?: boolean;
  /** 刚从空闲开始的回合，还没看到它的第一条用户 / 自定义 / 助手消息，计时起点未定。 */
  runOpening?: boolean;
  /**
   * 最近一条 assistant 的停止原因。只有 stop 才表示这轮正常说完；
   * aborted / error 不能把还在进行中的任务收成完成。
   */
  assistantStop?: 'stop' | 'aborted' | 'error';
  /** 最近一次 todo 清单已经做完。下一轮用户消息后任务条收起，直到出现新的 todo 结果。 */
  todoListFinished?: boolean;
  /** 当前流式 assistant 消息里正在生成参数的工具调用草稿，按 contentIndex 存。只在内存里，不进 messages、不序列化。 */
  toolDrafts?: Record<number, ToolDraft>;
}

export interface ToolDraft {
  contentIndex: number;
  /** 对应工具卡片的 ChatMessage.id；工具名未知时为 undefined（尚未建卡）。 */
  cardId?: string;
  /** 真实 toolCallId；未知时为 ''。 */
  toolCallId: string;
  toolName: string;
  /** 累积的原始参数 JSON 片段。 */
  json: string;
  /** 自上次解析后有新片段。 */
  dirty: boolean;
  /** 上次解析的时间（ms）。 */
  parsedAt: number;
}

/** 新一轮从现在计时。同一轮里的重试、agent_end 再启动沿用已有起点。 */
export function nextRunStartedAt(state: { runActive?: boolean; isStreaming?: boolean; runStartedAt?: number }): number {
  if ((state.runActive || state.isStreaming) && state.runStartedAt) return state.runStartedAt;
  return Date.now();
}

/**
 * 界面要发一条会开启或接续回合的消息时调用：空闲时从现在起算，仍在跑就沿用。fresh 强制从现在起算。
 * 钉住之后，即使 Pi 把这条消息推迟到上一轮收尾之后才开新回合，起点也按这里定的算。
 */
export function pinRunClock(
  state: { runActive?: boolean; isStreaming?: boolean; runStartedAt?: number },
  fresh = false,
): { runStartedAt: number; runOriginPinned: true } {
  return { runStartedAt: fresh ? Date.now() : nextRunStartedAt(state), runOriginPinned: true };
}

/**
 * 回合的第一条消息决定计时起点：界面钉过就照办；否则用户消息说明有人从别处发了新请求，
 * 从现在起算；自定义消息（子代理回报、压缩后续跑、后台任务通知）和直接续写的助手消息是同一件事的延续，沿用。
 * 回合中途的用户消息（引导、跟进）只用掉界面的钉定，不动起点。
 */
function settleRunClock(state: AgentState, role: unknown): AgentState {
  const user = role === 'user';
  if (!state.runOpening) return user && state.runOriginPinned ? { ...state, runOriginPinned: false } : state;
  if (!user && role !== 'custom' && role !== 'assistant') return state;
  const restart = user && !state.runOriginPinned;
  return {
    ...state,
    runOpening: false,
    runOriginPinned: false,
    ...(restart ? { runStartedAt: Date.now() } : {}),
  };
}

export function initialAgentState(): AgentState {
  return { messages: [], excluded: new Set(), isStreaming: false, steering: [], followUp: [], composerQueue: [] };
}

function todoListFinishedFromRun(
  messages: readonly TodoTranscriptMessage[] | undefined,
  previous: boolean | undefined,
): boolean | undefined {
  if (!messages?.some((message) => message?.role === 'toolResult' && typeof message.toolName === 'string' && message.toolName.toLowerCase() === 'todo')) {
    return previous;
  }
  return todoListFinishedInTranscript(messages);
}

export function assistantStopFromMessages(
  messages: readonly { role?: unknown; stopReason?: unknown }[] | undefined,
): AgentState['assistantStop'] {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const reason = message.stopReason;
    if (reason === 'stop' || reason === 'aborted' || reason === 'error') return reason;
    return undefined;
  }
  return undefined;
}

let counter = 0;
const nextId = () => `m${++counter}`;

/** 计算推理计时：首个 thinking 出现时记起点，正文出现或消息结束（final）时定格耗时。 */
function thinkingTiming(
  cur: { thinkingStartedAt?: number; thinkingDuration?: number },
  thinkingText: string,
  answerText: string,
  final = false,
): { thinkingStartedAt?: number; thinkingDuration?: number } {
  let { thinkingStartedAt, thinkingDuration } = cur;
  if (thinkingText.trim() && thinkingStartedAt == null) thinkingStartedAt = Date.now();
  const reasoningEnded = final || answerText.trim().length > 0;
  if (reasoningEnded && thinkingStartedAt != null && thinkingDuration == null) {
    thinkingDuration = Date.now() - thinkingStartedAt;
  }
  return { thinkingStartedAt, thinkingDuration };
}

/** 读取 pi 消息的 Unix ms 时间戳（非法值返回 undefined）。 */
function messageTimestamp(msg: AgentMessage): number | undefined {
  const ts = (msg as { timestamp?: unknown }).timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
}

/** 压缩主动打断回合时的报错，不是模型失败。 */
function isAbortError(message: string | undefined): boolean {
  return typeof message === "string" && /abort/i.test(message);
}

/** 读取 pi assistant 消息上的 errorMessage（模型/供应商失败时 Pi 会带上，此前被 UI 丢弃）。 */
function messageError(msg: AgentMessage): string | undefined {
  const raw = (msg as { errorMessage?: unknown }).errorMessage;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function extractText(msg: AgentMessage): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  const content = msg.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown> | null>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
    }
  }
  return { text, thinking };
}

/** 提取用户消息里的图片块（与发送格式一致：{type:'image', mimeType, data}）。Pi 用别的格式则不提取。 */
function extractImages(msg: AgentMessage): UserImage[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const out: UserImage[] = [];
  for (const block of content as Array<Record<string, unknown> | null>) {
    if (!block || typeof block !== 'object') continue;
    if (
      block.type === 'image' &&
      typeof block.mimeType === 'string' &&
      typeof block.data === 'string'
    ) {
      out.push({ mimeType: block.mimeType, data: block.data });
    }
  }
  return out;
}

interface PendingToolCall {
  toolName: string;
  args: unknown;
}

/** 从 assistant 消息的 content 块提取 toolCall（供历史还原时匹配 args）。 */
function extractToolCalls(msg: AgentMessage): Array<{ id: string; toolName: string; args: unknown }> {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; toolName: string; args: unknown }> = [];
  for (const block of content as Array<Record<string, unknown> | null>) {
    if (!block || block.type !== 'toolCall') continue;
    const id = typeof block.id === 'string' ? block.id : '';
    const toolName = typeof block.name === 'string' ? block.name : '';
    if (!id || !toolName) continue;
    out.push({
      id,
      toolName,
      args: block.arguments ?? block.input ?? {},
    });
  }
  return out;
}

function registerToolCalls(pending: Map<string, PendingToolCall>, msg: AgentMessage): void {
  for (const tc of extractToolCalls(msg)) {
    pending.set(tc.id, { toolName: tc.toolName, args: tc.args });
  }
}

/**
 * 把一条 assistant 消息里携带的 toolCall 块同步成 running 工具卡片（按 toolCallId upsert）：
 * 命中已存在卡片则刷新参数（仅当仍 running，不回写已完成卡片），否则新建一张 running 卡片。
 *
 * 这是「Write/Edit 等工具看起来卡住、写完才显示」的修复点：tool_execution_start 要等模型把整段
 * 参数（尤其 Write 的 content）流式生成完、真正开始执行时才发；而每个 message_update 都带「截至
 * 当前的完整 assistant 消息」，其 content 里的 toolCall 块参数随流式逐渐补全 —— 据此在参数生成
 * 阶段就把卡片立起来并实时刷新（模型一边写、卡片一边长），不再等到执行结束才整条蹦出来。
 * 后端若未流式下发 toolCall 也无副作用：届时 message_* 取不到 toolCall 块，退回由
 * tool_execution_start 建卡的旧路径。
 */
function syncStreamingToolCalls(messages: ChatMessage[], msg: AgentMessage): ChatMessage[] {
  const calls = extractToolCalls(msg);
  if (calls.length === 0) return messages;
  let next = messages;
  let cloned = false;
  const ensureCloned = () => {
    if (!cloned) {
      next = [...next];
      cloned = true;
    }
  };
  for (const call of calls) {
    const idx = next.findIndex((m) => m.kind === 'tool' && m.toolCallId === call.id);
    if (idx === -1) {
      ensureCloned();
      next.push({
        kind: 'tool',
        id: nextId(),
        toolCallId: call.id,
        toolName: call.toolName,
        args: call.args,
        result: undefined,
        status: 'running',
        argsComplete: true,
      });
      continue;
    }
    const cur = next[idx];
    // 已 done/error 的卡片是终态（tool_execution_end 才是参数/结果的权威来源），流式快照不回写。
    if (cur.kind === 'tool' && cur.status === 'running') {
      ensureCloned();
      next[idx] = { ...cur, toolName: call.toolName || cur.toolName, args: call.args, argsComplete: true };
    }
  }
  return next;
}

type ToolChatMessage = Extract<ChatMessage, { kind: 'tool' }>;

function dropDrafts(state: AgentState, patch: Partial<AgentState> = {}): AgentState {
  const merged: AgentState = { ...state, ...patch };
  delete merged.toolDrafts;
  return merged;
}

/**
 * 回合真正收尾时收掉 pi 的接口重试条。重试用完、最后一次的报错还在重试条里，就落成红条；
 * 用户主动中断的不落。界面自己的发送重试不归这里管。
 */
function settleAutoRetry(state: AgentState): Partial<AgentState> {
  if (!state.retrying?.auto) return {};
  const error = state.aborting ? undefined : state.retrying.error;
  return { retrying: undefined, ...(error && !state.lastError ? { lastError: error } : {}) };
}

function commitDrafts(state: AgentState, messages: ChatMessage[], drafts: Record<number, ToolDraft>): AgentState {
  if (Object.keys(drafts).length === 0) return dropDrafts(state, { messages });
  return { ...state, messages, toolDrafts: drafts };
}

function attachToolCard(messages: ChatMessage[], draft: ToolDraft): { messages: ChatMessage[]; draft: ToolDraft } {
  if (!draft.toolName || draft.cardId) return { messages, draft };
  if (draft.toolCallId) {
    const idx = lastIndex(messages, (m) => m.kind === 'tool' && m.toolCallId === draft.toolCallId);
    if (idx >= 0) {
      const cur = messages[idx];
      if (cur.kind === 'tool') return { messages, draft: { ...draft, cardId: cur.id } };
    }
  }
  const id = nextId();
  const card: ToolChatMessage = {
    kind: 'tool',
    id,
    toolCallId: draft.toolCallId || `pending:${id}`,
    toolName: draft.toolName,
    args: {},
    result: undefined,
    status: 'running',
    argsComplete: false,
  };
  return { messages: [...messages, card], draft: { ...draft, cardId: id } };
}

function rebindToolCallId(messages: ChatMessage[], cardId: string | undefined, toolCallId: string): ChatMessage[] {
  if (!cardId || !toolCallId) return messages;
  const idx = lastIndex(messages, (m) => m.kind === 'tool' && m.id === cardId);
  if (idx < 0) return messages;
  const cur = messages[idx];
  if (cur.kind !== 'tool' || cur.toolCallId === toolCallId) return messages;
  const next = [...messages];
  next[idx] = { ...cur, toolCallId };
  return next;
}

function toolcallFields(ame: AssistantMessageEvent): { id?: string; toolName?: string; delta?: string } {
  const raw = ame as { id?: unknown; toolName?: unknown; delta?: unknown };
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : undefined,
    toolName: typeof raw.toolName === 'string' && raw.toolName ? raw.toolName : undefined,
    delta: typeof raw.delta === 'string' ? raw.delta : '',
  };
}

function applyToolcallEvent(state: AgentState, ame: AssistantMessageEvent): AgentState {
  const contentIndex = typeof (ame as { contentIndex?: unknown }).contentIndex === 'number'
    ? (ame as { contentIndex: number }).contentIndex
    : 0;
  const drafts = { ...(state.toolDrafts ?? {}) };
  const fields = toolcallFields(ame);

  if (ame.type === 'toolcall_start') {
    if (drafts[contentIndex]) return state;
    let draft: ToolDraft = {
      contentIndex,
      toolCallId: fields.id ?? '',
      toolName: fields.toolName ?? '',
      json: '',
      dirty: false,
      parsedAt: 0,
    };
    let messages = state.messages;
    if (draft.toolName) {
      const attached = attachToolCard(messages, draft);
      messages = attached.messages;
      draft = attached.draft;
    }
    drafts[contentIndex] = draft;
    return commitDrafts(state, messages, drafts);
  }

  if (ame.type === 'toolcall_delta') {
    let draft = drafts[contentIndex];
    let messages = state.messages;
    if (!draft) {
      draft = {
        contentIndex,
        toolCallId: fields.id ?? '',
        toolName: fields.toolName ?? '',
        json: '',
        dirty: false,
        parsedAt: 0,
      };
      if (draft.toolName) {
        const attached = attachToolCard(messages, draft);
        messages = attached.messages;
        draft = attached.draft;
      }
    }
    draft = { ...draft, json: draft.json + (fields.delta ?? ''), dirty: true };
    if (fields.id && fields.id !== draft.toolCallId) {
      draft = { ...draft, toolCallId: fields.id };
      messages = rebindToolCallId(messages, draft.cardId, fields.id);
    }
    if (fields.toolName && !draft.toolName) draft = { ...draft, toolName: fields.toolName };
    if (!draft.cardId && draft.toolName) {
      const attached = attachToolCard(messages, draft);
      messages = attached.messages;
      draft = attached.draft;
    }
    drafts[contentIndex] = draft;
    return commitDrafts(state, messages, drafts);
  }

  if (ame.type === 'toolcall_end') {
    const toolCall = (ame as { toolCall?: { id?: unknown; name?: unknown; arguments?: unknown } }).toolCall;
    const id = typeof toolCall?.id === 'string' ? toolCall.id : '';
    const name = typeof toolCall?.name === 'string' ? toolCall.name : '';
    const args = toolCall?.arguments && typeof toolCall.arguments === 'object' && !Array.isArray(toolCall.arguments)
      ? toolCall.arguments
      : {};
    const draft = drafts[contentIndex];
    let messages = state.messages;
    let idx = draft?.cardId ? lastIndex(messages, (m) => m.kind === 'tool' && m.id === draft.cardId) : -1;
    if (idx < 0 && id) idx = lastIndex(messages, (m) => m.kind === 'tool' && m.toolCallId === id);
    if (idx >= 0 && messages[idx]?.kind === 'tool') {
      const cur = messages[idx] as ToolChatMessage;
      const next = [...messages];
      next[idx] = {
        ...cur,
        toolCallId: id || cur.toolCallId,
        toolName: name || cur.toolName,
        args,
        argsComplete: true,
      };
      messages = next;
    } else {
      const cardId = nextId();
      messages = [...messages, {
        kind: 'tool',
        id: cardId,
        toolCallId: id || `pending:${cardId}`,
        toolName: name || draft?.toolName || '',
        args,
        result: undefined,
        status: 'running',
        argsComplete: true,
      }];
    }
    delete drafts[contentIndex];
    return commitDrafts(state, messages, drafts);
  }

  return state;
}

function rebindDraftsFromContent(messages: ChatMessage[], drafts: Record<number, ToolDraft> | undefined, msg: AgentMessage): ChatMessage[] {
  if (!drafts) return messages;
  const content = msg.content;
  if (!Array.isArray(content)) return messages;
  let next = messages;
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as { type?: unknown; id?: unknown } | null;
    if (!block || block.type !== 'toolCall') continue;
    const cardId = drafts[i]?.cardId;
    const id = typeof block.id === 'string' ? block.id : '';
    if (!cardId || !id) continue;
    next = rebindToolCallId(next, cardId, id);
  }
  return next;
}

function failRunningToolCards(messages: ChatMessage[], cardIds: Set<string>, toolCallIds: Set<string>, text: string): ChatMessage[] {
  let next = messages;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.kind !== 'tool' || m.status !== 'running') continue;
    if (!cardIds.has(m.id) && !toolCallIds.has(m.toolCallId)) continue;
    if (next === messages) next = [...messages];
    next[i] = {
      ...m,
      status: 'error',
      argsComplete: true,
      interrupted: true,
      result: { content: [{ type: 'text', text }] },
    };
  }
  return next;
}

/**
 * 工具结果消息到了：把还在转、或刚按「已中断」收掉的卡片换成这条结果。
 * 中止时助手消息可能先到、结果后到。已由 tool_execution_end 定格的卡片不动，那里的结果带着
 * structuredContent 等字段。
 */
function settleToolFromResultMessage(state: AgentState, msg: AgentMessage): AgentState {
  const raw = msg as { toolCallId?: unknown; isError?: unknown };
  if (typeof raw.toolCallId !== 'string' || !raw.toolCallId) return state;
  const idx = lastIndex(state.messages, (m) => m.kind === 'tool' && m.toolCallId === raw.toolCallId);
  if (idx < 0) return state;
  const cur = state.messages[idx];
  if (cur.kind !== 'tool' || (cur.status !== 'running' && !cur.interrupted)) return state;
  const messages = [...state.messages];
  const { interrupted: _interrupted, ...rest } = cur;
  messages[idx] = {
    ...rest,
    result: toolResultPayload(msg),
    status: raw.isError === true ? 'error' : 'done',
    argsComplete: true,
    ...(cur.startedAt != null && cur.durationMs == null ? { durationMs: Math.max(0, Date.now() - cur.startedAt) } : {}),
  };
  return { ...state, messages };
}

function settleIncompleteToolCards(messages: ChatMessage[]): ChatMessage[] {
  let touched = false;
  const next = messages.map((m) => {
    if (m.kind === 'assistant' && m.streaming) {
      touched = true;
      return { ...m, streaming: false };
    }
    if (m.kind === 'tool' && m.argsComplete === false) {
      touched = true;
      return {
        ...m,
        status: 'error' as const,
        argsComplete: true,
        result: { content: [{ type: 'text', text: '已中断' }] },
      };
    }
    return m;
  });
  return touched ? next : messages;
}

export const LARGE_ARGS_CHARS = 64 * 1024;
export const LARGE_PARSE_INTERVAL_MS = 150;

/** 解析变脏的草稿，把半截参数写回对应卡片的 args。返回是否还有因节流被推迟的草稿。 */
export function materializeToolDrafts(
  state: AgentState,
  now: number,
  parse: (json: string) => Record<string, unknown>,
): { state: AgentState; deferred: boolean } {
  const drafts = state.toolDrafts;
  if (!drafts) return { state, deferred: false };
  let messages = state.messages;
  let nextDrafts: Record<number, ToolDraft> | undefined;
  let deferred = false;
  for (const draft of Object.values(drafts)) {
    if (!draft.dirty || !draft.cardId) continue;
    if (draft.json.length > LARGE_ARGS_CHARS && now - draft.parsedAt < LARGE_PARSE_INTERVAL_MS) {
      deferred = true;
      continue;
    }
    const idx = lastIndex(messages, (m) => m.kind === 'tool' && m.id === draft.cardId);
    const card = idx >= 0 ? messages[idx] : undefined;
    if (card?.kind === 'tool' && card.argsComplete === false) {
      if (messages === state.messages) messages = [...messages];
      const parsed = parse(draft.json);
      messages[idx] = {
        ...card,
        args: card.toolName === 'spawn_agent' ? closedSpawnArgs(draft.json, parsed) : parsed,
      };
    }
    nextDrafts ??= { ...drafts };
    nextDrafts[draft.contentIndex] = { ...draft, dirty: false, parsedAt: now };
  }
  if (!nextDrafts) return { state, deferred };
  return { state: { ...state, messages, toolDrafts: nextDrafts }, deferred };
}

/** 流式 spawn_agent 只保留引号或对象已经闭合的任务，避免半句被解析器补全后逐字长出来。 */
function closedTaskArg(item: NormalizedTask): string | { task: string; title?: string; model?: string; agent?: string } {
  if (!item.model && !item.agent && !item.title) return item.task;
  return {
    task: item.task,
    ...(item.title ? { title: item.title } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.agent ? { agent: item.agent } : {}),
  };
}

function closedSpawnArgs(json: string, parsed: Record<string, unknown>): Record<string, unknown> {
  const next = { ...parsed };
  const closed = closedParallelTasks(json);
  if ('tasks' in parsed || closed.length > 0) {
    next.tasks = closed.map(closedTaskArg);
  }
  const chain = closedChainSteps(json);
  if ('chain' in parsed || chain.length > 0) {
    next.chain = chain.map((item) => ({
      task: item.task,
      ...(item.title ? { title: item.title } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.agent ? { agent: item.agent } : {}),
    }));
  }
  const taskField = closedStringField(json, 'task');
  if (typeof taskField === 'string') next.task = taskField;
  else delete next.task;
  const titleField = closedTopLevelString(json, 'title');
  if (typeof titleField === 'string') next.title = titleField;
  else delete next.title;
  return next;
}

/** 把 pi toolResult 消息还原成与 tool_execution_end 一致的 result 形状。 */
function toolResultPayload(msg: AgentMessage): unknown {
  const raw = msg as { content?: unknown; details?: unknown };
  if (raw.content == null && raw.details === undefined) return {};
  return {
    ...(raw.content != null ? { content: raw.content } : {}),
    ...(raw.details !== undefined ? { details: raw.details } : {}),
  };
}

/**
 * display:false 的自定义消息照样画卡片的类型。goal-round 是 Goal 每一轮续跑发给模型的正文：
 * 扩展按 display:false 发（TUI 里不刷屏），桌面端要在对话里看见「第 N 轮开始了」。
 */
const SHOWN_HIDDEN_CUSTOM_TYPES = new Set(['goal-round']);

function showsCustomMessage(msg: AgentMessage): boolean {
  if ((msg as { display?: unknown }).display === true) return true;
  const customType = (msg as { customType?: unknown }).customType;
  return typeof customType === 'string' && SHOWN_HIDDEN_CUSTOM_TYPES.has(customType);
}

/** 把 pi 的 CustomMessage（role:'custom', display:true，或上面列出的类型）转成一条去重的 notice。 */
function applyCustomMessage(state: AgentState, msg: AgentMessage): AgentState {
  if (!showsCustomMessage(msg)) return state;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content.trim()) return state;
  const rawCustomType = (msg as { customType?: unknown }).customType;
  const customType = typeof rawCustomType === 'string' ? rawCustomType : '';
  // 同一条消息的 message_start / message_end 会各来一次，要去重。agent-message（send_message wake: false）
  // 可能真的连发两条一样的（「还在跑测试」）：按原消息的 timestamp 认同一条，正文相同不算重复。其余通知照旧按正文去重。
  const rawTimestamp = (msg as { timestamp?: unknown }).timestamp;
  const sourceTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : undefined;
  if (customType === 'agent-message' && sourceTimestamp !== undefined) {
    const same = state.messages.some(
      (m) => m.kind === 'notice' && m.customType === customType && m.sourceTimestamp === sourceTimestamp && m.content === content,
    );
    if (same) return state;
  } else if (state.messages.some((m) => m.kind === 'notice' && m.content === content)) {
    return state;
  }
  return {
    ...state,
    messages: [
      ...state.messages,
      { kind: 'notice', id: nextId(), customType, content, ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}) },
    ],
  };
}

/** 引导被注入当前回合：优先按正文对上，对不上且只剩一条未确认引导时收下那一条。 */
export function consumeSteer(messages: ChatMessage[], text: string): ChatMessage[] {
  const written = messages.flatMap((message, index) =>
    message.kind === 'user' && message.steering && message.steerState === 'written' ? [{ message, index }] : [],
  );
  if (written.length === 0) return messages;
  const exact = text ? written.find((item) => item.message.text === text) : undefined;
  const target = exact ?? (written.length === 1 ? written[0] : undefined);
  if (!target) return messages;
  const next = messages.slice();
  next[target.index] = { ...target.message, steerState: 'consumed' };
  return next;
}

/** 这一轮已经结束，还停在 written 的引导没有注入当前回合。 */
export function requeuePendingSteers(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.kind !== 'user' || !message.steering || message.steerState !== 'written') return message;
    changed = true;
    return { ...message, steerState: 'requeued' as const };
  });
  return changed ? next : messages;
}

function parentToolLink(parentToolCallId: string | undefined): { parentToolCallId?: string } {
  return typeof parentToolCallId === 'string' && parentToolCallId ? { parentToolCallId } : {};
}

export function applyEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case 'agent_start':
      // 一轮真正开始流式：清掉「正在重试」指示（成功重连/重发）、上一条错误与中断标记，
      // 并清掉「准备响应中」占位（由 isStreaming 接管等待指示，无缝过渡）。
      return {
        ...state,
        isStreaming: true,
        runActive: true,
        // 从空闲开始的回合等第一条消息再定起点；同一轮里重试、续写的 agent_start 不动。
        ...(state.runActive ? {} : { runOpening: true }),
        awaitingResponse: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        lastError: undefined,
        // pi 的接口重试要等 auto_retry_end 才算完；界面自己的发送重试到这里就成了。
        retrying: state.retrying?.auto ? state.retrying : undefined,
        aborting: false,
        assistantStop: undefined,
      };

    case 'agent_end': {
      // 收起仍在流的 assistant，并把参数没写完的工具卡标成中断（丢了 message_end 时的兜底）。
      // willRetry 时这一轮还会继续，未注入的引导先留着，等真正收尾再改成 requeued。
      const willRetry = (event as { willRetry?: boolean }).willRetry === true;
      const settled = settleIncompleteToolCards(state.messages);
      const messages = willRetry ? settled : requeuePendingSteers(settled);
      const ended = {
        awaitingResponse: false,
        aborting: false,
        compacting: false,
        waitingUiPrompt: undefined,
        assistantStop: assistantStopFromMessages(
          (event as { messages?: { role?: unknown; stopReason?: unknown }[] }).messages,
        ),
        todoListFinished: todoListFinishedFromRun(
          (event as { messages?: TodoTranscriptMessage[] }).messages,
          state.todoListFinished,
        ),
        messages,
      };
      if (willRetry) {
        // pi 退避后会自己重发：这一轮没结束，保持 streaming（停止按钮留着、发送等待不放行），
        // 刚才的报错挪进重试条，不弹红条。次数等紧随其后的 auto_retry_start 再补。
        return dropDrafts(state, {
          ...ended,
          lastError: undefined,
          retrying: {
            attempt: state.retrying?.auto ? state.retrying.attempt : 0,
            max: state.retrying?.auto ? state.retrying.max : 0,
            auto: true,
            error: state.lastError ?? state.retrying?.error,
          },
        });
      }
      return dropDrafts(state, {
        ...ended,
        isStreaming: false,
        ...settleAutoRetry(state),
      });
    }

    case 'agent_settled': {
      // agent_settled 是 RPC 流程的最终收尾事件，晚于 agent_end（扩展的 agent_end hooks 可能仍在执行）。
      // 即使中间的历史快照刷新覆盖过状态，也必须在此清掉停止按钮对应的 streaming 标记，
      // 避免 UI 永久停在「待停止」。参数没写完的工具卡同样收成中断。
      // runStartedAt 留着：紧接着由子代理回报、压缩续跑、推迟的跟进开启的回合要接着计时。
      const messages = requeuePendingSteers(settleIncompleteToolCards(state.messages));
      return dropDrafts(state, {
        isStreaming: false,
        runActive: false,
        runOpening: false,
        awaitingResponse: false,
        aborting: false,
        compacting: false,
        waitingUiPrompt: undefined,
        messages,
        ...settleAutoRetry(state),
      });
    }

    case 'message_start': {
      const ev = event as Extract<AgentEvent, { type: 'message_start' }>;
      const cleared = dropDrafts(settleRunClock(state, ev.message?.role));
      if (ev.message.role === 'custom') return applyCustomMessage(cleared, ev.message);
      if (ev.message.role === 'user') {
        return { ...cleared, messages: consumeSteer(cleared.messages, extractText(ev.message).text) };
      }
      if (ev.message.role !== 'assistant') return cleared;
      const { text, thinking } = extractText(ev.message);
      const messages = [...state.messages];
      const idx = lastIndex(messages, (m) => m.kind === 'assistant' && m.streaming);
      // pi 同一时刻只有一个 streamingMessage；重复 message_start 应复用而非叠空泡
      if (idx >= 0) {
        const cur = messages[idx] as Extract<ChatMessage, { kind: 'assistant' }>;
        const nextText = text || cur.text;
        const nextThinking = thinking || cur.thinking;
        messages[idx] = {
          ...cur,
          text: nextText,
          thinking: nextThinking,
          timestamp: messageTimestamp(ev.message) ?? cur.timestamp,
          ...thinkingTiming(cur, nextThinking, nextText),
        };
      } else {
        messages.push({
          kind: 'assistant',
          id: nextId(),
          text,
          thinking,
          streaming: true,
          timestamp: messageTimestamp(ev.message),
          ...thinkingTiming({}, thinking, text),
        });
      }
      // 模型可能在首帧就带上 toolCall 块（或一次性返回）：同步成 running 卡片，与流式路径一致。
      return { ...cleared, messages: syncStreamingToolCalls(messages, ev.message) };
    }

    case 'message_end': {
      const ev = event as Extract<AgentEvent, { type: 'message_end' }>;
      if (ev.message.role === 'custom') return applyCustomMessage(state, ev.message);
      if (ev.message.role === 'toolResult') return settleToolFromResultMessage(state, ev.message);
      if (ev.message.role !== 'assistant') return state;
      const { text, thinking } = extractText(ev.message);
      const errMsg = messageError(ev.message);
      const messages = [...state.messages];
      const idx = lastIndex(messages, (m) => m.kind === 'assistant' && m.streaming);
      // 用户主动中断期间，abort 触发的 errorMessage 不弹红条（aborting 由 ChatView 置位）。
      const shownErr = errMsg && !state.aborting ? errMsg : undefined;
      // pi 接口重试进行中：这次失败只更新重试条，是否落红条等 agent_end 说不再重试。
      const errPatch: Partial<AgentState> = !shownErr
        ? {}
        : state.retrying?.auto
          ? { retrying: { ...state.retrying, error: shownErr } }
          : { lastError: shownErr };
      if (idx < 0) {
        // 无在流的 assistant 泡：有可见文本/思考才补一条终态 assistant；纯 toolCall（无文本/思考）
        // 不建空泡，由下方 syncStreamingToolCalls 兜底把卡片立住，避免多条灰线。
        // 会话文件已经还原过同一条助手时，迟到的 message_end 不能再追加，否则工具后面会多一块思考和正文。
        const duplicate = matchingFinishedAssistant(messages, text, thinking);
        if (duplicate >= 0) {
          const cur = messages[duplicate] as Extract<ChatMessage, { kind: 'assistant' }>;
          messages[duplicate] = {
            ...cur,
            text,
            thinking,
            streaming: false,
            timestamp: messageTimestamp(ev.message) ?? cur.timestamp,
            ...thinkingTiming(cur, thinking, text, true),
          };
        } else if (text || thinking) {
          messages.push({
            kind: 'assistant',
            id: nextId(),
            text,
            thinking,
            streaming: false,
            timestamp: messageTimestamp(ev.message),
            ...thinkingTiming({}, thinking, text, true),
          });
        }
      } else {
        const cur = messages[idx] as Extract<ChatMessage, { kind: 'assistant' }>;
        // 终态消息可能不含 thinking / text 块（推理和正文只在流式 delta 里给），
        // 保留流式累积，避免 `--mode json` 的空 message_end 把子代理回复抹掉。
        const finalThinking = thinking || cur.thinking;
        const finalText = text || cur.text;
        // 仅含 tool call、无可见文本/思考的 assistant 消息不展示（否则会叠成多条灰线）
        if (!finalText && !finalThinking) {
          messages.splice(idx, 1);
        } else {
          messages[idx] = {
            ...cur,
            text: finalText,
            thinking: finalThinking,
            streaming: false,
            timestamp: messageTimestamp(ev.message) ?? cur.timestamp,
            ...thinkingTiming(cur, finalThinking, finalText, true),
          };
        }
      }
      // 先按 contentIndex 把草稿卡改绑到终态 toolCall id，兜住没收到 toolcall_end 的情况。
      const rebound = rebindDraftsFromContent(messages, state.toolDrafts, ev.message);
      const stopReason = (ev.message as { stopReason?: unknown }).stopReason;
      if (stopReason === 'aborted' || stopReason === 'error') {
        const failText = errMsg ?? (stopReason === 'aborted' ? '已中断' : '生成失败');
        const cardIds = new Set<string>();
        for (const draft of Object.values(state.toolDrafts ?? {})) {
          if (draft.cardId) cardIds.add(draft.cardId);
        }
        const toolCallIds = new Set(extractToolCalls(ev.message).map((call) => call.id));
        const failed = failRunningToolCards(rebound, cardIds, toolCallIds, failText);
        return dropDrafts(state, { messages: failed, ...errPatch });
      }
      // 终态再 upsert 一次 toolCall：覆盖后端「只在 message_end 给完整 toolCall、不流式」的情况，
      // 让卡片即使没走流式也能在 tool_execution_start 之前带完整参数立住。
      const synced = syncStreamingToolCalls(rebound, ev.message);
      return dropDrafts(state, { messages: synced, ...errPatch });
    }

    case 'message_update': {
      const ev = event as Extract<AgentEvent, { type: 'message_update' }>;
      const ame = ev.assistantMessageEvent as AssistantMessageEvent | undefined;
      if (ame && (ame.type === 'toolcall_start' || ame.type === 'toolcall_delta' || ame.type === 'toolcall_end')) {
        return applyToolcallEvent(state, ame);
      }
      // pi 的流式增量事件只带 assistantMessageEvent、不带 message 快照（实测 2532/2532 条
      // message_update 均无 message 字段，只有 message_start / message_end 带完整快照）。
      // 直接读 ev.message 会因 undefined 抛 TypeError —— 修复前会中断整个 flush 批次（观感
      // 「卡在第一个字」），被 try/catch 兜住后又会让增量完全无法累积（观感「结果直出」）。
      // 因此统一取防御后的快照，并以 assistantMessageEvent.delta 作为 thinking / text 的累积来源。
      const snapshot = (ev.message ?? {}) as AgentMessage;
      const { text, thinking } = extractText(snapshot);
      // 有些模型（如部分 OpenAI 兼容 / MiMo）只在流式 thinking_delta 里给推理、不写进 message.content，
      // 这里把 delta 累积起来，作为 content 无 thinking 块时的兜底来源。正文同理需要 text_delta 累积。
      const rawDelta = ame && 'delta' in ame ? ame.delta : undefined;
      const delta = typeof rawDelta === 'string' ? rawDelta : '';
      const thinkingDelta = ame?.type === 'thinking_delta' ? delta : '';
      const textDelta = ame?.type === 'text_delta' ? delta : '';
      const messages = [...state.messages];
      const idx = lastIndex(messages, (m) => m.kind === 'assistant' && m.streaming);
      if (idx >= 0) {
        const cur = messages[idx] as Extract<ChatMessage, { kind: 'assistant' }>;
        const nextThinking = thinking || cur.thinking + thinkingDelta;
        // 正文同样需要 delta 累积：message 快照缺失时 text 恒为空，否则正文也会「直出」。
        const nextText = text || cur.text + textDelta;
        messages[idx] = {
          ...cur,
          text: nextText,
          thinking: nextThinking,
          timestamp: messageTimestamp(snapshot) ?? cur.timestamp,
          ...thinkingTiming(cur, nextThinking, nextText),
        };
      } else {
        const nextThinking = thinking || thinkingDelta;
        const nextText = text || textDelta;
        const duplicate = matchingFinishedAssistant(messages, nextText, nextThinking);
        if (duplicate >= 0 && !thinkingDelta && !textDelta) {
          return state;
        }
        if (duplicate >= 0) {
          const cur = messages[duplicate] as Extract<ChatMessage, { kind: 'assistant' }>;
          messages[duplicate] = {
            ...cur,
            text: nextText || cur.text,
            thinking: nextThinking || cur.thinking,
            timestamp: messageTimestamp(snapshot) ?? cur.timestamp,
          };
        } else {
          messages.push({
            kind: 'assistant',
            id: nextId(),
            text: nextText,
            thinking: nextThinking,
            streaming: true,
            timestamp: messageTimestamp(snapshot),
            ...thinkingTiming({}, nextThinking, nextText),
          });
        }
      }
      // 生产事件没有 message 快照。只有测试或上游重新带上快照时，才按 toolCall 块建卡。
      const synced = ev.message ? syncStreamingToolCalls(messages, snapshot) : messages;
      return { ...state, messages: synced };
    }

    case 'tool_execution_start': {
      const ev = event as Extract<AgentEvent, { type: 'tool_execution_start' }>;
      // 流式阶段 message_update 可能已据 toolCall 块建好这张卡片：命中则复用并用执行时的权威完整
      // 参数覆盖（避免重复出现两张卡片）；未命中（后端未流式下发 toolCall）则新建。
      const existing = state.messages.findIndex(
        (m) => m.kind === 'tool' && m.toolCallId === ev.toolCallId,
      );
      if (existing >= 0) {
        const cur = state.messages[existing];
        if (cur.kind === 'tool') {
          const messages = [...state.messages];
          messages[existing] = {
            ...cur,
            toolName: ev.toolName,
            args: ev.args,
            status: 'running',
            argsComplete: true,
            startedAt: Date.now(),
            ...parentToolLink(ev.parentToolCallId),
          };
          return { ...state, messages };
        }
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: 'tool',
            id: nextId(),
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            args: ev.args,
            result: undefined,
            status: 'running',
            argsComplete: true,
            startedAt: Date.now(),
            ...parentToolLink(ev.parentToolCallId),
          },
        ],
      };
    }

    case 'tool_execution_update': {
      const ev = event as Extract<AgentEvent, { type: 'tool_execution_update' }>;
      return updateTool(state, ev.toolCallId, (t) => ({
        ...t,
        result: ev.partialResult,
        ...parentToolLink(ev.parentToolCallId),
      }));
    }

    case 'tool_execution_end': {
      const ev = event as Extract<AgentEvent, { type: 'tool_execution_end' }>;
      const next = updateTool(state, ev.toolCallId, (t) => ({
        ...t,
        result: ev.result,
        status: ev.isError ? 'error' : 'done',
        ...(t.startedAt != null ? { durationMs: Math.max(0, Date.now() - t.startedAt) } : {}),
        ...parentToolLink(ev.parentToolCallId),
      }));
      if (ev.isError || ev.toolName?.toLowerCase() !== 'todo') return next;
      return { ...next, todoListFinished: false };
    }

    case 'queue_update': {
      const ev = event as Extract<AgentEvent, { type: 'queue_update' }>;
      return { ...state, steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
    }

    case 'auto_retry_start': {
      const ev = event as Extract<AgentEvent, { type: 'auto_retry_start' }>;
      return {
        ...state,
        lastError: undefined,
        retrying: { attempt: ev.attempt, max: ev.maxAttempts, auto: true, error: ev.errorMessage || state.retrying?.error },
      };
    }

    case 'auto_retry_end': {
      const ev = event as Extract<AgentEvent, { type: 'auto_retry_end' }>;
      const retrying = state.retrying?.auto ? undefined : state.retrying;
      if (ev.success) return { ...state, retrying, lastError: undefined };
      // 用户取消（pi 报 Retry cancelled）不算失败。
      const cancelled = state.aborting || ev.finalError === 'Retry cancelled';
      const finalError = ev.finalError || state.retrying?.error;
      return { ...state, retrying, lastError: cancelled ? state.lastError : finalError ?? state.lastError };
    }

    case 'extension_error': {
      const ev = event as Extract<AgentEvent, { type: 'extension_error' }>;
      return { ...state, lastError: ev.error };
    }

    case 'compaction_start':
      // 自动压缩会先 abort 正在跑的回合，模型侧带着 "Request was aborted"。
      // 这不是给用户看的失败；压缩一开始就清掉，避免红条盖住「正在压缩」。
      return {
        ...state,
        compacting: true,
        ...(isAbortError(state.lastError) ? { lastError: undefined } : {}),
      };

    case 'compaction_end': {
      const ev = event as Extract<AgentEvent, { type: 'compaction_end' }>;
      // pi 在上下文已超过 max token、压缩本身失败时仍会发 compaction_end，且 aborted 可能是 false。
      // 只有没有错误信息的结束才算真正压完；失败不留「已压缩」。
      const failed = ev.aborted || Boolean(ev.errorMessage);
      const lastError = failed && !ev.willRetry && ev.errorMessage ? ev.errorMessage : state.lastError;
      const messages = failed
        ? state.messages
        : [...state.messages, { kind: 'compaction' as const, id: nextId() }];
      return { ...state, compacting: false, lastError, messages };
    }

    default: {
      // 兜底：未显式建模、却带 string error 字段的事件。
      // 这类事件大多是协议层噪声 / 良性竞态（典型如后端对「无人等待的 RPC 响应」兜底转发的
      // unmatched_response：abort 后迟到、重复、或 id 已被取代的响应），对用户没有可操作价值。
      // 它们常在 agent_start（清空 lastError）之前到达、又与之跨动画帧，于是表现为「发送对话时
      // 红色错误条瞬间弹闪一下又消失」。真正的失败都有专门承载路径，不依赖这里兜底：
      //   - 命令失败 → 匹配 pending 的响应 Err，由各 caller 的 try/catch 处理；
      //   - 模型/供应商失败 → message_end 的 errorMessage（见上方 case）；
      //   - 扩展失败 → extension_error；自动重试最终失败 → auto_retry_end.finalError。
      // 因此这里不再把 error 写入 lastError（避免误弹/闪现）；后端 client.rs 也已对 unmatched
      // 响应改为只记日志、不再 emit，此处仅作双保险。abort 进行中仍按中断语义停流。
      const maybeError = (event as { error?: unknown }).error;
      if (typeof maybeError === 'string' && maybeError.trim()) {
        if (state.aborting) return { ...state, isStreaming: false };
        return state;
      }
      return state;
    }
  }
}

/**
 * 本地插入一条用户消息（pi 不会回发用户消息，需前端在发送时主动加入）。
 * steering=true 表示这是执行中注入当前回合的引导消息——不视为「新一轮等待响应」，
 * 避免触发「准备响应中」占位（AI 此刻已在响应）。
 */
/**
 * 发送没被会话收下时，去掉刚乐观插入的那条用户消息。
 * 已有 entryId，或后面已经接上助手/工具输出时，返回 null，避免把已经发生的回合撤掉。
 */
export function dropUnpersistedUserTail(messages: readonly ChatMessage[], text: string): ChatMessage[] | null {
  const last = messages[messages.length - 1];
  if (!last || last.kind !== 'user' || last.entryId || last.text !== text) return null;
  return messages.slice(0, -1);
}

/**
 * 还没收到任何助手正文、思考或工具时，手动取消可以把刚发出的用户消息撤掉。
 * 末尾的空助手占位不算已收到回复。已落盘则带回 entryId，调用方再截断会话。
 */
export function rollbackUnansweredSend(
  messages: readonly ChatMessage[],
  text: string,
): { messages: ChatMessage[]; entryId?: string } | null {
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message?.kind === 'assistant' && !message.text.trim() && !message.thinking.trim()) {
      index -= 1;
      continue;
    }
    break;
  }
  const last = messages[index];
  if (!last || last.kind !== 'user' || last.steering || last.text !== text) return null;
  return { messages: messages.slice(0, index), ...(last.entryId ? { entryId: last.entryId } : {}) };
}

export function addUserMessage(
  state: AgentState,
  text: string,
  images?: UserImage[],
  steering?: boolean,
): AgentState {
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        kind: 'user',
        id: nextId(),
        text,
        images: images?.length ? images : undefined,
        ...(steering ? { steering: true, steerState: 'written' as const } : {}),
      },
    ],
  };
}

/**
 * 从 pi get_messages 结果还原聊天列表（用于切换会话）。
 * pi 会话不存推理耗时，可传 getDuration 按消息 timestamp 回填（见 lib/thinkingDurations）。
 */
export function messagesFromAgent(
  msgs: AgentMessage[],
  getDuration?: (timestamp: number | undefined) => number | undefined,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  // 最后一条助手消息发出、还没有结果的调用。中途残留的孤儿调用不算，补在末尾会乱序。
  let trailingCalls = new Map<string, PendingToolCall>();

  for (const msg of msgs) {
    if (msg.role === 'custom') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (showsCustomMessage(msg) && content.trim()) {
        const rawCustomType = (msg as { customType?: unknown }).customType;
        const customType = typeof rawCustomType === 'string' ? rawCustomType : '';
        out.push({ kind: 'notice', id: nextId(), customType, content });
      }
      continue;
    }
    if (msg.role === 'user') {
      trailingCalls = new Map();
      const { text } = extractText(msg);
      const images = extractImages(msg);
      const rawEntryId = (msg as { entryId?: unknown }).entryId;
      const entryId = typeof rawEntryId === 'string' && rawEntryId.trim() ? rawEntryId : undefined;
      if (text.trim() || images.length)
        out.push({
          kind: 'user',
          id: nextId(),
          text,
          images: images.length ? images : undefined,
          timestamp: messageTimestamp(msg),
          entryId,
        });
      continue;
    }
    if (msg.role === 'assistant') {
      registerToolCalls(pendingToolCalls, msg);
      trailingCalls = new Map();
      registerToolCalls(trailingCalls, msg);
      const { text, thinking } = extractText(msg);
      if (text.trim() || thinking.trim()) {
        const timestamp = messageTimestamp(msg);
        out.push({
          kind: 'assistant',
          id: nextId(),
          text,
          thinking,
          streaming: false,
          timestamp,
          thinkingDuration: thinking.trim() ? getDuration?.(timestamp) : undefined,
        });
      }
      continue;
    }
    if (msg.role === 'toolResult') {
      const raw = msg as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : nextId();
      const pending = pendingToolCalls.get(toolCallId);
      const toolName =
        typeof raw.toolName === 'string' ? raw.toolName : pending?.toolName ?? 'unknown';
      out.push({
        kind: 'tool',
        id: nextId(),
        toolCallId,
        toolName,
        args: pending?.args ?? {},
        result: toolResultPayload(msg),
        status: raw.isError === true ? 'error' : 'done',
      });
      pendingToolCalls.delete(toolCallId);
      trailingCalls.delete(toolCallId);
    }
  }
  // 工具正在跑时切进会话 / 重载：结果还没落盘，只靠 toolResult 建卡会让这张卡一直缺席，
  // 之后的 tool_execution_update 也找不到卡。补成 running；调用方确认回合已结束时用
  // interruptPendingToolCards 收成已中断。ask_user 由下面单独补。
  for (const [toolCallId, call] of trailingCalls) {
    if (call.toolName === 'ask_user') continue;
    out.push({
      kind: 'tool',
      id: nextId(),
      toolCallId,
      toolName: call.toolName,
      args: call.args,
      result: undefined,
      status: 'running',
      argsComplete: true,
    });
  }
  const pending = findPendingAskUser(msgs);
  if (pending && !out.some((m) => m.kind === 'tool' && m.toolCallId === pending.toolCallId)) {
    out.push({
      kind: 'tool',
      id: nextId(),
      toolCallId: pending.toolCallId,
      toolName: 'ask_user',
      args: pending.args,
      result: undefined,
      status: 'running',
    });
  }
  return out;
}

/**
 * 快照补出来的 running 卡（结果还没落盘的调用）在回合已经不跑时收成「已中断」，
 * 应用重启留下的调用不能一直转圈。之后真有结果到，按 interrupted 的语义换成真实结果。
 * ask_user 的等待行有自己的恢复流程，不动。
 */
export function interruptPendingToolCards(messages: ChatMessage[]): ChatMessage[] {
  let touched = false;
  const next = messages.map((m) => {
    if (m.kind !== 'tool' || m.status !== 'running' || m.result !== undefined || m.toolName === 'ask_user') return m;
    touched = true;
    return {
      ...m,
      status: 'error' as const,
      argsComplete: true,
      interrupted: true,
      result: { content: [{ type: 'text', text: '已中断' }] },
    };
  });
  return touched ? next : messages;
}

/**
 * 从 pi get_messages 结果重建「上下文排除集」：扫描 context_exclusion 自定义条目按序回放 add/remove。
 * 排除集由 compaction-policy 扩展持久化在会话树（appendEntry），切换/重载会话后据此恢复灰显。
 * 条目结构按运行时为准做防御解析（data 优先、回退条目本身），取不到则忽略（fail-soft）：
 * 最坏情况只是灰显缺失，不影响扩展在模型侧的真实排除。
 */
export function excludedFromAgent(msgs: AgentMessage[]): Set<number> {
  const set = new Set<number>();
  for (const msg of msgs) {
    const m = msg as { customType?: unknown; data?: unknown };
    if (m.customType !== 'context_exclusion') continue;
    const raw = (m.data && typeof m.data === 'object' ? m.data : msg) as { op?: unknown; ts?: unknown };
    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : null;
    if (ts == null) continue;
    if (raw.op === 'remove') set.delete(ts);
    else set.add(ts);
  }
  return set;
}

/**
 * 把子代理 `--mode json` 的 JSONL 输出（每行一个 AgentEvent，首行可能是 session header）
 * 还原成聊天消息列表 —— 复用主对话同一套 reducer，因此子代理对话能用相同气泡组件渲染。
 * id 重写为基于下标的稳定值，避免每次重解析改变 id 导致 React 重挂载。
 */
export function messagesFromTranscript(transcript: string): ChatMessage[] {
  let state = initialAgentState();
  for (const line of transcript.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(trimmed) as AgentEvent;
    } catch {
      continue;
    }
    if (typeof (event as { type?: unknown }).type !== 'string') continue;
    state = applyEvent(state, event);
  }
  return state.messages.map((m, i) => ({ ...m, id: `sa-${i}` }));
}

/** 最后一条助手已经是这份思考和正文，且后面没有新的用户消息。 */
function matchingFinishedAssistant(messages: ChatMessage[], text: string, thinking: string): number {
  if (!text && !thinking) return -1;
  const idx = lastIndex(messages, (m) => m.kind === 'assistant');
  if (idx < 0) return -1;
  if (messages.slice(idx + 1).some((m) => m.kind === 'user')) return -1;
  const cur = messages[idx];
  if (cur?.kind !== 'assistant' || cur.streaming) return -1;
  if (cur.text !== text || cur.thinking !== thinking) return -1;
  return idx;
}

function lastIndex(arr: ChatMessage[], pred: (m: ChatMessage) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function updateTool(
  state: AgentState,
  toolCallId: string,
  fn: (t: Extract<ChatMessage, { kind: 'tool' }>) => Extract<ChatMessage, { kind: 'tool' }>,
): AgentState {
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === 'tool' && m.toolCallId === toolCallId ? fn(m) : m,
    ),
  };
}
