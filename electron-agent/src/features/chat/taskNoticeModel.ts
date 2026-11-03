/**
 * 后台任务终态（job-done / subagent-settled）的展示模型：把写给模型的英文通知和结构化 details
 * 变成卡片要显示的状态、任务身份和诊断。只读解析，不改生产者协议。
 *
 * 真话优先：通知里没有的字段就留空；快照没读到就说没读到；未知状态不折算成完成。
 */
import { parseSandboxNote } from '@extensions/_shared/sandbox/facts';
import type { JobLiveView } from '../../lib/pi';
import type { JobLiveEntry } from '../../stores/jobLiveStore';
import { formatRunDuration, sandboxModeLabel } from '../tools/bashCardModel';

export type TaskOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed'
  | 'aborted'
  | 'timeout'
  | 'max-tokens'
  | 'refusal'
  | 'running'
  | 'unknown';

export type TaskTone = 'ok' | 'error' | 'warn' | 'neutral';

/** 卡片行首的状态图标：done / error 用既有 StatusGlyph，warn 用警示图标，running 用转圈。 */
export type TaskGlyph = 'done' | 'error' | 'warn' | 'running';

const TERMINAL_OUTCOMES: ReadonlySet<TaskOutcome> = new Set([
  'completed',
  'failed',
  'cancelled',
  'killed',
  'aborted',
  'timeout',
  'max-tokens',
  'refusal',
]);

export function isTerminalOutcome(outcome: TaskOutcome): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 旧 ui-history 的 content 可能缺失或不是字符串：永远当空正文处理，不让渲染抛错。 */
function sourceText(content: unknown): string {
  return typeof content === 'string' ? content.replace(/\r\n/g, '\n') : '';
}

const TIMEOUT_RE = /\b(?:idle|startup|hard) timeout\b|\btimed[- ]out\b|\bETIMEDOUT\b|^\s*timeout(?:\s|:|$)/i;

export function isTimeoutText(value: string | undefined): boolean {
  return value !== undefined && TIMEOUT_RE.test(value);
}

/** 中文状态短语；unknown 明确写成未确认完成，不冒充成功。 */
export function outcomeStatusText(outcome: TaskOutcome, exitCode?: number, rawStatus?: string): string {
  switch (outcome) {
    case 'completed':
      return '已完成';
    case 'failed':
      return exitCode !== undefined && exitCode !== 0 ? `失败 · 退出码 ${exitCode}` : '失败';
    case 'timeout':
      return '已超时';
    case 'cancelled':
      return '已取消';
    case 'killed':
      return '已终止';
    case 'aborted':
      return '会话已中止';
    case 'max-tokens':
      return '已结束（达到 token 上限）';
    case 'refusal':
      return '已拒绝';
    case 'running':
      return rawStatus === 'stopping' ? '正在停止' : '仍在运行';
    default:
      return '状态未知（未确认完成）';
  }
}

function outcomeTone(outcome: TaskOutcome): TaskTone {
  switch (outcome) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'running':
      return 'neutral';
    default:
      return 'warn';
  }
}

function outcomeGlyph(outcome: TaskOutcome): TaskGlyph {
  switch (outcome) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'running':
      return 'running';
    default:
      return 'warn';
  }
}

/** 终态原因里可能并着多个事实（退出码 + 沙箱说明 + kill 原因），逐条换成中文，认不出的保留原文。 */
export function translateJobDetail(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const sandbox = parseSandboxNote(value);
  const translated: string[] = [];
  for (const part of parts) {
    translated.push(translateJobDetailPart(part, sandbox?.kind === 'denied' || sandbox?.kind === 'runner-failed'));
  }
  return translated.join('；');
}

