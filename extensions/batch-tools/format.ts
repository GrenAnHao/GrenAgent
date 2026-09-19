// 纯函数：把 read_files 的分段与 search 的分组渲染成紧凑文本。
import { previewLine } from "../_shared/output-retention.js";

export interface ReadSegment {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  truncated: boolean;
  error?: string;
  binary?: boolean;
}

function formatReadSegment(seg: ReadSegment): string {
  if (seg.error) return `===== ${seg.path} =====\n[error: ${seg.error}]`;
  if (seg.binary) return `===== ${seg.path} =====\n[skipped: binary file]`;
  const span = seg.startLine === seg.endLine ? `line ${seg.startLine}` : `lines ${seg.startLine}-${seg.endLine}`;
  const showTotal = seg.startLine > 1 || seg.endLine < seg.totalLines;
  const header = showTotal
    ? `===== ${seg.path} (${span} of ${seg.totalLines}) =====`
    : `===== ${seg.path} (${span}) =====`;
  const body = seg.lines.map((l, i) => `${seg.startLine + i}: ${l}`).join("\n");
  const tail = seg.truncated
    ? `\n[truncated at line ${seg.endLine}; use read with offset=${seg.endLine + 1} for the rest]`
    : "";
  return `${header}\n${body}${tail}`;
}

export function formatReadResult(segs: ReadSegment[]): string {
  return segs.map(formatReadSegment).join("\n\n");
}

export interface Hit {
  line: number;
  text: string;
  isMatch: boolean;
}

export function formatSearchGroups(
  groups: { file: string; hits: Hit[] }[],
  opts: { total: number; files: number; capped: boolean; limit: number; invalidPatterns?: string[] },
): string {
  if (!groups.length) {
    const inv = opts.invalidPatterns?.length ? ` (invalid patterns: ${opts.invalidPatterns.join(", ")})` : "";
    return `No matches.${inv}`;
  }
  const blocks = groups.map(
    (g) => g.file + "\n" + g.hits.map((h) => `  ${h.line}${h.isMatch ? ":" : "-"} ${previewLine(h.text)}`).join("\n"),
  );
  const cap = opts.capped ? `; capped at ${opts.limit}` : "";
  const inv = opts.invalidPatterns?.length ? `; invalid patterns: ${opts.invalidPatterns.join(", ")}` : "";
  blocks.push(`(${opts.total} matches in ${opts.files} files${cap}${inv})`);
  return blocks.join("\n");
}
