import { describe, expect, it } from 'vitest';
import { formatJobNotice } from '@extensions/jobs/notice';
import type { JobSnapshot } from '@extensions/jobs/types';
import { formatSettlementNotice } from '@extensions/multi-agent/settlement-notice';
import {
  applyJobLive,
  durationLabel,
  parseJobNotice,
  parseSubagentSettled,
  pickJobEntry,
} from './taskNoticeModel';
import type { JobLiveEntry } from '../../stores/jobLiveStore';

const jobSnap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: 'bash-3',
  kind: 'bash',
  label: 'npm test',
  owner: 's1',
  workspace: '/ws',
  status: 'completed',
  startedAt: 0,
  finishedAt: 1,
  reported: false,
  outputLimitBytes: 64,
  ring: { total: 0, earliest: 0 },
  ...over,
});

const entry = (jobId: string, startedAt: number, over: Partial<JobLiveEntry> = {}): JobLiveEntry => ({
  state: 'live',
  job: {
    id: jobId,
    kind: 'bash',
    label: 'npm test',
    owner: 's1',
    workspace: '/ws',
    status: 'completed',
    detail: 'exit code: 0',
    startedAt,
    finishedAt: startedAt + 520_000,
  },
  text: '524 passed\n',
  next: 10,
  lossy: false,
  ...over,
});

describe('parseJobNotice', () => {
  it('reads a real completed job notice without claiming more than the exit code', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })));
    expect(model).toMatchObject({
      id: 'bash-3',
      kind: 'bash',
      label: 'npm test',
      outcome: 'completed',
      statusText: '已完成',
      tone: 'ok',
      title: '后台任务 bash-3 已完成 · npm test',
    });
    expect(model.detail).toBe('退出码 0');
    expect(model.instruction).toBe('完整输出需用 job_output 读取。');
  });

  it('treats a non-zero exit as a failure but keeps the real code', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 2' })));
    expect(model).toMatchObject({ outcome: 'failed', statusText: '失败 · 退出码 2', shortStatus: '失败', tone: 'error', exitCode: 2 });
    expect(model.title).toBe('后台任务 bash-3 失败 · 退出码 2 · npm test');
  });

  it('turns sandbox markers into a Chinese fact instead of the model-facing marker', () => {
    const model = parseJobNotice(
      formatJobNotice(jobSnap({ detail: 'exit code: 1; [sandbox: file access denied under read-only mode]' })),
    );
    expect(model.outcome).toBe('failed');
    expect(model.detail).toBe('退出码 1；沙箱拒绝（只读）');
    expect(model.detail).not.toContain('[sandbox:');
  });

  it('separates user cancellation from a plain kill and from unknown states', () => {
    const cancelled = parseJobNotice(
      formatJobNotice(jobSnap({ status: 'killed', detail: 'killed before exit; cancelled by the user' })),
    );
    expect(cancelled).toMatchObject({ outcome: 'cancelled', statusText: '已取消', tone: 'warn' });
    expect(cancelled.detail).toBe('进程在退出前被停止；用户停止');

    const killed = parseJobNotice(formatJobNotice(jobSnap({ status: 'killed', detail: 'killed before exit' })));
    expect(killed).toMatchObject({ outcome: 'killed', statusText: '已终止' });

    const unknown = parseJobNotice(formatJobNotice(jobSnap({ status: 'paused' as JobSnapshot['status'] })));
    expect(unknown).toMatchObject({ outcome: 'unknown', statusText: '状态未知（未确认完成）', tone: 'warn' });
    expect(unknown.title).toContain('状态未知');
    expect(unknown.title).not.toContain('已完成');
  });

  it('never counts a still-running snapshot as finished', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ status: 'running' })));
    expect(model).toMatchObject({ outcome: 'running', statusText: '仍在运行', tone: 'neutral' });
    expect(model.title).not.toContain('已完成');
  });

  it('does not classify timeout file names in diagnostics as task deadlines', () => {
    const failedJob = parseJobNotice(formatJobNotice(jobSnap({ status: 'failed', detail: 'Assertion failed in fixtures/timeout.test.ts: expected 1' })));
    expect(failedJob.outcome).toBe('failed');
    const failedChild = parseSubagentSettled(formatSettlementNotice({ childId: 'sa-file', stopReason: 'error', output: '部分结果', diagnostic: 'Assertion failed in fixtures/timeout.test.ts: expected 1' }).content, { childId: 'sa-file', stopReason: 'error' });
    expect(failedChild.outcome).toBe('failed');
  });

  it('distinguishes a timeout from an ordinary failure', () => {
    const model = parseJobNotice(
      formatJobNotice(jobSnap({ status: 'failed', detail: 'idle timeout: no activity for 300s' })),
    );
    expect(model).toMatchObject({ outcome: 'timeout', statusText: '已超时', tone: 'warn' });
    expect(model.detail).toBe('空闲超时：no activity for 300s');
  });

  it('prefers structured details over the English head line', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })), {
      jobId: 'bash-9',
      kind: 'bash',
      status: 'killed',
      detail: 'killed before exit; cancelled by the user',
    });
    expect(model).toMatchObject({ id: 'bash-9', outcome: 'cancelled', statusText: '已取消' });
    expect(model.label).toBe('npm test');
  });

  it('keeps legacy history readable and marks missing structure as unknown', () => {
    const legacy = parseJobNotice('Background job bash-7 (bash: cargo build) finished completed.\nsome extra line');
    expect(legacy).toMatchObject({ id: 'bash-7', outcome: 'completed', label: 'cargo build' });
    expect(legacy.extra).toBe('some extra line');

    const foreign = parseJobNotice('something else entirely');
    expect(foreign).toMatchObject({ outcome: 'unknown', tone: 'warn', title: 'something else entirely' });
  });

  it('ignores malformed details without throwing', () => {
    expect(parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })), { jobId: 42, status: ['x'] })).toMatchObject({
      id: 'bash-3',
      outcome: 'completed',
    });
    expect(parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })), 'nonsense')).toMatchObject({
      outcome: 'completed',
    });
  });
});

