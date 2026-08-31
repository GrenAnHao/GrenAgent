// Flatten a heterogeneous AgentMessage[] into a plain "role: text" transcript.
// Shared by goal judging, session-memory, local memory capture and auto-title.
// extensions so the (sometimes nested) message-shape handling lives in one place.

/** Extract concatenated text from a message content (string | text-part array). */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * Flatten one message to a `role: text` line (empty string if no text).
 * Accepts both flat `{ role, content }` and nested `{ message: { role, content } }`.
 */
export function messageToText(m: unknown): string {
  const obj = (m ?? {}) as { role?: string; content?: unknown; message?: { role?: string; content?: unknown } };
  const role = obj.role ?? obj.message?.role ?? "";
  const text = extractTextFromContent(obj.content ?? obj.message?.content);
  return text ? `${role}: ${text}` : "";
}

/** Join messages to a transcript, keeping the most recent `maxChars` characters. */
export function flattenTranscript(messages: unknown[], maxChars = 12000): string {
  return messages.map(messageToText).filter(Boolean).join("\n").slice(-maxChars);
}
