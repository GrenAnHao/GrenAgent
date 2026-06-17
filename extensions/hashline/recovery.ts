// 锚点过期自动恢复：3-way merge。把补丁应用到 hl_read 快照(prev)，再把 prev→applied 的
// 补丁以 fuzzFactor 0 严格合并到当前磁盘内容(cur)。目标区在 cur 漂移/被改即失败，绝不误落。
import { applyPatch, structuredPatch } from "diff";
import { applyOps } from "./apply.js";
import type { Op } from "./parser.js";

export interface RecoverResult {
  content?: string;
  error?: string;
}

export function recover(prev: string, cur: string, ops: Op[]): RecoverResult {
  const applied = applyOps(prev, ops);
  if (applied.error || applied.content === undefined) {
    return { error: applied.error ?? "补丁应用到快照失败" };
  }
  if (applied.content === prev) return { error: "补丁对快照无改动" };
  const patch = structuredPatch("f", "f", prev, applied.content, "", "", { context: 3 });
  const merged = applyPatch(cur, patch, { fuzzFactor: 0 });
  if (typeof merged !== "string") {
    return { error: "无法合并到当前内容（锚点漂移或目标区已变），请重新 hl_read" };
  }
  return { content: merged };
}
