import type { AgentMessage } from '../lib/pi';
import type { ChatMessage } from './agentReducer';

/**
 * 按 entryId 裁掉截断点之后的界面消息。
 * 找不到目标用户消息时返回 null（调用方必须 fail-closed，禁止把未裁短的列表写回 ui-history）。
 */
export function cutMessagesAfterEntry(
  messages: ChatMessage[],
  entryId: string,
  mode: 'drop-target' | 'keep-target',
): ChatMessage[] | null {
  const idx = messages.findIndex((m) => m.kind === 'user' && m.entryId === entryId);
  if (idx < 0) return null;
  return mode === 'drop-target' ? messages.slice(0, idx) : messages.slice(0, idx + 1);
}

/**
 * 回合结束后按顺序把后端用户消息的 entryId（及缺失的 timestamp）补到本地列表。
 * 不重排、不增删消息；已有字段保留。
 */
export function backfillEntryIds(local: ChatMessage[], backend: AgentMessage[]): ChatMessage[] {
  const backendUsers: Array<{ entryId: string; timestamp?: number }> = [];
  for (const msg of backend) {
    if (msg.role !== 'user') continue;
    const rawId = msg.entryId;
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const ts = msg.timestamp;
    backendUsers.push({
      entryId: rawId,
      timestamp: typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined,
    });
  }

  let i = 0;
  let changed = false;
  const next = local.map((m) => {
    if (m.kind !== 'user') return m;
    const src = backendUsers[i++];
    if (!src) return m;
    const entryId = m.entryId ?? src.entryId;
    const timestamp = m.timestamp ?? src.timestamp;
    if (entryId === m.entryId && timestamp === m.timestamp) return m;
    changed = true;
    return { ...m, entryId, ...(timestamp != null ? { timestamp } : {}) };
  });
  return changed ? next : local;
}
