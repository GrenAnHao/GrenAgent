import { normalizeTodos } from '@extensions/_shared/todo-model';
import type { ChatMessage } from '../stores/agentReducer';
import { pathsEquivalent } from './pathUtils';

/**
 * 模块级「按会话路径」消息缓存。
 *
 * 为什么放在模块级而非各 agent store 内：store 由 agentStoreRegistry 按 LRU（上限 8）常驻，
 * 超限会被销毁；而用户经常在更多会话间来回切。把缓存放在 store 外、按 sessionPath 存活，
 * 切回「看过但其 store 已被驱逐」的会话时仍能先秒显缓存内容，后端再在后台对齐刷新，
 * 避免每次切换都干等 openWorkspace/switchSession/getMessages 的几秒后端往返。
 */
interface CacheEntry {
  messages: ChatMessage[];
  /** 轻量内容签名：后台刷新拿到 get_messages 后比对，未变则跳过重渲染（避免新 id 数组导致整列闪一下）。 */
  sig: string;
}

const cache = new Map<string, CacheEntry>();
/** 缓存会话数上限：大会话的 ChatMessage[] 占内存，按 LRU 控制总量。 */
const MAX_ENTRIES = 30;

/** 末条摘要保持既有规则，另加入最新成功 todo 的内容，避免同长度快照漏刷新。 */
export function sessionSignature(messages: ChatMessage[]): string {
  const tail = tailSignature(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'tool' || message.toolName.toLowerCase() !== 'todo' || message.status !== 'done') continue;
    const details = (message.result as { details?: { error?: unknown } } | null)?.details;
    if (details?.error != null) continue;
    const todo = normalizeTodos(details);
    if (todo) return `${tail}:todo:${message.toolCallId}:${JSON.stringify(todo)}`;
  }
  return tail;
}

function tailSignature(messages: ChatMessage[]): string {
  const n = messages.length;
  const last = messages[n - 1];
  if (!last) return '0';
  switch (last.kind) {
    case 'user':
      return `${n}:u:${last.text.length}`;
    case 'assistant':
      return `${n}:a:${last.text.length}:${last.thinking.length}:${last.streaming ? 1 : 0}`;
    case 'tool':
      return `${n}:t:${last.status}`;
    case 'notice':
      return `${n}:x:${last.content.length}`;
    default:
      return String(n);
  }
}

/**
 * 同一份会话的路径在事件、侧栏、getState 里可能大小写 / 分隔符不同。
 * 精确键没命中时按等价路径再找一遍，最多 MAX_ENTRIES 条，开销可以忽略。
 */
function keyOf(sessionPath: string): string | undefined {
  if (cache.has(sessionPath)) return sessionPath;
  for (const key of cache.keys()) if (pathsEquivalent(key, sessionPath)) return key;
  return undefined;
}

export function getCachedSession(sessionPath: string): CacheEntry | undefined {
  const key = keyOf(sessionPath);
  if (key === undefined) return undefined;
  const entry = cache.get(key)!;
  // LRU touch：命中后挪到末尾，最久未用的留在头部待淘汰。
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function setCachedSession(sessionPath: string, messages: ChatMessage[], sig: string): void {
  const existing = keyOf(sessionPath);
  if (existing !== undefined) cache.delete(existing);
  cache.set(sessionPath, { messages, sig });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 删除某会话后清掉其消息缓存，避免 showCachedSession 仍命中已删会话内容（缓存卡死）。 */
export function invalidateCachedSession(sessionPath: string): void {
  const key = keyOf(sessionPath);
  if (key !== undefined) cache.delete(key);
}
