// extensions/jobs/notice.ts
import { statusLine } from "./render.js";
import type { JobSnapshot } from "./types.js";

function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > limit) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * 首行 `Background job <id> (<kind>: <label>) finished <status>.`（界面 JobDonePill 按这个格式解析标题）。
 * 流式 job 按 DSH tool-jobs：再给状态行（带终态原因，如 exit code）和 job_output 收集指令，输出不进通知；
 * 终值 job 附结果。
 */
export function formatJobNotice(snapshot: JobSnapshot): string {
  const head = `Background job ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${snapshot.status}.`;
  if (snapshot.stream) return `${head}\n${statusLine(snapshot)}\nRead its output with job_output.`;
  // 失败 / 被终止的 job 输出常是空串：用 ?? 会把错误原因吞掉，父代理和界面都只看到一句 finished failed。
  const body = snapshot.output?.trim() ? snapshot.output : snapshot.error ?? "";
  if (!body) return head;
  const cut = truncateUtf8(body, snapshot.outputLimitBytes);
  return `${head}\n${cut.text}${cut.truncated ? "\n[notice truncated]" : ""}`;
}
