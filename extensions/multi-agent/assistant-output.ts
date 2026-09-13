// DSH-style final assistant text from a child session (not raw JSONL / session headers).

import { assistantTextFromContent } from "./runner.js";

export type SubagentStopReason = "completed" | "aborted" | "error";

export interface AssistantOutputResult {
  output: string;
  stopReason: SubagentStopReason;
}

type AssistantLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

function mapStopReason(raw: string | undefined, aborted: boolean): SubagentStopReason {
  if (aborted) return "aborted";
  const s = raw?.trim().toLowerCase();
  if (s === "aborted" || s === "cancelled") return "aborted";
  if (s === "error" || s === "tool_use_failure") return "error";
  return "completed";
}

/**
 * 从子会话消息列表抽出父模型应看到的最终正文（对齐 DSH assistant-output）：
 * 1. 最后一条非空 assistant
 * 2. 否则 streamingDelta
 * 3. 否则空 + error
 */
function extractFrom(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean },
): AssistantOutputResult {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = assistantTextFromContent(m.content);
    if (text.trim()) {
      return { output: text, stopReason: mapStopReason(m.stopReason, !!options.aborted) };
    }
  }
  const delta = options.streamingDelta?.trim() ?? "";
  if (delta) {
    return { output: delta, stopReason: options.aborted ? "aborted" : "completed" };
  }
  return { output: "", stopReason: options.aborted ? "aborted" : "error" };
}

export function extractAssistantOutput(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean; skipPrefix?: number } = {},
): AssistantOutputResult {
  const start = Math.max(0, options.skipPrefix ?? 0);
  return extractFrom(messages.slice(start), options);
}
