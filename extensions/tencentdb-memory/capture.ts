import { createHash } from "node:crypto";

import { extractTextFromContent } from "../_shared/transcript.js";

export interface CapturedMessage {
  role: "user" | "assistant";
  content: string;
}

export function selectUncaptured(messages: unknown[], cursor: number): CapturedMessage[] {
  const start = Math.max(0, Math.min(messages.length, Math.trunc(cursor)));
  const captured: CapturedMessage[] = [];

  for (const raw of messages.slice(start)) {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = extractTextFromContent(message.content).trim();
    if (content) captured.push({ role: message.role, content });
  }
  return captured;
}

export function captureFingerprint(messages: CapturedMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}
