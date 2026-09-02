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
  agent_end: 'turn.completed',
  extension_error: 'turn.failed',
};

export function adaptPiEvent(raw: Record<string, unknown>, context: PiEventContext = {}): AppEventInput | undefined {
  const rawType = typeof raw.type === 'string' ? raw.type : undefined;
  if (!rawType) return undefined;
  const type = eventTypeMap[rawType];
  if (!type) return undefined;

  const message = isRecord(raw.message) ? raw.message : undefined;
  const itemId =
    (typeof raw.toolCallId === 'string' && raw.toolCallId) ||
    (message && typeof message.id === 'string' && message.id) ||
    undefined;
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const id = typeof raw.id === 'string' ? raw.id : `${rawType}:${itemId ?? timestamp}`;

  return {
    id,
    type,
    timestamp,
    ...context,
    ...(itemId ? { itemId } : {}),
    data: raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
