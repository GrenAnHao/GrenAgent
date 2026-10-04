// 提示缓存冷热判断。最后活动 = 最后一条助手消息与分支上最后一次 cache_warm 保温中较晚的那个。
// Pi 1.0.2 的 CacheWarmer 保温不产生助手消息，只在分支上追加 type "usage"、kind "cache_warm" 的条目。

export const DEFAULT_PRUNE_TTL_MS = 300_000;

type TimedMessage = { role?: string; timestamp?: unknown };
type BranchEntryLike = { type?: string; kind?: string; timestamp?: unknown };

/** COMPACTION_POLICY_PRUNE_TTL_MS：未设置、空或非法时 300000；0 表示每次都按冷处理。 */
export function parsePruneTtlMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_PRUNE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PRUNE_TTL_MS;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export function lastActivityMs(
  messages: readonly TimedMessage[],
  branch: readonly BranchEntryLike[],
): number | undefined {
  let assistant: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    assistant = toMs(messages[i].timestamp);
    break;
  }
  let warm: number | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type !== "usage" || e.kind !== "cache_warm") continue;
    warm = toMs(e.timestamp);
    break;
  }
  if (assistant == null) return warm;
  if (warm == null) return assistant;
  return Math.max(assistant, warm);
}

export function isCacheCold(now: number, lastActivity: number | undefined, ttlMs: number): boolean {
  if (ttlMs === 0 || lastActivity == null) return true;
  return now - lastActivity >= ttlMs;
}