function translateJobDetailPart(part: string, hasSandboxNote: boolean): string {
  const exit = /^exit code: (-?\d+)$/i.exec(part);
  if (exit) return `退出码 ${exit[1]}`;
  if (/^killed before exit$/i.test(part)) return '进程在退出前被停止';
  if (/^cancelled by the user$/i.test(part)) return '用户停止';
  if (/^no exit code\b/i.test(part)) return '没有退出码（命令没有运行或被终止）';
  const idle = /^idle timeout:\s*([\s\S]*)$/i.exec(part);
  if (idle) return `空闲超时：${idle[1]}`;
  const startup = /^startup timeout:\s*([\s\S]*)$/i.exec(part);
  if (startup) return `启动超时：${startup[1]}`;
  const hard = /^hard timeout after\s*([\s\S]*)$/i.exec(part);
  if (hard) return `硬超时：${hard[1]}`;
  if (/^\[sandbox:/i.test(part)) {
    const note = parseSandboxNote(part);
    if (note?.kind === 'denied') return `沙箱拒绝（${sandboxModeLabel(note.mode)}）`;
    if (note?.kind === 'runner-failed') return '沙箱没有启动，命令没有执行';
    // 升权提示是写给模型的行动建议，不是这次任务的事实，不展示原文。
    return hasSandboxNote ? '' : part;
  }
  return part;
}

const JOB_HEAD = /^Background job (\S+) \((\w+): ([\s\S]*)\) finished (\w+)\.$/;
const JOB_STATUS_LINE = /^\[status: ([^\],]+)(?:,\s*([\s\S]*))?\]$/;
const JOB_INSTRUCTION = 'Read its output with job_output.';

