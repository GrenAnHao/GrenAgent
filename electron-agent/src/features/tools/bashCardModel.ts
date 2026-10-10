import type { JobLiveView } from '../../lib/pi';
import type { JobRef } from '../../stores/jobLiveStore';
import type { ConvStatus } from '../chat/conv/StatusGlyph';
import { parseSandboxNote, type SandboxNote } from '@extensions/_shared/sandbox/facts';
import type { FileSandboxMode } from '@extensions/_shared/sandbox/types';
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

/**
 * 运行中的前台 bash：命令一起来就是一个匠名 job（DSH 的前台匠名管道），模型从没拿到它的 id。
 * 工具把引用放在 partial 结果的 details.foregroundJob 里，只给界面用；最终结果不带。
 * 和 bashJobRef 分开：那个管已转后台、模型知道 id 的任务。
 */
export function foregroundJobRef(result: unknown): JobRef | null {
  const ref = getDetails(result)?.foregroundJob;
  if (!ref || typeof ref !== 'object') return null;
  const { jobId, jobStartedAt } = ref as Record<string, unknown>;
  if (typeof jobId !== 'string' || !jobId || typeof jobStartedAt !== 'number') return null;
  return { jobId, jobStartedAt };
}

const SANDBOX_MODES: readonly FileSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const isSandboxMode = (value: unknown): value is FileSandboxMode => SANDBOX_MODES.includes(value as FileSandboxMode);

/** bash 结果里的沙箱事实（extensions/sandbox/bashTool.ts 的 details.sandbox）：只在被拒、沙箱没启动、已升权时有。 */
export interface BashSandboxFacts {
  mode: FileSandboxMode;
  denied: boolean;
  runnerFailed?: 'unavailable' | 'runner';
  detail?: string;
  escalatedFrom?: FileSandboxMode;
}

export function bashSandboxFacts(result: unknown): BashSandboxFacts | null {
  const raw = getDetails(result)?.sandbox;
  if (!raw || typeof raw !== 'object') return null;
  const { mode, denied, runnerFailed, detail, escalatedFrom } = raw as Record<string, unknown>;
  if (!isSandboxMode(mode) || typeof denied !== 'boolean') return null;
  return {
    mode,
    denied,
    ...(runnerFailed === 'unavailable' || runnerFailed === 'runner' ? { runnerFailed } : {}),
    ...(typeof detail === 'string' && detail ? { detail } : {}),
    ...(isSandboxMode(escalatedFrom) ? { escalatedFrom } : {}),
  };
}

const SANDBOX_MODE_LABELS: Record<FileSandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全权限',
};

/** 沙箱模式的中文名。用表而不是 if/else 兜底：加了新模式不会被静默标成「完全权限」。 */
export function sandboxModeLabel(mode: FileSandboxMode): string {
  return SANDBOX_MODE_LABELS[mode];
}

/** 折叠行 meta：沙箱没启动 > 被拒 > 已升权。升权后仍被拒按被拒显示，模式是升权后的。 */
export function bashSandboxMeta(facts: BashSandboxFacts | null): string | undefined {
  if (!facts) return undefined;
  if (facts.runnerFailed) return '沙箱未启动';
  if (facts.denied) return `沙箱拒绝 · ${sandboxModeLabel(facts.mode)}`;
  if (facts.escalatedFrom) return `已升权 · ${sandboxModeLabel(facts.mode)}`;
  return undefined;
}

/** 展开后终端底栏的一句说明，优先级同上。终端正文仍是给模型的文本。 */
export function bashSandboxNote(facts: BashSandboxFacts | null): string | undefined {
  if (!facts) return undefined;
  if (facts.runnerFailed) return `沙箱没有启动，命令没有执行${facts.detail ? `：${facts.detail}` : ''}`;
  if (facts.denied) return `沙箱拦下了文件访问（${sandboxModeLabel(facts.mode)}模式）`;
  if (facts.escalatedFrom) return `本次已获批准，以${sandboxModeLabel(facts.mode)}权限运行`;
  return undefined;
}

function sandboxNoteLabel(note: SandboxNote): string {
  return note.kind === 'runner-failed' ? '沙箱没有启动，命令没有执行' : `沙箱拒绝（${sandboxModeLabel(note.mode)}）`;
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

/**
 * 后台 bash 行的状态。工具调用本身瞬间就返回了（`✓ 0s`），行图标要跟着后台任务走，
 * 否则一个还在跑的任务看起来像已经结束。任务在跑（含正在停止）是 running；失败、被停止、
 * 非零退出是 error；其余沿用工具调用本身的状态。任务还没取到（快照在路上、已不在）时也沿用。
 */
export function jobRowStatus(callStatus: ConvStatus, job: Pick<JobLiveView, 'status' | 'detail'> | undefined): ConvStatus {
  if (!job) return callStatus;
  if (jobIsLive(job)) return 'running';
  return jobEndedBadly(job) ? 'error' : callStatus;
}

/** 后台 bash 行的时长：在跑时从任务开始起算并逐秒自增，结束后定格在任务自己的耗时。 */
export function jobTiming(job: Pick<JobLiveView, 'status' | 'startedAt' | 'finishedAt'>): {
  startedAt: number;
  durationMs?: number;
  running: boolean;
} {
  const running = jobIsLive(job);
  return {
    startedAt: job.startedAt,
    running,
    ...(!running && job.finishedAt != null ? { durationMs: Math.max(0, job.finishedAt - job.startedAt) } : {}),
  };
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

/**
 * 底栏：停止和失败带上原因（`killed before exit; cancelled by the user`），其余只给状态。
 * 结算 detail 里有 processOutcome 写的沙箱标记时换成中文说明（标记是写给模型的），完整 detail 留在悬停提示里。
 */
export function jobFooterText(
  job: Pick<JobLiveView, 'id' | 'status' | 'detail'>,
  /** 匿名前台命令：模型没拿到这个 id，它也不是后台任务，底栏只说状态。 */
  anonymous = false,
): string {
  const note = parseSandboxNote(job.detail);
  const reason = note
    ? ` · ${sandboxNoteLabel(note)}`
    : (job.status === 'killed' || job.status === 'failed') && job.detail
      ? ` · ${job.detail}`
      : '';
  return anonymous ? `${jobStatusShort(job)}${reason}` : `后台任务 ${job.id} · ${jobStatusShort(job)}${reason}`;
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
