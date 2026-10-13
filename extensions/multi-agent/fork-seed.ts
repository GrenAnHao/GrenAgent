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

/**
 * fork 出来的子代理开头的说明（照 Codex core/src/agent/control/spawn.rs 的 MultiAgentUsageHint）：
 * 前面的对话是继承来的父会话上下文，其中的身份、任务、针对具体动作的审批都属于祖先；继承的工具调用只是历史，
 * 进程和工具会话不继承。没有它，子代理会把父会话最后一条「请调用某工具」当成给自己的指令照做。
 */
export const FORK_INHERITANCE_NOTE =
  "You are now a newly spawned child agent. The preceding conversation is inherited parent context. " +
  "Follow your own role, identity, and task below; earlier identities, tasks, and action-specific approvals belong to your ancestors. " +
  "Inherited tool calls are historical records; live tool sessions and process handles are not inherited. Report your result to your parent.";

/** 有继承上下文时，把说明放在子代理任务前面。 */
export function withForkNote(task: string, inheritedEventCount: number): string {
  return inheritedEventCount > 0 ? `${FORK_INHERITANCE_NOTE}\n\n${task}` : task;
}

/** Copy seed messages onto the child session. Returns written count. Does not rewrite tool ids. */
export function writeSeed(
  sessionManager: { appendMessage: (message: SeedMessage) => void },
  messages: readonly unknown[],
): number {
  for (const message of messages) sessionManager.appendMessage(message as SeedMessage);
  return messages.length;
}
