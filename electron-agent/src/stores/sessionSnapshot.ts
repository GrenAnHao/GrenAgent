import type { AgentMessage } from '../lib/pi';
import { getThinkingDuration } from '../lib/thinkingDurations';
import { expandSystemWorkerChat } from '../lib/systemWorkerChat';
import { findPendingAskUser } from '../features/chat/pendingAskUser';
import { messagesFromAgent, type ChatMessage } from './agentReducer';
import { applyPendingAskUserOnLoad } from './pendingAskUserLoad';

/**
 * 后端快照 → 界面消息。UI 完整历史更长时用它（压缩后后端历史会变短），并补回未完成的 ask_user 行。
 *
 * 主代理载入会话和子代理详情读 JSONL 种子都走这一条，历史怎么变成界面消息只有一种答案。
 */
export function snapshotMessages(msgs: AgentMessage[], uiHistory?: ChatMessage[]) {
  const backend = messagesFromAgent(msgs, getThinkingDuration);
  const processed = expandSystemWorkerChat(uiHistory && uiHistory.length > backend.length ? uiHistory : backend);
  return {
    backend,
    processed,
    sanitized: applyPendingAskUserOnLoad(processed, findPendingAskUser(msgs)),
    pendingCallIds: pendingCallIdsOf(backend),
  };
}

/**
 * 后端快照里还在等结果的调用（messagesFromAgent 只给最后一条助手消息补 running 卡）。
 * 回合在跑时只有它们还可能等到结果；UI 历史里别的 running 卡是进程被杀时留下的。
 */
function pendingCallIdsOf(backend: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of backend) {
    if (m.kind === 'tool' && m.status === 'running' && m.result === undefined) ids.add(m.toolCallId);
  }
  return ids;
}
