import type { ManagedMemoryRecord, MemoryConversationDetail } from '../../lib/agentData';
import type { SessionInfo } from '../../lib/pi';

export const memoryRecord: ManagedMemoryRecord = {
  id: 'memory-1', level: 1, content: '喜欢简洁的中文回答', scope: 'global',
  source: 'session:session-1', sourceSessionId: 'session-1', sourceWorkspace: 'D:/proj/alpha',
  createdAt: 1, updatedAt: 2, revision: 1, origin: 'automatic', contentHash: 'hash-1',
};
export const conversationRecord: MemoryConversationDetail = {
  id: 'capture-1', source: 'session:session-1', sourceSessionId: 'session-1',
  workspace: 'D:/proj/alpha', sourceProjectId: 'D:/proj/alpha',
  snippet: '对话命中片段', transcript: '完整对话正文\n用户：请整理我的偏好', updatedAt: 2,
};
export const sourceSession: SessionInfo = {
  id: 'session-1', cwd: 'D:/proj/alpha', path: 'D:/sessions/existing.jsonl',
  timestamp: '2026-09-05T00:00:00Z', name: '已有来源会话',
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
