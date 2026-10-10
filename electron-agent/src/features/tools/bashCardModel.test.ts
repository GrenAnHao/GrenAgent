import { describe, expect, it } from 'vitest';
import { escalationHintMarker, runnerFailedMarker, sandboxDenialMarker } from '@extensions/_shared/sandbox/facts';
import {
  bashJobRef,
  bashRowSummary,
  bashSandboxFacts,
  bashSandboxMeta,
  bashSandboxNote,
  foregroundJobRef,
  formatRunDuration,
  jobFooterText,
  jobRowStatus,
  jobTiming,
  terminalCommandHead,
  terminalCommandLines,
  terminalCopyText,
  terminalOutputEmpty,
  terminalPromptLabel,
} from './bashCardModel';

describe('bashRowSummary', () => {
  it('prefers the UI description over the raw command', () => {
    expect(
      bashRowSummary({
        command: 'Get-Date -Format yyyy-MM-dd',
        description: 'Show current local date',
      }),
    ).toBe('Show current local date');
  });

  it('falls back to 执行命令 when description is missing, never the raw command', () => {
    expect(bashRowSummary({ command: 'echo hi' })).toBe('执行命令');
  });

  it('treats blank description as missing', () => {
    expect(bashRowSummary({ command: 'pwd', description: '   ' })).toBe('执行命令');
  });
});

describe('terminalPromptLabel', () => {
  it('uses the last path segment', () => {
    expect(terminalPromptLabel('/ws/demo')).toBe('demo');
    expect(terminalPromptLabel('D:\\repo\\测试')).toBe('测试');
  });

  it('uses $ when the last segment is a work-folder UUID', () => {
    expect(terminalPromptLabel('C:\\Users\\rxstudio\\.pi\\agent\\works\\544ff658-8429-4084-9a24-cd49ffbe7419')).toBe('$');
  });
});

describe('terminalCommandLines', () => {
  it('splits a multi-line command and drops a trailing newline', () => {
    expect(terminalCommandLines('a\nb\n')).toEqual(['a', 'b']);
  });
});

describe('terminalCommandHead', () => {
  it('keeps a one-line command as is', () => {
    expect(terminalCommandHead('Get-Date')).toBe('Get-Date');
  });

  it('shows only the first line of a multi-line command and marks the rest', () => {
    expect(terminalCommandHead('cd extensions\nnpx vitest run\n')).toBe('cd extensions …');
  });

  it('does not mark a lone trailing newline', () => {
    expect(terminalCommandHead('git status\n')).toBe('git status');
  });
});

describe('terminalCopyText', () => {
  const command = 'cd extensions\nnpx vitest run\n';
  const output = ' RUN  v4\n Tests  3 passed\n';

  it('copies the raw command without the trailing newline', () => {
    expect(terminalCopyText('command', command, output)).toBe('cd extensions\nnpx vitest run');
  });

  it('copies the output as shown', () => {
    expect(terminalCopyText('output', command, output)).toBe(output);
    expect(terminalCopyText('output', command, undefined)).toBe('');
  });

  it('copies prompt lines followed by the output', () => {
    expect(terminalCopyText('all', command, output)).toBe(
      '$ cd extensions\n$ npx vitest run\n RUN  v4\n Tests  3 passed\n',
    );
  });

  it('copies only the prompt lines when there is no output yet', () => {
    expect(terminalCopyText('all', 'Get-Date', '')).toBe('$ Get-Date');
  });
});

describe('terminalOutputEmpty', () => {
  it('treats missing and whitespace-only output as empty', () => {
    expect(terminalOutputEmpty(undefined)).toBe(true);
    expect(terminalOutputEmpty('  \n')).toBe(true);
    expect(terminalOutputEmpty('ok')).toBe(false);
  });
});

describe('foregroundJobRef', () => {
  const ref = { jobId: 'bash-7', jobStartedAt: 1_700 };

  it('运行中的 partial 结果里读出匠名前台任务的引用', () => {
    expect(foregroundJobRef({ content: [], details: { foregroundJob: ref } })).toEqual(ref);
  });

  it('没有引用、形状不对时是 null，不把后台任务的 jobId 当成匠名引用', () => {
    expect(foregroundJobRef(undefined)).toBeNull();
    expect(foregroundJobRef({ content: [] })).toBeNull();
    expect(foregroundJobRef({ details: { foregroundJob: { jobId: '', jobStartedAt: 1 } } })).toBeNull();
    expect(foregroundJobRef({ details: { foregroundJob: { jobId: 'bash-7' } } })).toBeNull();
    // 转后台 / run_in_background 的结果是另一个字段，归 bashJobRef 管。
    expect(foregroundJobRef({ details: { jobId: 'bash-7', jobStartedAt: 1 } })).toBeNull();
    expect(bashJobRef({ details: { foregroundJob: ref } })).toBeNull();
  });
});

describe('jobRowStatus', () => {
  it('后台任务还在跑时，行是 running，即使工具调用本身早已返回', () => {
    expect(jobRowStatus('done', { status: 'running' })).toBe('running');
    expect(jobRowStatus('done', { status: 'stopping' })).toBe('running');
  });

  it('失败、被停止、非零退出是 error', () => {
    expect(jobRowStatus('done', { status: 'failed' })).toBe('error');
    expect(jobRowStatus('done', { status: 'killed' })).toBe('error');
    expect(jobRowStatus('done', { status: 'completed', detail: 'exit code: 2' })).toBe('error');
  });

  it('正常结束沿用工具调用本身的状态', () => {
    expect(jobRowStatus('done', { status: 'completed', detail: 'exit code: 0' })).toBe('done');
    expect(jobRowStatus('done', { status: 'completed' })).toBe('done');
  });

  it('任务还没取到（快照在路上、已不在）时沿用工具调用本身的状态', () => {
    expect(jobRowStatus('done', undefined)).toBe('done');
    expect(jobRowStatus('error', undefined)).toBe('error');
  });
});

