// DSH-style final assistant text from a child session (not raw JSONL / session headers).

import { assistantTextFromContent } from "./runner.js";

/**
 * 子代理结束原因，采用 DSH 词表（SubagentStopReasonMap）。目前只产出 completed / aborted / error；
 * max-tokens / refusal 先占类型，产出它们会改变父会话看到的结果，留到交付方式统一时再接。
 */
export type SubagentStopReason = "completed" | "aborted" | "error" | "max-tokens" | "refusal";

export interface AssistantOutputResult {
  output: string;
  stopReason: SubagentStopReason;
}

type AssistantLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  /** toolResult 消息上的字段。 */
  toolName?: string;
  isError?: boolean;
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

function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 子会话没有正常交出最终答复时，说清停在哪里，替代光秃秃的 "(no output)"：
 * 最后一条 assistant 是模型报错 → 报错原文；会话停在工具结果上（本批工具后没再调模型）→ 哪个工具、
 * 报错时附结果首行。都不是时返回 undefined，调用方自己回退。
 */
export function describeUnfinishedRun(messages: AssistantLike[], skipPrefix = 0): string | undefined {
  const own = messages.slice(Math.max(0, skipPrefix));
  const last = own[own.length - 1];
  if (!last) return undefined;
  if (last.role === "assistant" && last.stopReason === "error") {
    const why = firstLine(last.errorMessage ?? "");
    return why ? `model error: ${why}` : "model error";
  }
  if (last.role === "toolResult") {
    const tool = last.toolName?.trim() || "tool";
    const head = `stopped after ${tool} without a final reply`;
    if (!last.isError) return head;
    const why = firstLine(assistantTextFromContent(last.content));
    return why ? `${head}: ${why}` : head;
  }
  return undefined;
}

export function extractAssistantOutput(
  messages: AssistantLike[],
  options: { streamingDelta?: string; aborted?: boolean; skipPrefix?: number } = {},
): AssistantOutputResult {
  const start = Math.max(0, options.skipPrefix ?? 0);
  return extractFrom(messages.slice(start), options);
}
