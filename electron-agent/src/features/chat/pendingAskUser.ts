export interface PendingAskUser {
  toolCallId: string;
  args: Record<string, unknown>;
}

type LooseMessage = { role?: unknown; content?: unknown; toolCallId?: unknown };

function askUserCallsOf(msg: LooseMessage): PendingAskUser[] {
  if (!Array.isArray(msg.content)) return [];
  const calls: PendingAskUser[] = [];
  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (!block || block.type !== 'toolCall') continue;
    const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
    const id = typeof block.id === 'string' ? block.id : '';
    if (name !== 'ask_user' || !id) continue;
    const raw = block.arguments ?? block.input ?? {};
    calls.push({ toolCallId: id, args: raw && typeof raw === 'object' ? raw as Record<string, unknown> : {} });
  }
  return calls;
}

/**
 * 待答的提问卡：只有**最后一个 assistant 回合**里没拿到结果的 ask_user 调用才算。
 *
 * 从尾往前扫：toolResult 记作已答，遇到的第一条 assistant 就是归属回合（它之后再没有新回合），
 * 先遇到 user 消息说明这一轮早就过去了，判无。收窄的原因见
 * .agents/notes/implemented/bug-fix/2026-10-17-ask-user-completion-orphan-tool-result.md：
 * 中断回合里的调用补答案时走的是 user 消息，不再写 toolResult，没有这条规则那张卡会在下次载入时复活。
 */
export function findPendingAskUser(messages: Array<LooseMessage>): PendingAskUser | null {
  const answered = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'toolResult') {
      if (typeof msg.toolCallId === 'string') answered.add(msg.toolCallId);
      continue;
    }
    if (msg.role === 'user') return null;
    if (msg.role !== 'assistant') continue;
    let last: PendingAskUser | null = null;
    for (const call of askUserCallsOf(msg)) {
      if (answered.has(call.toolCallId)) continue;
      last = call;
    }
    return last;
  }
  return null;
}

/** 这次 ask_user 调用所属的 assistant 消息，找不到给 null。 */
export function findAskUserCallOwner(
  messages: Array<LooseMessage>,
  toolCallId: string,
): { message: LooseMessage; call: PendingAskUser } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    const call = askUserCallsOf(msg).find((c) => c.toolCallId === toolCallId);
    if (call) return { message: msg, call };
  }
  return null;
}

/**
 * 中断 / 出错的回合：pi-ai 的 transformMessages 发请求前会整条丢掉这种 assistant 消息，
 * 它带的工具调用跟着消失。再往后补 toolResult 就是孤儿 tool_result，整个会话之后发不出去。
 */
export function isDeadAssistantTurn(msg: LooseMessage): boolean {
  const stopReason = (msg as { stopReason?: unknown }).stopReason;
  return stopReason === 'aborted' || stopReason === 'error';
}
