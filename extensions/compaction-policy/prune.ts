// Ephemeral context prune: replace old, completed toolResult output bodies that
// fall outside the protection window (last `keepRecentTurns` user turns) with a
// short placeholder, keeping the toolResult message structure intact.
export interface PruneOptions {
  keepRecentTurns: number;
  minBodyChars: number;
}

type MessageLike = { role?: string; content?: unknown; toolName?: string };

export function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .reduce((n, c) => n + (c.text?.length ?? 0), 0);
}

export function pruneMessages<T extends MessageLike>(
  messages: T[],
  opts: PruneOptions,
): { messages: T[]; prunedCount: number } {
  const userIdxs = messages.map((m, i) => (m?.role === "user" ? i : -1)).filter((i) => i >= 0);
  // Not enough turns to have anything outside the window → prune nothing.
  if (userIdxs.length <= opts.keepRecentTurns) return { messages, prunedCount: 0 };
  const protectFrom = userIdxs[userIdxs.length - opts.keepRecentTurns];

  let prunedCount = 0;
  const out = messages.map((m, i) => {
    if (i >= protectFrom) return m;
    if (m?.role !== "toolResult") return m;
    const len = textLength(m.content);
    if (len < opts.minBodyChars) return m;
    prunedCount++;
    return {
      ...m,
      content: [{ type: "text", text: `[pruned tool output: ${m.toolName ?? "tool"}, ${len} chars]` }],
    } as T;
  });
  return { messages: out, prunedCount };
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