export interface JobNoticeModel {
  id?: string;
  kind?: string;
  label: string;
  /** 首行里任务标签的短描述（压缩空白 + 截断），给紧凑的单行头。 */
  description: string;
  outcome: TaskOutcome;
  rawStatus?: string;
  /** 不含退出码/原因的短状态：已完成 / 失败 / 已取消……（单行头用）。 */
  shortStatus: string;
  /** 完整状态短语（带退出码），给无障碍和详细断言。 */
  statusText: string;
  tone: TaskTone;
  glyph: TaskGlyph;
  title: string;
  /** 给模型的原因原文（用于重新判定与悬停）。 */
  detailRaw?: string;
  /** 换成中文的终态原因。 */
  detail?: string;
  exitCode?: number;
  instruction?: string;
  extra?: string;
  liveNote?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

function exitCodeOf(detail: string | undefined): number | undefined {
  const match = /exit code: (-?\d+)/.exec(detail ?? '');
  return match ? Number(match[1]) : undefined;
}

export function jobOutcome(rawStatus: string | undefined, detail: string | undefined, exitCode: number | undefined): TaskOutcome {
  switch (rawStatus?.toLowerCase()) {
    case 'completed':
      return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'completed';
    case 'failed':
      return isTimeoutText(detail) ? 'timeout' : 'failed';
    case 'killed':
      return /cancelled by the user/i.test(detail ?? '') ? 'cancelled' : 'killed';
    case 'running':
    case 'stopping':
      return 'running';
    default:
      return 'unknown';
  }
}

function jobTitle(id: string | undefined, statusText: string, label: string, fallback: string): string {
  if (!id) return fallback;
  const head = `后台任务 ${id} ${statusText}`;
  return label ? `${head} · ${label}` : head;
}

/** 短状态：不带退出码和原因，单行头的第一层信息。 */
export function shortOutcomeStatus(outcome: TaskOutcome): string {
  switch (outcome) {
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'timeout':
      return '已超时';
    case 'cancelled':
      return '已取消';
    case 'killed':
      return '已终止';
    case 'aborted':
      return '会话已中止';
    case 'max-tokens':
      return '结束（token 上限）';
    case 'refusal':
      return '已拒绝';
    case 'running':
      return '仍在运行';
    default:
      return '状态未知';
  }
}

/** 任务标签压缩成一句短描述；原文可能长达 160 字，卡片上不占满整行。 */
const DESCRIPTION_MAX = 40;

export function shortDescription(label: string | undefined): string {
  const flat = (label ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1)}…` : flat;
}

/** 单行头：`后台任务 bash-1 失败 · 退出码 1 · 短描述`。 */
function compactJobTitle(model: {
  id: string | undefined;
  shortStatus: string;
  exitCode: number | undefined;
  description: string;
  fallback: string;
}): string {
  const { id, shortStatus, exitCode, description, fallback } = model;
  if (!id) return fallback || `后台任务 · ${shortStatus}`;
  const parts = [`后台任务 ${id} ${shortStatus}`];
  if (exitCode !== undefined && exitCode !== 0) parts.push(`退出码 ${exitCode}`);
  if (description) parts.push(description);
  return parts.join(' · ');
}

/**
 * 解析一条 job-done 通知。首行是写给模型的英文整句；details 里有 id / kind / status 时优先用结构化的。
 * 旧历史（只有 content）也照常解析；认不出的正文原样留作标题。
 */
export function parseJobNotice(content: string | undefined | null, details?: unknown, timestamp?: number): JobNoticeModel {
  const meta = record(details);
  const lines = sourceText(content).split('\n');
  const headLine = (lines[0] ?? '').trim();
  const head = JOB_HEAD.exec(headLine);
  const statusLine = lines[1] !== undefined ? JOB_STATUS_LINE.exec(lines[1].trim()) : null;

  const remaining: string[] = [];
  let instruction: string | undefined;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (JOB_STATUS_LINE.test(trimmed)) continue;
    if (trimmed === JOB_INSTRUCTION) {
      instruction = '完整输出需用 job_output 读取。';
      continue;
    }
    remaining.push(line);
  }

  const id = text(meta?.jobId) ?? head?.[1];
  const kind = text(meta?.kind) ?? head?.[2];
  const label = head?.[3]?.trim() ?? '';
  const rawStatus = text(meta?.status) ?? head?.[4] ?? statusLine?.[1]?.trim();
  const detailRaw = text(meta?.detail) ?? statusLine?.[2]?.trim();
  const exitCode = exitCodeOf(detailRaw);
  const outcome = jobOutcome(rawStatus, detailRaw, exitCode);
  const rawDetail = translateJobDetail(detailRaw);

  // 没有正文可解析、但 details 里有身份：仍要显示这条终态。
  const fallback = headLine || (id ? `后台任务 ${id}` : '');
  const statusText = outcomeStatusText(outcome, exitCode, rawStatus);
  const shortStatus = shortOutcomeStatus(outcome);
  const description = shortDescription(label);
  const title = compactJobTitle({ id, shortStatus, exitCode, description, fallback });
  const startedAt = finite(meta?.startedAt) ?? finite(meta?.jobStartedAt);
  const finishedAt = finite(meta?.finishedAt);
  // 一条通知自身不带耗时；只有 details 明确给了首尾才算，不从通知时间倒推。
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined && outcome !== 'running'
      ? Math.max(0, finishedAt - startedAt)
      : undefined;

  return {
    ...(id ? { id } : {}),
    ...(kind ? { kind } : {}),
    label,
    description,
    outcome,
    ...(rawStatus ? { rawStatus } : {}),
    shortStatus,
    statusText,
    tone: outcomeTone(outcome),
    glyph: outcomeGlyph(outcome),
    title,
    ...(detailRaw ? { detailRaw } : {}),
    ...(rawDetail ? { detail: rawDetail } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(instruction ? { instruction } : {}),
    ...(remaining.length ? { extra: remaining.join('\n').trim() } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** 通知 details 里若带了任务开始时间，可以直接跟随 jobLiveStore；当前生产方只给 jobId。 */
export function jobNoticeRef(details: unknown): { jobId: string; jobStartedAt: number } | null {
  const meta = record(details);
  const jobId = text(meta?.jobId);
  const startedAt = finite(meta?.jobStartedAt) ?? finite(meta?.startedAt);
  return jobId && startedAt !== undefined ? { jobId, jobStartedAt: startedAt } : null;
}

/**
 * 从 live store 里认领这条通知对应的 job：进程内 id 会跨重启复用，所以同一个 id 可能有多条。
 * 优先取「通知时刻之前、已结算」的那条；没有就取通知之前的最近一条；都没有时间依据时取最近一次。
 */
export function pickJobEntry(
  entries: Record<string, JobLiveEntry>,
  jobId: string | undefined,
  timestamp?: number,
): JobLiveEntry | undefined {
  if (!jobId) return undefined;
  const matches = Object.values(entries).filter((entry) => entry.job?.id === jobId);
  if (matches.length === 0) return undefined;
  const settled = matches.filter((entry) => entry.job !== undefined && entry.job.status !== 'running' && entry.job.status !== 'stopping');
  const pool = settled.length > 0 ? settled : matches;
  const beforeTime = timestamp !== undefined && Number.isFinite(timestamp)
    ? pool.filter((entry) => (entry.job?.startedAt ?? 0) <= timestamp)
    : pool;
  const usable = beforeTime.length > 0 ? beforeTime : pool;
  return usable.reduce((latest, entry) =>
    (entry.job?.startedAt ?? 0) > (latest.job?.startedAt ?? 0) ? entry : latest,
  );
}

export type JobLiveFacts = Pick<JobLiveView, 'status' | 'startedAt'> &
  Partial<Pick<JobLiveView, 'detail' | 'label' | 'finishedAt'>>;

/** 快照比通知更接近事实（它有终态原因、起止时间和真实状态），但迟到的运行中快照不能把已结算的通知退回运行。 */
export function applyJobLive(model: JobNoticeModel, live: JobLiveFacts | undefined): JobNoticeModel {
  if (!live) return model;
  if (isTerminalOutcome(model.outcome) && (live.status === 'running' || live.status === 'stopping')) {
    return { ...model, liveNote: `任务快照仍显示${live.status === 'stopping' ? '正在停止' : '运行中'}，以通知的终态为准` };
  }
  const detailRaw = live.detail ?? model.detailRaw;
  const exitCode = exitCodeOf(detailRaw);
  const outcome = jobOutcome(live.status, detailRaw, exitCode);
  const label = live.label ?? model.label;
  const statusText = outcomeStatusText(outcome, exitCode, live.status);
  const shortStatus = shortOutcomeStatus(outcome);
  const description = shortDescription(label) || model.description;
  const startedAt = live.startedAt ?? model.startedAt;
  const finishedAt = live.finishedAt ?? model.finishedAt;
  const durationMs =
    startedAt !== undefined && finishedAt !== undefined && outcome !== 'running'
      ? Math.max(0, finishedAt - startedAt)
      : model.durationMs;
  const detail = translateJobDetail(detailRaw);
  return {
    ...model,
    outcome,
    ...(live.status ? { rawStatus: live.status } : {}),
    statusText,
    shortStatus,
    description,
    tone: outcomeTone(outcome),
    glyph: outcomeGlyph(outcome),
    title: compactJobTitle({ id: model.id, shortStatus, exitCode, description, fallback: model.title }),
    ...(detailRaw ? { detailRaw } : {}),
    ...(detail ? { detail } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    liveNote: undefined,
  };
}

/**
 * 通知 details 里只有 jobId，没有任务开始时间；同一进程内 id 会跨重启复用，快照必须带 startedAt。
 * 真正的开始时间留在原 bash 工具结果的 details.jobStartedAt 里，这里按 jobId 找回。
 * 有通知时间时只认通知之前开始的那次（迟到的旧 job 快照不冒充）。
 */
export function findJobStartedAt(
  messages: readonly { kind: string; result?: unknown }[],
  jobId: string | undefined,
  before?: number,
): number | undefined {
  if (!jobId) return undefined;
  const starts: number[] = [];
  for (const message of messages) {
    if (message.kind !== 'tool') continue;
    const details = record((message.result as { details?: unknown } | undefined)?.details);
    if (details?.jobId !== jobId) continue;
    const startedAt = finite(details.jobStartedAt);
    if (startedAt !== undefined) starts.push(startedAt);
  }
  if (starts.length === 0) return undefined;
  const beforeTime = before !== undefined && Number.isFinite(before) ? starts.filter((start) => start <= before) : starts;
  const pool = beforeTime.length > 0 ? beforeTime : starts;
  return Math.max(...pool);
}

/** 快照里还留着的输出；开头被截掉时把缺口和完整日志说清楚。 */
export function jobOutputText(entry: JobLiveEntry): { text: string; lossyNote?: string } {
  if (!entry.lossy) return { text: entry.text };
  const spill = entry.spillPaths?.[0];
  return {
    text: entry.text,
    lossyNote: `前面的输出已不在内存${spill ? `，完整日志：${spill}` : ''}`,
  };
}

/** 只展示可确认的耗时，并沿用现有 bash 卡片的格式。 */
export function durationLabel(durationMs: number | undefined): string | undefined {
  return durationMs !== undefined && Number.isFinite(durationMs) ? formatRunDuration(durationMs) : undefined;
}

const SUBAGENT_ID = /^Background subagent (\S+)/;

function subagentOutcomeOf(stopReason: string | undefined, diagnostic: string | undefined): TaskOutcome {
  switch (stopReason?.toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return isTimeoutText(diagnostic) ? 'timeout' : 'aborted';
    case 'error':
      return isTimeoutText(diagnostic) ? 'timeout' : 'failed';
    case 'max-tokens':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'unknown';
  }
}

/** 英文诊断开头的固定说法换成中文；具体原因（报错原文、超时秒数）原样保留。 */
export function translateDiagnostic(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const idle = /^idle timeout:\s*([\s\S]*)$/i.exec(value);
  if (idle) return `空闲超时：${idle[1]}`;
  const startup = /^startup timeout:\s*([\s\S]*)$/i.exec(value);
  if (startup) return `启动超时：${startup[1]}`;
  const hard = /^hard timeout after\s*([\s\S]*)$/i.exec(value);
  if (hard) return `硬超时：${hard[1]}`;
  const uncaught = /^uncaught error:\s*([\s\S]*)$/i.exec(value);
  if (uncaught) return `未捕获错误：${uncaught[1]}`;
  if (/^aborted$/i.test(value)) return '被中止';
  if (value === '(no output)') return '没有输出';
  return value;
}

export interface SubagentNoticeModel {
  childId?: string;
  stopReason?: string;
  outcome: TaskOutcome;
  statusText: string;
  tone: TaskTone;
  glyph: TaskGlyph;
  title: string;
  /** 子代理的收尾正文（真实对话内容，保留 markdown）。 */
  closing: string;
  /** 结算时没有收尾正文：如实说明，不补摘要。 */
  noClosing: boolean;
  diagnostic?: string;
  diagnosticText?: string;
  sessionPath?: string;
  /** 可继续 / 不可继续等投递事实。 */
  note?: string;
  extra?: string;
}

/** 每一行是否处在 ``` / ~~~ 围栏代码块里（含围栏行本身），用来避免把正文代码当官方附加行。 */
function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) {
        fence = marker[0];
        mask.push(true);
        continue;
      }
      mask.push(false);
      continue;
    }
    mask.push(true);
    if (marker !== undefined && marker[0] === fence) fence = undefined;
  }
  return mask;
}

