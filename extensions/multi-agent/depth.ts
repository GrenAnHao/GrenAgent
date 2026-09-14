// 委派深度：顶层 0，子级 = 父 + 1。权威是自身 JSONL 的 subagent_meta.depth（冷恢复后 env 会丢），
// env SUBAGENT_DEPTH 只能加深，不能降低——否则冷恢复的子级会以为自己是顶层。
import { getConfig } from "../_shared/runtime-config.js";
import { SubagentError } from "./inbox.js";

export const DEFAULT_MAX_DEPTH = 2;

type EntriesCtx = { sessionManager?: { getEntries?: () => unknown[] } };

function metaDepth(ctx: EntriesCtx): number {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return 0;
    let depth = 0;
    for (const e of entries) {
      const item = e as { type?: string; customType?: string; data?: { depth?: unknown } };
      if (item?.type === "custom" && item.customType === "subagent_meta" && typeof item.data?.depth === "number") {
        depth = item.data.depth;
      }
    }
    return Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
  } catch {
    return 0;
  }
}

function envDepth(): number {
  const n = Number(getConfig("SUBAGENT_DEPTH") ?? "");
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function resolveDelegationDepth(ctx: EntriesCtx): number {
  return Math.max(metaDepth(ctx), envDepth());
}

export function readMaxDepth(): number {
  const raw = getConfig("SUBAGENT_MAX_DEPTH")?.trim();
  if (!raw) return DEFAULT_MAX_DEPTH;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_DEPTH;
}

export function childDepthOf(ctx: EntriesCtx): number {
  return resolveDelegationDepth(ctx) + 1;
}

export function assertDepthAllowed(childDepth: number): void {
  const max = readMaxDepth();
  if (childDepth > max) throw new SubagentError(`已达委派深度上限 ${max}`, "DEPTH_EXCEEDED");
}
