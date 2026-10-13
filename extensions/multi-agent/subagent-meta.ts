// 子会话 JSONL 里最后一条 subagent_meta：可续聊吗、拆除了没、跑在哪个后端、父会话是谁。
// 冷恢复（activation.ts）、重启回收（registry.ts reapOrphans）都从这里读，只此一份。

import { SessionManager } from "@earendil-works/pi-coding-agent";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

export function lastSubagentMeta(entries: readonly unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as SessionEntry;
    if (item?.type === "custom" && item.customType === "subagent_meta" && item.data && typeof item.data === "object") {
      found = item.data;
    }
  }
  return found;
}

/** 还能续聊：最后一条 meta 是 continuable 且没被拆除。 */
export function isResumableMeta(meta: Record<string, unknown> | undefined): meta is Record<string, unknown> {
  return !!meta && meta.mode === "continuable" && meta.tornDown !== true;
}

/** JSONL 在且最后一条 subagent_meta 仍是可续聊、未拆除时，重启不得当取消处理。 */
export function isContinuableLeftover(sessionPath: string | null | undefined): boolean {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return false;
  try {
    return isResumableMeta(lastSubagentMeta(SessionManager.open(sessionPath).getEntries()));
  } catch {
    return false;
  }
}
