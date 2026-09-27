import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { toJsonEvent } from '../../../cli/src/json-event.js';

type Rec = Record<string, unknown>;

/**
 * toJsonEvent 之后，给 toolcall_delta 补上当时 partial 快照里的 id / toolName（非空才补）。
 * openai-completions 等提供商在 toolcall_start 时 id / name 可能为空、之后才补全。
 * 只加字段、不加快照，IPC 体积仍是 O(delta)。
 */
export function toRendererEvent(event: AgentSessionEvent): Rec {
  const out = toJsonEvent(event) as unknown as Rec;
  if (out.type !== 'message_update') return out;
  const raw = (event as unknown as Rec).assistantMessageEvent as Rec | undefined;
  const ame = out.assistantMessageEvent as Rec | undefined;
  if (!raw || !ame || ame.type !== 'toolcall_delta') return out;
  const partial = raw.partial as { content?: Rec[] } | undefined;
  const block = partial?.content?.[raw.contentIndex as number];
  if (block?.type !== 'toolCall') return out;
  const id = typeof block.id === 'string' && block.id ? block.id : undefined;
  const toolName = typeof block.name === 'string' && block.name ? block.name : undefined;
  if (!id && !toolName) return out;
  return { ...out, assistantMessageEvent: { ...ame, ...(id ? { id } : {}), ...(toolName ? { toolName } : {}) } };
}
