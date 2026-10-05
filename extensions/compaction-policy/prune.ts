// toolResult 正文长度与常开的超大结果熔断。按压力裁旧工具输出见 pressure-prune.ts。
type MessageLike = { role?: string; content?: unknown; toolName?: string };

export function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .reduce((n, c) => n + (c.text?.length ?? 0), 0);
}

/** Always-on fuse: clip toolResult bodies that already exceed maxBodyChars, even in the recent-turn window.
 *  Recency prune cannot save a short chat that already swallowed a megabyte-scale search hit. */
export function fuseOversizeToolResults<T extends MessageLike>(
  messages: T[],
  maxBodyChars: number,
): { messages: T[]; fusedCount: number } {
  if (!(maxBodyChars > 0)) return { messages, fusedCount: 0 };
  let fusedCount = 0;
  const out = messages.map((m) => {
    if (m?.role !== "toolResult") return m;
    const len = textLength(m.content);
    if (len < maxBodyChars) return m;
    fusedCount++;
    const rest = Array.isArray(m.content)
      ? m.content.filter((c) => !(c && typeof c === "object" && (c as { type?: string }).type === "text"))
      : [];
    return {
      ...m,
      content: [{ type: "text", text: `[truncated tool output: ${m.toolName ?? "tool"}, ${len} chars]` }, ...rest],
    } as T;
  });
  return { messages: fusedCount ? out : messages, fusedCount };
}
