import type { JobLiveView } from '../../lib/pi';
import type { JobRef } from '../../stores/jobLiveStore';
import { getArgString, getDetails } from './toolUtils';

const WORK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapsed bash row copy: what the command does, never the raw command line. */
export function bashRowSummary(args: unknown): string {
  const description = getArgString(args, 'description').trim();
  return description || '执行命令';
}

/** Prompt label for the expanded terminal card (last cwd segment, else `$`). */
export function terminalPromptLabel(cwd: string | undefined): string {
  if (!cwd) return '$';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const segment = trimmed.split(/[/\\]/).pop();
  if (!segment || WORK_ID.test(segment)) return '$';
  return segment;
}

/** One prompt row per command line; a trailing newline is a terminator. */
export function terminalCommandLines(command: string): string[] {
  const body = command.endsWith('\n') ? command.slice(0, -1) : command;
  return body.length === 0 ? [''] : body.split('\n');
}

/** 卡片头只占一行：多行命令显示首行并用 `…` 标出后面还有，全文给悬停和复制。 */
export function terminalCommandHead(command: string): string {
  const lines = terminalCommandLines(command);
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
}

export type TerminalCopyKind = 'command' | 'output' | 'all';

/** 复制菜单三项的文本：命令原文、输出原文、或按终端样式拼成 `$ 命令` + 输出。 */
export function terminalCopyText(kind: TerminalCopyKind, command: string, output: string | undefined): string {
  const lines = terminalCommandLines(command);
  if (kind === 'command') return lines.join('\n');
  if (kind === 'output') return output ?? '';
  const prompt = lines.map((line) => `$ ${line}`).join('\n');
  return terminalOutputEmpty(output) ? prompt : `${prompt}\n${output}`;
}

/**
 * bash 结果里的后台 job：run_in_background 的开始结果，或前台超时转后台的结果，都在 details 里带
 * jobId + jobStartedAt（extensions/sandbox/bashTool.ts）。没有就是普通前台命令。
 */
export function bashJobRef(result: unknown): JobRef | null {
  const details = getDetails(result);
  if (!details) return null;
  const { jobId, jobStartedAt } = details;
  if (typeof jobId !== 'string' || !jobId || typeof jobStartedAt !== 'number') return null;
  return { jobId, jobStartedAt };
}

export function jobIsLive(job: Pick<JobLiveView, 'status'>): boolean {
  return job.status === 'running' || job.status === 'stopping';
}

/** 终态里算出错的：失败、被停止、非零退出。 */
export function jobEndedBadly(job: Pick<JobLiveView, 'status' | 'detail'>): boolean {
  if (job.status === 'failed' || job.status === 'killed') return true;
  if (job.status !== 'completed') return false;
  const code = /exit code: (-?\d+)/.exec(job.detail ?? '')?.[1];
  return code !== undefined && code !== '0';
}

/** 后台 job 的中文状态短语（卡片底栏）。 */
export function jobStatusShort(job: Pick<JobLiveView, 'status' | 'detail'>): string {
  switch (job.status) {
    case 'running':
      return '运行中';
    case 'stopping':
      return '正在停止';
    case 'killed':
      return '已停止';
    case 'failed':
      return '失败';
    default: {
      const code = /exit code: (-?\d+)/.exec(job.detail ?? '')?.[1];
      return code !== undefined && code !== '0' ? `已结束，退出码 ${code}` : '已完成';
    }
  }
}

/** 折叠行上的状态：后台运行中 / 后台已完成…… */
export function jobStatusLabel(job: Pick<JobLiveView, 'status' | 'detail'>): string {
  return `后台${jobStatusShort(job)}`;
}

/** 底栏：停止和失败带上原因（`killed before exit; cancelled by the user`），其余只给状态。 */
export function jobFooterText(job: Pick<JobLiveView, 'id' | 'status' | 'detail'>): string {
  const reason = (job.status === 'killed' || job.status === 'failed') && job.detail ? ` · ${job.detail}` : '';
  return `后台任务 ${job.id} · ${jobStatusShort(job)}${reason}`;
}

export function terminalOutputEmpty(output: string | undefined): boolean {
  return !output || output.trim() === '';
}

/** 命令运行时长：不足 1 分钟记到秒（`10s`），跨分钟带秒（`1m20s`），跨小时降到分（`1h5m`）。 */
export function formatRunDuration(ms: number): string {
  const totalSec = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const seconds = totalSec % 60;
    return seconds === 0 ? `${totalMin}m` : `${totalMin}m${seconds}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}
