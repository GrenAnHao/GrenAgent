import type { ChatMessage, SteerState, UserImage } from '../../stores/agentReducer';

export type ToolSegment = {
  kind: 'tool';
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
  argsComplete?: boolean;
  /** 开始执行的时刻；运行中据此实时计时。 */
  startedAt?: number;
  /** 执行耗时（ms），结束后定格。 */
  durationMs?: number;
  /** 嵌套调用的父工具 id。有值且父段存在时，buildTurnRows 把它从顶层摘到父段 children。 */
  parentToolCallId?: string;
  /** 挂在本段输出下面的嵌套工具，由 buildTurnRows 按出现顺序填入。 */
  children?: ToolSegment[];
};

export type ThinkingSegment = {
  kind: 'thinking';
  id: string;
  content: string;
  streaming: boolean;
  /** 推理耗时（ms），结束后用于展示「已深度思考 · X 秒」；流式中通常为 undefined。 */
  durationMs?: number;
  /** 首个 thinking 出现的时刻。流式中用来显示「正在深度思考 · 时间」。 */
  startedAt?: number;
};

export type TextSegment = {
  kind: 'text';
  id: string;
  content: string;
  streaming: boolean;
};

export type TimelineSegment = ThinkingSegment | TextSegment | ToolSegment;

export type DisplayMessage =
  | { kind: 'user'; id: string; text: string; images?: UserImage[]; steering?: boolean; steerState?: SteerState; timestamp?: number; entryId?: string; promptFrame?: boolean }
  | { kind: 'turn'; id: string; segments: TimelineSegment[]; timestamp?: number }
  | { kind: 'tool'; id: string; toolCallId: string; toolName: string; args: unknown; result: unknown; status: 'running' | 'done' | 'error'; argsComplete?: boolean; startedAt?: number; durationMs?: number }
  | { kind: 'notice'; id: string; customType: string; content: string }
  | { kind: 'compaction'; id: string }
  | { kind: 'command-input'; id: string; command: string; rest: string; beforeCount: number };

export type CommandInputMessage = Extract<DisplayMessage, { kind: 'command-input' }>;

/**
 * Flatten ChatMessage[] → DisplayMessage[].
 * 同一轮 assistant + tool 按真实发生顺序展开为 turn.segments（对齐 MiMo SessionTurn / AssistantParts）：
 * reasoning → tool → reasoning → tool → text，每段独立、稳定 id，流式只更新当前段。
 * 例外：todo 工具在同一 turn 内只保留最新一张快照（去重），避免连续进度更新堆叠刷屏。
 */
export function groupMessages(messages: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let pending: { id: string; segments: TimelineSegment[]; timestamp?: number } | null = null;

  const flush = () => {
    if (pending && pending.segments.length > 0) {
      out.push({ kind: 'turn', id: pending.id, segments: pending.segments, timestamp: pending.timestamp });
    }
    pending = null;
  };

  const ensureTurn = (id: string) => {
    if (!pending) pending = { id, segments: [] };
  };

  for (const msg of messages) {
    switch (msg.kind) {
      case 'assistant': {
        ensureTurn(msg.id);
        // 整轮的回退/排除 key 取该轮首条 assistant 消息的 timestamp。
        if (pending!.timestamp == null && msg.timestamp != null) {
          pending!.timestamp = msg.timestamp;
        }
        const thinking = msg.thinking.trim();
        const text = msg.text.trim();
        if (thinking) {
          pending!.segments.push({
            kind: 'thinking',
            id: `${msg.id}-thinking`,
            content: msg.thinking,
            // 本条 assistant 仍在流式且尚未产出正文 → 推理段活跃。
            streaming: msg.streaming && !text,
            durationMs: msg.thinkingDuration,
            startedAt: msg.thinkingStartedAt,
          });
        }
        if (text) {
          pending!.segments.push({
            kind: 'text',
            id: `${msg.id}-text`,
            content: msg.text,
            streaming: msg.streaming,
          });
        }
        break;
      }
      case 'tool':
        if (msg.toolName === 'spawn_agent') {
          flush();
          out.push(msg);
        } else {
          ensureTurn(msg.id);
          const isTodo = msg.toolName.toLowerCase() === 'todo';
          if (isTodo) {
            // 模型连续推进会反复调用 todo（如 8/10 → 9/10 → 10/10），逐个保留会让卡片在
            // 对话流里堆叠刷屏。这里移除本 turn 已有的 todo segment，下面再用与 turn 绑定的
            // 稳定 id 把最新快照挂到「当前位置」——React 复用同一节点原地刷新内容并平滑移到
            // 最新位置，而非新增一张。
            const segs = pending!.segments;
            const prev = segs.findIndex(
              (s) => s.kind === 'tool' && s.toolName.toLowerCase() === 'todo',
            );
            if (prev !== -1) segs.splice(prev, 1);
          }
          pending!.segments.push({
            kind: 'tool',
            id: isTodo ? `${pending!.id}-todo` : msg.id,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            args: msg.args,
            result: msg.result,
            status: msg.status,
            argsComplete: msg.argsComplete,
            startedAt: msg.startedAt,
            durationMs: msg.durationMs,
            ...(msg.parentToolCallId ? { parentToolCallId: msg.parentToolCallId } : {}),
          });
        }
        break;
      default:
        flush();
        out.push(msg);
    }
  }
  flush();
  return out;
}

/**
 * 把本地执行性命令行（/compact 等；/goal 不留行，只出 Goal 条）按发送时的会话位置插回列表。
 * DSH 用 command/run.seq 做 anchor，续跑消息排在后面；我们没有这条事件，用发送当下的 grouped 长度。
 */
export function mergeCommandInputs(
  grouped: DisplayMessage[],
  commands: CommandInputMessage[],
): DisplayMessage[] {
  if (commands.length === 0) return grouped;
  const next = [...grouped];
  const ordered = [...commands].sort((a, b) => a.beforeCount - b.beforeCount);
  let inserted = 0;
  for (const command of ordered) {
    const index = Math.min(Math.max(0, command.beforeCount) + inserted, next.length);
    next.splice(index, 0, command);
    inserted += 1;
  }
  return next;
}
