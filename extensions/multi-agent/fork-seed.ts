import { rmSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

type SeedMessage = Parameters<SessionManager["appendMessage"]>[0];

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

export function wipeSessionFile(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Copy seed messages onto the child session. Returns written count. Does not rewrite tool ids. */
export function writeSeed(
  sessionManager: { appendMessage: (message: SeedMessage) => void },
  messages: readonly unknown[],
): number {
  for (const message of messages) sessionManager.appendMessage(message as SeedMessage);
  return messages.length;
}
