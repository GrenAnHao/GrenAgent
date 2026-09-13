import { SessionManager } from "@earendil-works/pi-coding-agent";

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: Record<string, unknown>;
};

function lastSubagentMeta(entries: unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const item = entry as SessionEntry;
    if (item?.type === "custom" && item.customType === "subagent_meta") {
      found = item.data && typeof item.data === "object" ? item.data : {};
    }
  }
  return found;
}

/** JSONL 在且最后一条 subagent_meta 仍是可续聊、未拆除时，重启不得当取消处理。 */
export function isContinuableLeftover(sessionPath: string | null | undefined): boolean {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return false;
  try {
    const entries = SessionManager.open(sessionPath).getEntries();
    const meta = lastSubagentMeta(entries);
    if (!meta) return false;
    return meta.mode === "continuable" && meta.tornDown !== true;
  } catch {
    return false;
  }
}
