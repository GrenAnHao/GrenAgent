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

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => !!block && typeof block === "object");
}

/**
 * 对齐 DSH `finalAssistantOutput`：选最后一条内容非空的 assistant（thinking、toolCall
 * 也算非空）。只有真正的空消息才不覆盖更早的输出。没有任何非空消息时，才用 streamingDelta。
 * 选哪一条和 stopReason 无关；交给父代理的字符串只取这一条里的 text，不回退到更早的正文。
 */
function extractFrom(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean },
): AssistantOutputResult {
  let terminal: AssistantLike | undefined;
  let selected: AssistantLike | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (!terminal) terminal = message;
    if (!selected && contentBlocks(message.content).length > 0) selected = message;
    if (terminal && selected) break;
  }

  const stopReason = mapStopReason(terminal?.stopReason, !!options.aborted);
  if (selected) {
    return { output: assistantTextFromContent(selected.content).trim(), stopReason };
  }

  const delta = options.streamingDelta?.trim() ?? "";
  if (delta) {
    return { output: delta, stopReason: terminal ? stopReason : options.aborted ? "aborted" : "completed" };
  }
  if (stopReason === "aborted") return { output: "", stopReason: "aborted" };
  return { output: "", stopReason: "error" };
}

export function extractAssistantOutput(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean; skipPrefix?: number } = {},
): AssistantOutputResult {
  const start = Math.max(0, options.skipPrefix ?? 0);
  return extractFrom(messages.slice(start), options);
}
