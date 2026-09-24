export interface PendingAskUser {
  toolCallId: string;
  args: Record<string, unknown>;
}

export function findPendingAskUser(messages: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>): PendingAskUser | null {
  const pending = new Map<string, PendingAskUser>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (!block || block.type !== 'toolCall') continue;
        const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
        const id = typeof block.id === 'string' ? block.id : '';
        if (name !== 'ask_user' || !id) continue;
        const raw = block.arguments ?? block.input ?? {};
        pending.set(id, { toolCallId: id, args: raw && typeof raw === 'object' ? raw as Record<string, unknown> : {} });
      }
    }
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') pending.delete(msg.toolCallId);
  }
  let last: PendingAskUser | null = null;
  for (const item of pending.values()) last = item;
  return last;
}
