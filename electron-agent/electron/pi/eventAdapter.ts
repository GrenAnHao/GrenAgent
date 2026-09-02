import type { AppEvent, AppEventType } from '../app/appServer/types';

export type AppEventInput = Omit<AppEvent, 'sequence'>;

export interface PiEventContext {
  projectId?: string;
  threadId?: string;
  turnId?: string;
}

const eventTypeMap: Record<string, AppEventType> = {
  agent_start: 'turn.started',
  message_start: 'item.created',
  message_update: 'item.delta',
  message_end: 'item.updated',
  tool_execution_start: 'item.created',
  tool_execution_update: 'item.delta',
  tool_execution_end: 'item.updated',
  extension_error: 'turn.failed',
  queue_update: 'task.queued',
};

let fallbackEventId = 0;

export function adaptPiEvent(raw: Record<string, unknown>, context: PiEventContext = {}): AppEventInput | undefined {
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
  const id = typeof raw.id === 'string' ? raw.id : `${rawType}:${++fallbackEventId}`;

  return {
    id,
    type,
    timestamp,
    ...context,
    ...(itemId ? { itemId } : {}),
    data: projectData(rawType, raw, message),
  };
}

function agentEndType(raw: Record<string, unknown>): AppEventType {
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
      return { message: projectMessage(message) };
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
    case 'extension_error':
      return pick(raw, ['error']);
    case 'queue_update':
      return pick(raw, ['steering', 'followUp']);
    default:
      return {};
  }
}

function projectMessage(message: Record<string, unknown> | undefined): Record<string, unknown> {
  return pick(message, ['id', 'role']);
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
