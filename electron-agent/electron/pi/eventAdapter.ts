/** 投影器实际会产出的语义类型（pi 原始事件 → turn/item 生命周期）。 */
export type PiProjectionType =
  | 'turn.started' | 'turn.completed' | 'turn.failed' | 'turn.cancelled'
  | 'item.created' | 'item.delta' | 'item.updated';

/**
 * pi 原始事件的内部归一形状，仅供 PiRuntimeService 的 threads/turns/items 持久化分支使用。
 * 不含 id / sequence：这份投影不再对外广播、也不再落 app_events 表（AppEvent 系统已移除），
 * 因此不需要事件标识。此前为了填 app_events.id 用模块级自增计数器拼 id，主进程重启后归零，
 * 导致跨重启主键冲突刷屏 "UNIQUE constraint failed: app_events.id"。
 */
export interface PiProjection {
  type: PiProjectionType;
  timestamp: number;
  projectId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  data: unknown;
}

export interface SessionEventMeta {
  sessionId?: string;
  sessionPath?: string;
  source?: 'interactive' | 'goal' | 'subagent';
  key?: string;
  logicalWorkspace?: string;
}

export interface PiEventContext {
  projectId?: string;
  threadId?: string;
  turnId?: string;
}

const eventTypeMap: Record<string, PiProjectionType> = {
  agent_start: 'turn.started',
  message_start: 'item.created',
  message_update: 'item.delta',
  message_end: 'item.updated',
  tool_execution_start: 'item.created',
  tool_execution_update: 'item.delta',
  tool_execution_end: 'item.updated',
};

export function adaptPiEvent(raw: Record<string, unknown>, context: PiEventContext = {}): PiProjection | undefined {
  const rawType = typeof raw.type === 'string' ? raw.type : undefined;
  if (!rawType) return undefined;
  if (rawType === 'agent_end' && raw.willRetry === true) return undefined;
  const message = isRecord(raw.message) ? raw.message : undefined;
  if (isMessageLifecycleEvent(rawType) && message?.role !== 'assistant') return undefined;
  const type = rawType === 'agent_end' ? agentEndType(raw) : eventTypeMap[rawType];
  if (!type) return undefined;

  const itemId =
    (typeof raw.toolCallId === 'string' && raw.toolCallId) ||
    (message && typeof message.id === 'string' && message.id) ||
    undefined;
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();

  return {
    type,
    timestamp,
    ...context,
    ...(itemId ? { itemId } : {}),
    data: projectData(rawType, raw, message),
  };
}

function agentEndType(raw: Record<string, unknown>): PiProjectionType {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const lastAssistant = [...messages].reverse().find((message) => isRecord(message) && message.role === 'assistant');
  if (lastAssistant?.stopReason === 'aborted') return 'turn.cancelled';
  if (lastAssistant?.stopReason === 'error') return 'turn.failed';
  if (lastAssistant && typeof lastAssistant.errorMessage === 'string' && lastAssistant.errorMessage.length > 0) {
    return 'turn.failed';
  }
  return 'turn.completed';
}

function projectData(rawType: string, raw: Record<string, unknown>, message: Record<string, unknown> | undefined): unknown {
  switch (rawType) {
    case 'message_start':
    case 'message_end':
      return { message: projectMessage(message, true) };
    case 'message_update':
      return {
        message: projectMessage(message),
        assistantMessageEvent: projectAssistantMessageEvent(raw.assistantMessageEvent),
      };
    case 'tool_execution_start':
      return pick(raw, ['toolCallId', 'toolName', 'args']);
    case 'tool_execution_update':
      return pick(raw, ['toolCallId', 'toolName', 'partialResult']);
    case 'tool_execution_end':
      return pick(raw, ['toolCallId', 'toolName', 'result', 'isError']);
    case 'agent_end': {
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      const lastAssistant = [...messages].reverse().find((entry) => isRecord(entry) && entry.role === 'assistant');
      return pick(lastAssistant, ['stopReason', 'errorMessage']);
    }
    default:
      return {};
  }
}

function projectMessage(message: Record<string, unknown> | undefined, includeContent = false): Record<string, unknown> {
  return pick(message, includeContent ? ['id', 'role', 'content', 'timestamp', 'errorMessage'] : ['id', 'role']);
}

function projectAssistantMessageEvent(value: unknown): Record<string, unknown> {
  return pick(isRecord(value) ? value : undefined, ['type', 'delta']);
}

function pick(value: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function isMessageLifecycleEvent(type: string): boolean {
  return type === 'message_start' || type === 'message_update' || type === 'message_end';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