describe('applyJobLive', () => {
  it('takes the finished snapshot duration, label and output facts', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ label: 'npm test', detail: 'exit code: 0' })));
    const next = applyJobLive(model, {
      status: 'completed',
      detail: 'exit code: 0',
      label: 'npm test',
      startedAt: 1_000,
      finishedAt: 521_000,
    });
    expect(next).toMatchObject({ outcome: 'completed', startedAt: 1_000, finishedAt: 521_000, durationMs: 520_000 });
  });

  it('uses the snapshot status and detail when they disagree with the notice', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })));
    const next = applyJobLive(model, {
      status: 'killed',
      detail: 'killed before exit; cancelled by the user',
      startedAt: 1,
      finishedAt: 2,
    });
    expect(next).toMatchObject({ outcome: 'cancelled', statusText: '已取消' });
    expect(next.detail).toBe('进程在退出前被停止；用户停止');
  });

  it('does not let a lagging running snapshot undo a settlement', () => {
    const model = parseJobNotice(formatJobNotice(jobSnap({ detail: 'exit code: 0' })));
    const next = applyJobLive(model, { status: 'running', startedAt: 1 });
    expect(next.outcome).toBe('completed');
    expect(next.liveNote).toContain('运行中');
    expect(next.durationMs).toBeUndefined();
  });
});

describe('pickJobEntry', () => {
  it('only accepts the entry for this job id, preferring the settled one before the notice time', () => {
    const entries: Record<string, JobLiveEntry> = {
      'bash-2@1': entry('bash-2', 1),
      'bash-2@50': entry('bash-2', 50),
      'bash-2@900': entry('bash-2', 900),
    };
    expect(pickJobEntry(entries, 'bash-2', 100)?.job?.startedAt).toBe(50);
    expect(pickJobEntry(entries, 'bash-9')).toBeUndefined();
    expect(pickJobEntry(entries, undefined)).toBeUndefined();
  });

  it('returns the only live entry when it has not settled yet, instead of pretending it is gone', () => {
    const running = entry('bash-4', 10, { job: { ...entry('bash-4', 10).job!, status: 'running', finishedAt: undefined } });
    expect(pickJobEntry({ 'bash-4@10': running }, 'bash-4')?.job?.status).toBe('running');
  });
});

