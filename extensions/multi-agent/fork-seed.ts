function roleOf(message: unknown): string | undefined {
  return (message as { role?: string }).role;
}

function hasToolCall(message: unknown, toolCallId: string): boolean {
  const content = (message as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall" && (b as { id?: string }).id === toolCallId);
}

/** Leaf messages up to the last completed turn, excluding the in-flight spawn assistant. */
export function completedPrefix(messages: unknown[], toolCallId: string): unknown[] {
  const list = messages.filter((m) => {
    const role = roleOf(m);
    return role === "user" || role === "assistant" || role === "toolResult";
  });
  for (let i = list.length - 1; i >= 0; i--) {
    if (roleOf(list[i]) === "assistant" && hasToolCall(list[i], toolCallId)) return list.slice(0, i);
  }
  if (list.length && roleOf(list[list.length - 1]) === "assistant") return list.slice(0, -1);
  return list;
}

/** Copy seed messages onto the child session. Returns written count. Does not rewrite tool ids. */
export function writeSeed(
  sessionManager: { appendMessage: (m: unknown) => void },
  messages: unknown[],
): number {
  for (const m of messages) sessionManager.appendMessage(m);
  return messages.length;
}
