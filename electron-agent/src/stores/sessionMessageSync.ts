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

type Assistant = Extract<ChatMessage, { kind: 'assistant' }>;
type Tool = Extract<ChatMessage, { kind: 'tool' }>;

/**
 * 把只靠实时事件攒出来的尾巴接到后端快照后面。
 * 快照里已有的条目原位更新（助手按 pi timestamp、工具按 toolCallId 对上），
 * 还没落盘的（流式中的助手、跑着的工具）按尾巴顺序追加。尾巴比快照新，重叠时以尾巴为准。
 */
export function mergeLiveTail(base: ChatMessage[], tail: ChatMessage[]): ChatMessage[] {
  if (tail.length === 0) return base;
  if (base.length === 0) return tail;
  const out = [...base];
  const assistantAt = new Map<number, number>();
  const toolAt = new Map<string, number>();
  out.forEach((m, i) => {
    if (m.kind === 'assistant' && m.timestamp != null) assistantAt.set(m.timestamp, i);
    else if (m.kind === 'tool') toolAt.set(m.toolCallId, i);
  });
  for (const m of tail) {
    if (m.kind === 'assistant') {
      const at = m.timestamp != null ? assistantAt.get(m.timestamp) : undefined;
      if (at == null) {
        out.push(m);
        continue;
      }
      const cur = out[at] as Assistant;
      const longer = m.text.length + m.thinking.length >= cur.text.length + cur.thinking.length;
      if (m.streaming || longer) out[at] = { ...cur, ...m, id: cur.id };
      continue;
    }
    if (m.kind === 'tool') {
      const at = toolAt.get(m.toolCallId);
      if (at == null) {
        out.push(m);
        continue;
      }
      const cur = out[at] as Tool;
      out[at] = { ...cur, ...m, id: cur.id, args: m.args ?? cur.args, result: m.result ?? cur.result };
      continue;
    }
    if (m.kind === 'user') {
      const seen = out.some(
        (x) => x.kind === 'user' && ((m.timestamp != null && x.timestamp === m.timestamp) || x.text === m.text),
      );
      if (!seen) out.push(m);
      continue;
    }
    if (m.kind === 'notice') {
      const seen = out.some((x) => x.kind === 'notice' && x.customType === m.customType && x.content === m.content);
      if (!seen) out.push(m);
      continue;
    }
    if (out[out.length - 1]?.kind !== 'compaction') out.push(m);
  }
  return out;
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
