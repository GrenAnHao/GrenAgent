import type { ChatMessage } from '../stores/agentReducer';

/** SystemWorkerManager.serviceTaskPrompt 的固定骨架：指令 + Task kind + Input JSON。 */
const TASK_INPUT_RE = /\nTask kind: [a-z][a-z0-9_]*\nInput: /;

export function isSystemWorkerPrompt(text: string): boolean {
  return TASK_INPUT_RE.test(text);
}

export function parseSystemWorkerInput(text: string): unknown | undefined {
  const match = TASK_INPUT_RE.exec(text);
  if (!match) return undefined;
  const raw = text.slice(match.index + match[0].length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export interface MemoryTranscriptPart {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
}

/**
 * 记忆提取等短调用会把原对话打成 `user: …\nassistant: …\ntoolResult: …`。
 * 行首 `role:` 才是分段，正文里的同名前缀不算。
 */
export function parseMemoryTranscript(delta: string): MemoryTranscriptPart[] {
  const matches = [...delta.matchAll(/^(user|assistant|toolResult): /gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? delta.length) : delta.length;
    return {
      role: match[1] as MemoryTranscriptPart['role'],
      text: delta.slice(start, end).replace(/\n+$/, ''),
    };
  });
}

export function chatFromMemoryTranscript(delta: string): ChatMessage[] {
  return parseMemoryTranscript(delta).map((part, index) => {
    const id = `sw-${index}`;
    if (part.role === 'user') return { kind: 'user' as const, id, text: part.text };
    if (part.role === 'assistant') {
      return { kind: 'assistant' as const, id, text: part.text, thinking: '', streaming: false };
    }
    return {
      kind: 'tool' as const,
      id,
      toolCallId: id,
      toolName: 'toolResult',
      args: {},
      result: { content: [{ type: 'text', text: part.text }] },
      status: 'done' as const,
    };
  });
}

/** 打开旧的 memory_extract 短调用会话时，还原被压进 Input.delta 的原对话。 */
export function expandSystemWorkerChat(messages: ChatMessage[]): ChatMessage[] {
  const first = messages.find((message) => message.kind === 'user');
  if (!first || first.kind !== 'user' || !isSystemWorkerPrompt(first.text)) return messages;
  const input = parseSystemWorkerInput(first.text);
  if (!input || typeof input !== 'object') return messages;
  const delta = (input as { delta?: unknown }).delta;
  if (typeof delta !== 'string' || !delta.trim()) return messages;
  const expanded = chatFromMemoryTranscript(delta);
  return expanded.length > 0 ? expanded : messages;
}
