import type { PendingAskUser } from '../features/chat/pendingAskUser';
import type { ChatMessage } from './agentReducer';

/**
 * 载入会话后：只保留「当前未完成 ask_user」为 running，并把缺失的 waiting 行补回显示列表。
 * pending 来自 findPendingAskUser(原始会话消息)。
 */
export function applyPendingAskUserOnLoad(
  messages: ChatMessage[],
  pending: PendingAskUser | null,
): ChatMessage[] {
  let sawPending = false;

  const out = messages.map((m) => {
    if (m.kind !== 'tool') return m;

    if (pending && m.toolCallId === pending.toolCallId) {
      sawPending = true;
      return {
        ...m,
        toolName: 'ask_user',
        args: pending.args,
        result: undefined,
        status: 'running' as const,
      };
    }

    if (m.status === 'running') {
      // 结果还没落盘的调用（messagesFromAgent 给末尾在跑的调用补的卡）留给调用方：
      // 还在跑就保持 running，确认不跑了再 interruptPendingToolCards。在这里改成 error，
      // 正在执行的命令会显示成失败、无输出，直到结果回来才变绿。
      if (m.toolName !== 'ask_user' && m.result === undefined) return m;
      return { ...m, status: 'error' as const };
    }
    return m;
  });

  if (pending && !sawPending) {
    out.push({
      kind: 'tool',
      id: `pending-ask-${pending.toolCallId}`,
      toolCallId: pending.toolCallId,
      toolName: 'ask_user',
      args: pending.args,
      result: undefined,
      status: 'running',
    });
  }

  return out;
}
