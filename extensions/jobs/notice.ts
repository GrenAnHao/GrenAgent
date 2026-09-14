// extensions/jobs/notice.ts
import type { JobSnapshot } from "./types.js";

function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > limit) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** 对齐 DSH tool-jobs：首行 `Background job <id> (<kind>: <label>) finished <status>.`，终值 job 附输出。 */
export function formatJobNotice(snapshot: JobSnapshot): string {
  const head = `Background job ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${snapshot.status}.`;
  if (snapshot.stream) return head;
  const body = snapshot.output ?? snapshot.error ?? "";
  if (!body) return head;
  const cut = truncateUtf8(body, snapshot.outputLimitBytes);
  return `${head}\n${cut.text}${cut.truncated ? "\n[notice truncated]" : ""}`;
}
