import type { ChatMessage } from '../stores/agentReducer';

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

/** 计算会话内容的轻量签名（消息数 + 末条消息要点），用于「内容是否变化」的快速判断。 */
export function sessionSignature(messages: ChatMessage[]): string {
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

export function getCachedSession(sessionPath: string): CacheEntry | undefined {
  const entry = cache.get(sessionPath);
  if (entry) {
    // LRU touch：命中后挪到末尾，最久未用的留在头部待淘汰。
    cache.delete(sessionPath);
    cache.set(sessionPath, entry);
  }
  return entry;
}

export function setCachedSession(sessionPath: string, messages: ChatMessage[], sig: string): void {
  cache.delete(sessionPath);
  cache.set(sessionPath, { messages, sig });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 删除某会话后清掉其消息缓存，避免 showCachedSession 仍命中已删会话内容（缓存卡死）。 */
export function invalidateCachedSession(sessionPath: string): void {
  cache.delete(sessionPath);
}