describe('jobTiming', () => {
  it('在跑：从任务开始起算，还在自增', () => {
    expect(jobTiming({ status: 'running', startedAt: 1_000 })).toEqual({ startedAt: 1_000, running: true });
  });

  it('结束：定格在任务自己的耗时', () => {
    expect(jobTiming({ status: 'completed', startedAt: 1_000, finishedAt: 521_000 })).toEqual({
      startedAt: 1_000,
      running: false,
      durationMs: 520_000,
    });
  });

  it('结束但没有结束时间：不编一个时长', () => {
    expect(jobTiming({ status: 'killed', startedAt: 1_000 })).toEqual({ startedAt: 1_000, running: false });
  });
});

describe('formatRunDuration', () => {
  it('keeps sub-minute runs in seconds', () => {
    expect(formatRunDuration(0)).toBe('0s');
    expect(formatRunDuration(9_600)).toBe('10s');
    expect(formatRunDuration(59_400)).toBe('59s');
  });

  it('spells minutes with the remaining seconds', () => {
    expect(formatRunDuration(80_000)).toBe('1m20s');
    expect(formatRunDuration(120_000)).toBe('2m');
    expect(formatRunDuration(3_540_000)).toBe('59m');
  });

  it('drops to hours + minutes past an hour', () => {
    expect(formatRunDuration(3_600_000)).toBe('1h');
    expect(formatRunDuration(3_900_000)).toBe('1h5m');
  });
});

describe('bash sandbox facts', () => {
  const result = (sandbox: unknown) => ({ content: [], details: { sandbox } });

  it('reads details.sandbox and drops malformed fields', () => {
    expect(bashSandboxFacts(result({ mode: 'read-only', denied: true }))).toEqual({ mode: 'read-only', denied: true });
    expect(bashSandboxFacts(result({ mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' }))).toEqual({
      mode: 'workspace-write',
      denied: false,
      escalatedFrom: 'read-only',
    });
    expect(bashSandboxFacts(result({ mode: 'root', denied: true }))).toBeNull();
    expect(
      bashSandboxFacts(result({ mode: 'read-only', denied: false, runnerFailed: 'weird', escalatedFrom: 7 })),
    ).toEqual({ mode: 'read-only', denied: false });
    expect(bashSandboxFacts({ content: [] })).toBeNull();
  });

  it('row meta: runner failure, then denial, then escalation', () => {
    expect(bashSandboxMeta({ mode: 'read-only', denied: false, runnerFailed: 'unavailable', detail: 'x' })).toBe('沙箱未启动');
    expect(bashSandboxMeta({ mode: 'read-only', denied: true })).toBe('沙箱拒绝 · 只读');
    expect(bashSandboxMeta({ mode: 'workspace-write', denied: true, escalatedFrom: 'read-only' })).toBe('沙箱拒绝 · 工作区写入');
    expect(bashSandboxMeta({ mode: 'danger-full-access', denied: false, escalatedFrom: 'workspace-write' })).toBe('已升权 · 完全权限');
    expect(bashSandboxMeta(null)).toBeUndefined();
  });

  it('footer note says what happened in plain words', () => {
    expect(bashSandboxNote({ mode: 'read-only', denied: false, runnerFailed: 'unavailable', detail: 'runner missing' })).toBe(
      '沙箱没有启动，命令没有执行：runner missing',
    );
    expect(bashSandboxNote({ mode: 'read-only', denied: false, runnerFailed: 'runner' })).toBe('沙箱没有启动，命令没有执行');
    expect(bashSandboxNote({ mode: 'read-only', denied: true })).toBe('沙箱拦下了文件访问（只读模式）');
    expect(bashSandboxNote({ mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' })).toBe(
      '本次已获批准，以工作区写入权限运行',
    );
    expect(bashSandboxNote(null)).toBeUndefined();
  });
});

describe('jobFooterText with sandbox notes', () => {
  it('a denied background job says so in Chinese instead of the model-facing markers', () => {
    const detail = `exit code: 1; ${sandboxDenialMarker('read-only')} ${escalationHintMarker()}`;
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail })).toBe('后台任务 bash-3 · 已结束，退出码 1 · 沙箱拒绝（只读）');
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail }, true)).toBe('已结束，退出码 1 · 沙箱拒绝（只读）');
  });

  it('a runner failure replaces the raw reason', () => {
    expect(
      jobFooterText({ id: 'bash-3', status: 'failed', detail: `${runnerFailedMarker('read-only')} runner missing` }),
    ).toBe('后台任务 bash-3 · 失败 · 沙箱没有启动，命令没有执行');
  });

  it('other details read as before', () => {
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail: 'exit code: 0' })).toBe('后台任务 bash-3 · 已完成');
    expect(jobFooterText({ id: 'bash-3', status: 'killed', detail: 'killed before exit; cancelled by the user' })).toBe(
      '后台任务 bash-3 · 已停止 · killed before exit; cancelled by the user',
    );
  });
});
