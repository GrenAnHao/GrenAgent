export const WAITING_FOR_BASH = "回复已完成 · 等待后台命令";
export const BASH_WAIT_TIMED_OUT = "回复已完成 · 后台命令超时";

export interface BackgroundBashTimeout {
  reason: "background-bash-timeout";
  replyCompleted: true;
  jobs: Array<{ id: string; label: string; stopConfirmed: boolean }>;
}

export type SubagentBashState = { phase: "waiting-for-bash" } | BackgroundBashTimeout;

export function readSubagentBashState(value: unknown): SubagentBashState | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return; }
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (row.phase === "waiting-for-bash") return { phase: "waiting-for-bash" };
  if (row.reason !== "background-bash-timeout" || row.replyCompleted !== true || !Array.isArray(row.jobs)) return;
  const jobs: BackgroundBashTimeout["jobs"] = [];
  for (const job of row.jobs) {
    if (!job || typeof job.id !== "string" || typeof job.label !== "string" || typeof job.stopConfirmed !== "boolean") return;
    jobs.push({ id: job.id, label: job.label, stopConfirmed: job.stopConfirmed });
  }
  if (jobs.length) return { reason: "background-bash-timeout", replyCompleted: true, jobs };
}

export function bashTimeoutOf(value: unknown): BackgroundBashTimeout | undefined {
  const state = readSubagentBashState(value);
  return state && "reason" in state ? state : undefined;
}

export function bashTimeoutDescription(state: BackgroundBashTimeout): string {
  return state.jobs.map((job) => `${job.id} · ${job.label}（${job.stopConfirmed ? "已确认退出" : "停止未确认"}）`).join("\n");
}

export function subagentBashLabel(status: string, state: SubagentBashState | undefined): string | undefined {
  if (status === "running" && state && "phase" in state) return WAITING_FOR_BASH;
  if (status === "error" && state && "reason" in state) return BASH_WAIT_TIMED_OUT;
}
