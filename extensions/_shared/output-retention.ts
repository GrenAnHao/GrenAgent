// DSH-aligned output retention: bound what a tool result may inject into context.
// Numbers match DeepSeek Harness grep/read (GREP_MAX_MATCHES=250, GREP_MAX_LINE_BYTES=2000,
// READ_MAX_LINE_LENGTH=2000, READ_MAX_BYTES=50KiB).

/** Default / hard cap on matches retained inline by one grep-like call. */
export const GREP_MAX_MATCHES = 250;

/** Default cap in bytes on one matched-line preview (UTF-8, exclusive cut). */
export const GREP_MAX_LINE_BYTES = 2000;

/** Default maximum characters returned for a single read line. */
export const READ_MAX_LINE_LENGTH = 2000;

/** Default maximum bytes returned for selected file lines. */
export const READ_MAX_BYTES = 50 * 1024;

/** Default read window line cap when the caller omits `limit` (DSH `readLimit`). */
export const READ_MAX_LINES = 2000;

/**
 * Bound one matched-line preview to `maxBytes` (UTF-8 boundary preserved) and
 * mark the cut. The complete line stays in the file for a follow-up read.
 */
export function previewLine(line: string, maxBytes = GREP_MAX_LINE_BYTES): string {
  const buf = Buffer.from(line, "utf8");
  if (buf.byteLength <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")} (line truncated)`;
}

/** DSH read: clip a giant single line by character count, with the same suffix. */
export function truncateReadLine(line: string, maxChars = READ_MAX_LINE_LENGTH): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}... (line truncated to ${maxChars} chars)`;
}

/** Keep the first `maxItems`; later items are dropped (DSH ItemRetainer head). */
export function retainHead<T>(
  items: T[],
  maxItems: number,
): { items: T[]; truncated: boolean; seen: number } {
  const truncated = items.length > maxItems;
  return { items: truncated ? items.slice(0, maxItems) : items, truncated, seen: items.length };
}
