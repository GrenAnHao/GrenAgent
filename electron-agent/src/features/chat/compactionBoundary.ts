import type { ChatMessage } from '../../stores/agentReducer';

function sameUser(message: ChatMessage, entryId: string | undefined, timestamp: number | undefined): boolean {
  if (message.kind !== 'user') return false;
  if (entryId && message.entryId) return message.entryId === entryId;
  if (timestamp != null && message.timestamp != null) return message.timestamp === timestamp;
  return false;
}

/** 这条用户消息出现在最近一次「已压缩」分隔之前，不能再回退或编辑。 */
export function isBeforeLatestCompaction(
  messages: readonly ChatMessage[],
  entryId: string | undefined,
  timestamp: number | undefined,
): boolean {
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'compaction') {
      cut = i;
      break;
    }
  }
  if (cut < 0) return false;
  for (let i = 0; i < cut; i++) {
    const message = messages[i];
    if (message && sameUser(message, entryId, timestamp)) return true;
  }
  return false;
}