describe('parseSubagentSettled', () => {
  it('reads the real completed settlement: closing message and continuation hint', () => {
    const notice = formatSettlementNotice({
      childId: 'sa-1',
      stopReason: 'completed',
      output: '## 结果\n\n**三条**用例已修复。',
    });
    const model = parseSubagentSettled(notice.content, { childId: 'sa-1', stopReason: 'completed' });
    expect(model).toMatchObject({
      childId: 'sa-1',
      outcome: 'completed',
      statusText: '已完成',
      tone: 'ok',
      title: '子代理 sa-1 已完成',
      noClosing: false,
    });
    expect(model.closing).toBe('## 结果\n\n**三条**用例已修复。');
    expect(model.note).toContain('还能接着做');
  });

  it('separates the diagnostic from the closing message', () => {
    const notice = formatSettlementNotice({
      childId: 'sa-2',
      stopReason: 'error',
      output: 'partial work',
      diagnostic: 'uncaught error: boom',
    });
    const model = parseSubagentSettled(notice.content, { childId: 'sa-2', stopReason: 'error' });
    expect(model).toMatchObject({ outcome: 'failed', statusText: '失败', tone: 'error' });
    expect(model.closing).toBe('partial work');
    expect(model.diagnostic).toBe('uncaught error: boom');
  });

  it('marks a settlement without a closing message explicitly', () => {
    const notice = formatSettlementNotice({ childId: 'sa-3', stopReason: 'completed', output: '   ' });
    expect(parseSubagentSettled(notice.content).noClosing).toBe(true);
  });

  it('distinguishes aborted, timeout and token-limit settlements', () => {
    const aborted = parseSubagentSettled(
      formatSettlementNotice({ childId: 'sa-4', stopReason: 'aborted', output: '' }).content,
      { childId: 'sa-4', stopReason: 'aborted' },
    );
    expect(aborted).toMatchObject({ outcome: 'aborted', statusText: '会话已中止', tone: 'warn' });

    const timedOut = parseSubagentSettled(
      formatSettlementNotice({
        childId: 'sa-5',
        stopReason: 'aborted',
        output: '',
        diagnostic: 'idle timeout: no activity for 300s',
      }).content,
      { childId: 'sa-5', stopReason: 'aborted' },
    );
    expect(timedOut).toMatchObject({ outcome: 'timeout', statusText: '已超时' });
    expect(timedOut.diagnostic).toBe('idle timeout: no activity for 300s');

    const capped = parseSubagentSettled('', { childId: 'sa-6', stopReason: 'max-tokens' });
    expect(capped).toMatchObject({ outcome: 'max-tokens', statusText: '已结束（达到 token 上限）' });
  });

  it('does not turn an unknown stop reason into completion', () => {
    const unknown = parseSubagentSettled('Background subagent sa-7', { childId: 'sa-7', stopReason: 'paused' });
    expect(unknown).toMatchObject({ outcome: 'unknown', statusText: '状态未知（未确认完成）', tone: 'warn' });
    expect(unknown.title).not.toContain('已完成');
  });

  it('falls back to the notice phrases when details are missing, and stays honest otherwise', () => {
    const stopped = parseSubagentSettled(
      'Background subagent sa-8 was stopped before it finished.\nIt left no closing message.',
    );
    expect(stopped).toMatchObject({ childId: 'sa-8', outcome: 'aborted', noClosing: true });

    const failed = parseSubagentSettled('Background subagent sa-9 failed before it finished.');
    expect(failed.outcome).toBe('failed');

    const bare = parseSubagentSettled('Background subagent sa-10');
    expect(bare).toMatchObject({ outcome: 'unknown', childId: 'sa-10' });
  });

  it('accepts an empty body with structured identity without crashing', () => {
    const model = parseSubagentSettled('', { childId: 'sa-11', stopReason: 'completed' });
    expect(model).toMatchObject({ childId: 'sa-11', outcome: 'completed', title: '子代理 sa-11 已完成' });
  });
});

describe('parseSubagentSettled · closing body boundaries', () => {
  it('does not split a completed closing message that itself contains Diagnostic / closing markers', () => {
    const body = [
      '修复完成。',
      '',
      'Diagnostic: timeout in test fixture (this is quoted output, not the settlement reason)',
      'Its closing message:',
      '```ts',
      'const diagnostic = "Diagnostic: fake";',
      '```',
    ].join('\n');
    const notice = formatSettlementNotice({ childId: 'sa-20', stopReason: 'completed', output: body });
    const model = parseSubagentSettled(notice.content);
    expect(model.outcome).toBe('completed');
    expect(model.diagnostic).toBeUndefined();
    expect(model.closing).toBe(body);
  });

  it('takes the official appended diagnostic (last marker) and keeps the whole partial output', () => {
    const output = 'partial work\nDiagnostic: quoted line inside output\nstill writing';
    const notice = formatSettlementNotice({
      childId: 'sa-21',
      stopReason: 'error',
      output,
      diagnostic: 'uncaught error: boom',
    });
    const model = parseSubagentSettled(notice.content);
    expect(model.outcome).toBe('failed');
    expect(model.closing).toBe(output);
    expect(model.diagnostic).toBe('uncaught error: boom');
  });

  it('does not mislabel a completed settlement as timeout because of words in the body', () => {
    const notice = formatSettlementNotice({
      childId: 'sa-22',
      stopReason: 'completed',
      output: 'idle timeout handling was the root cause; fixed.',
    });
    expect(parseSubagentSettled(notice.content).outcome).toBe('completed');
  });

  it('does not treat a code block mentioning Diagnostic as a real diagnostic on failure', () => {
    const output = '```\nDiagnostic: sample from docs\n```\nstill broken';
    const notice = formatSettlementNotice({ childId: 'sa-23', stopReason: 'error', output });
    const model = parseSubagentSettled(notice.content);
    expect(model.closing).toBe(output);
    expect(model.diagnostic).toBeUndefined();
  });

  it('tolerates missing legacy content instead of throwing', () => {
    expect(parseSubagentSettled(undefined, { childId: 'sa-24', stopReason: 'completed' }).childId).toBe('sa-24');
    expect(parseJobNotice(null).outcome).toBe('unknown');
  });
});

describe('durationLabel', () => {
  it('uses the existing bash duration format and omits unknown durations', () => {
    expect(durationLabel(3_500)).toBe('4s');
    expect(durationLabel(4_000)).toBe('4s');
    expect(durationLabel(620_000)).toBe('10m20s');
    expect(durationLabel(undefined)).toBeUndefined();
  });
});
