// 把压缩时的抽取正文组装成 Pi 的压缩结果：文件附录、details、前置条件与来源判断。
import type { CompactionResult, FileOperations } from "@earendil-works/pi-coding-agent";

export const STATE_SUMMARY_SOURCE = "session-state";
export const FILE_LIST_CAP = 40;

export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface StateCompactionDetails extends FileLists {
  source: typeof STATE_SUMMARY_SOURCE;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 调用方没带附言、准备数据完整时，才用状态当摘要。 */
export function canUseStateSummary(event: {
  customInstructions?: string;
  preparation?: { firstKeptEntryId?: unknown; tokensBefore?: unknown };
}): boolean {
  if (event.customInstructions?.trim()) return false;
  const p = event.preparation;
  return (
    typeof p?.firstKeptEntryId === "string" &&
    p.firstKeptEntryId.length > 0 &&
    typeof p.tokensBefore === "number" &&
    Number.isFinite(p.tokensBefore)
  );
}

/**
 * 分支上最后一条压缩若由本扩展写入，取它 details 里的文件列表。
 * 最后一条是 Pi 写的时返回空：Pi 已经把它的列表并进 preparation.fileOps。
 */
export function previousStateFileLists(branchEntries: readonly { type?: string; details?: unknown }[]): FileLists {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (e?.type !== "compaction") continue;
    const d = (e.details ?? {}) as { source?: unknown; readFiles?: unknown; modifiedFiles?: unknown };
    if (d.source !== STATE_SUMMARY_SOURCE) break;
    return { readFiles: asStrings(d.readFiles), modifiedFiles: asStrings(d.modifiedFiles) };
  }
  return { readFiles: [], modifiedFiles: [] };
}

/** 与 Pi 的 computeFileLists 同口径：modified = edited ∪ written，read 去掉已改的，各自排序。 */
export function mergeFileLists(fileOps: FileOperations | undefined, prev: FileLists): FileLists {
  const modified = new Set<string>([...prev.modifiedFiles, ...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
  const read = new Set<string>([...prev.readFiles, ...(fileOps?.read ?? [])]);
  return {
    readFiles: [...read].filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatList(tag: string, files: readonly string[], cap: number): string {
  const shown = files.slice(0, cap);
  const more = files.length - shown.length;
  return `<${tag}>\n${shown.join("\n")}${more > 0 ? `\n(${more} more)` : ""}\n</${tag}>`;
}

export function formatFileAppendix(lists: FileLists, cap = FILE_LIST_CAP): string {
  const parts: string[] = [];
  if (lists.readFiles.length) parts.push(formatList("read-files", lists.readFiles, cap));
  if (lists.modifiedFiles.length) parts.push(formatList("modified-files", lists.modifiedFiles, cap));
  return parts.join("\n\n");
}

export function buildStateCompaction(
  body: string,
  preparation: { firstKeptEntryId: string; tokensBefore: number },
  lists: FileLists,
): CompactionResult<StateCompactionDetails> {
  const appendix = formatFileAppendix(lists);
  return {
    summary: appendix ? `${body}\n\n${appendix}` : body,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { source: STATE_SUMMARY_SOURCE, ...lists },
  };
}

/** session_compact 的条目是否由本扩展用状态写成。 */
export function isStateCompaction(event: { fromExtension?: boolean; compactionEntry?: { details?: unknown } }): boolean {
  const details = event.compactionEntry?.details as { source?: unknown } | undefined;
  return event.fromExtension === true && details?.source === STATE_SUMMARY_SOURCE;
}
