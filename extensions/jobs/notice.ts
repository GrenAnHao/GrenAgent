// extensions/jobs/notice.ts
import { statusLine } from "./render.js";
import type { JobSnapshot } from "./types.js";

/**
 * 首行 `Background job <id> (<kind>: <label>) finished <status>.`（界面 JobDonePill 按这个格式解析标题）。
 * 按 DSH tool-jobs：再给状态行（带终态原因，如 exit code）和 job_output 收集指令，输出不进通知。
 */
export function formatJobNotice(snapshot: JobSnapshot): string {
  const head = `Background job ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${snapshot.status}.`;
  return `${head}\n${statusLine(snapshot)}\nRead its output with job_output.`;
}
