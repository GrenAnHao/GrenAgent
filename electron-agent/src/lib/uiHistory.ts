import type { ChatMessage } from '../stores/agentReducer';
import { pi } from './pi';

/**
 * 从 pi 会话文件路径派生 UI 历史文件的稳定 key（basename 去扩展名）。
 * 与后端 `<workspace>/.pi/ui-history/<key>.jsonl` 对应；空/无路径返回 null。
 */
export function sessionKeyFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '').trim();
  return stem || null;
}

/** 把前端完整消息列表序列化成 jsonl（每行一条 ChatMessage）。 */
export function serializeHistory(messages: ChatMessage[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n');
}

/**
 * 从 jsonl 还原消息列表；逐行 parse，坏行跳过（fail-soft）。
 * id 重新分配（`h-<n>`）：存盘的旧 id 与运行时 nextId 数字 id 可能撞号，重排规避（对齐 messagesFromTranscript）。
 */
export function deserializeHistory(jsonl: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const m = JSON.parse(s) as ChatMessage;
      out.push({ ...m, id: `h-${i}` } as ChatMessage);
      i += 1;
    } catch {
      // 坏行跳过：最坏情况少一条历史，不影响其余渲染。
    }
  }
  return out;
}

/** 从磁盘读某会话的 UI 完整历史；无文件/空/失败返回 undefined（调用方走后端 getMessages）。 */
export async function readUiHistoryForSession(
  workspace: string,
  sessionPath: string | null | undefined,
): Promise<ChatMessage[] | undefined> {
  const key = sessionKeyFromPath(sessionPath);
  if (!key) return undefined;
  try {
    const raw = await pi.readUiHistory(workspace, key);
    if (!raw.trim()) return undefined;
    const msgs = deserializeHistory(raw);
    return msgs.length > 0 ? msgs : undefined;
  } catch {
    return undefined;
  }
}