/**
 * 解析 subagent-settled 通知（extensions/multi-agent/settlement-notice.ts）。
 * 首行英文摘要只用来在缺少 details 时兜底；正文和诊断分开显示。
 *
 * 关键边界：收尾正文是用户/子代理的原文，里面可能自带 `Its closing message:`、
 * `Diagnostic: timeout ...` 这样的行，甚至代码块。官方附加的诊断只在非 completed 时存在，
 * 并且整段追加在最后。所以：先定 stopReason → completed 不拆诊断；非 completed 从末尾找官方那行。
 */
export function parseSubagentSettled(content: string | undefined | null, details?: unknown): SubagentNoticeModel {
  const meta = record(details);
  const lines = sourceText(content).split('\n');
  const summary = (lines[0] ?? '').trim();
  const childId = text(meta?.childId) ?? SUBAGENT_ID.exec(summary)?.[1];
  const stopReason = text(meta?.stopReason);
  const sessionPath = text(meta?.sessionPath);

  // 没有结构化的 stopReason 时按真实摘要措辞兜底；认不出就是未知，不当成完成。
  const inferred = stopReason ?? (
    /was stopped before it finished/i.test(summary) ? 'aborted'
      : /failed before it finished/i.test(summary) ? 'error'
        : /finished\.?\s*$/i.test(summary) || /finished and will do no further work/i.test(summary) ? 'completed'
          : undefined
  );
  const settledCompleted = inferred?.trim().toLowerCase() === 'completed';

  // 官方 body 紧跟摘要：`Its closing message:` 或 `It left no closing message.` 在第 2 行。
  // 只认这个固定位置，正文里同名的行不当官方分隔。
  const closingMarker = lines[1]?.trim() === 'Its closing message:' ? 1 : -1;
  const bodyNoClosing = lines[1]?.trim() === 'It left no closing message.';

  // 官方诊断整段追加在末尾，所以从末尾找；completed 的结算是没有诊断段的。
  // 代码块里以 `Diagnostic: ` 开头的行是正文内容，不算官方附加。
  const inFence = fenceMask(lines);
  let diagnosticMarker = -1;
  if (!settledCompleted) {
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      if (inFence[i]) continue;
      if (lines[i].startsWith('Diagnostic: ')) {
        diagnosticMarker = i;
        break;
      }
    }
  }

  let closing = '';
  if (closingMarker >= 0) {
    const end = diagnosticMarker > closingMarker ? diagnosticMarker : lines.length;
    closing = lines.slice(closingMarker + 1, end).join('\n');
  }
  const noClosing = closingMarker < 0 || bodyNoClosing || !closing.trim();
  const diagnostic = diagnosticMarker >= 0
    ? [lines[diagnosticMarker].slice('Diagnostic: '.length), ...lines.slice(diagnosticMarker + 1)].join('\n').trim()
    : undefined;

  const outcome = subagentOutcomeOf(inferred, diagnostic);
  const statusText = outcomeStatusText(outcome);
  const title = childId ? `子代理 ${childId} ${statusText}` : summary || '子代理结算';

  let note: string | undefined;
  if (outcome === 'completed') {
    note = /unless you send it more/i.test(summary)
      ? '发消息给它还能接着做；否则不会再做任何事。'
      : /cannot receive further messages/i.test(summary)
        ? '它不能再接收消息。'
        : undefined;
  }

  const recognized = closingMarker >= 0 || bodyNoClosing || summary.length > 0;
  const extra = diagnosticMarker < 0 && closingMarker < 0 && !bodyNoClosing && recognized
    ? lines.slice(1).join('\n').trim() || undefined
    : undefined;

  return {
    ...(childId ? { childId } : {}),
    ...(inferred ? { stopReason: inferred } : {}),
    outcome,
    statusText,
    tone: outcomeTone(outcome),
    glyph: outcomeGlyph(outcome),
    title,
    closing,
    noClosing,
    ...(diagnostic ? { diagnostic, diagnosticText: translateDiagnostic(diagnostic) ?? diagnostic } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    ...(note ? { note } : {}),
    ...(extra ? { extra } : {}),
  };
}
