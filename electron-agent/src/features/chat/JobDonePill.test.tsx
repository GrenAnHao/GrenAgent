import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobFrame, JobLiveSnapshot } from '../../lib/pi';
import type { ChatMessage } from '../../stores/agentReducer';

const mocks = vi.hoisted(() => ({
  jobSnapshot: vi.fn(),
  jobKill: vi.fn(),
  frameHandler: undefined as undefined | ((p: { frames: JobFrame[] }) => void),
  messages: [] as ChatMessage[],
}));

vi.mock('../../lib/pi', () => ({
  pi: { jobSnapshot: mocks.jobSnapshot, jobKill: mocks.jobKill },
  onJobFrames: (handler: (p: { frames: JobFrame[] }) => void) => {
    mocks.frameHandler = handler;
    return Promise.resolve(() => {});
  },
}));

vi.mock('../../stores/AgentStoreContext', () => ({
  useOptionalAgentStoreContext: () => ({ store: { useStore: { getState: () => ({ messages: mocks.messages }), subscribe: () => () => {} } } }),
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

import { __resetJobLiveForTest } from '../../stores/jobLiveStore';
import { JobDonePill, jobNoticeHead, jobNoticeTitle } from './JobDonePill';
import { parseJobNotice } from './taskNoticeModel';

/** 原 bash 工具结果：只有它带着 jobStartedAt（通知的 details 里没有）。 */
const bashResult = (jobId: string, jobStartedAt: number): ChatMessage =>
  ({
    kind: 'tool',
    id: `t-${jobId}`,
    toolCallId: `c-${jobId}`,
    toolName: 'bash',
    args: { command: 'npm test', run_in_background: true },
    result: { content: [], details: { background: true, jobId, jobStartedAt } },
    status: 'done',
  }) as ChatMessage;

const snapshot = (over: Partial<JobLiveSnapshot> = {}): JobLiveSnapshot => ({
  job: {
    id: 'bash-1',
    kind: 'bash',
    label: 'npm test',
    owner: 's1',
    workspace: '/ws',
    status: 'completed',
    detail: 'exit code: 0',
    startedAt: 100,
    finishedAt: 620_100,
  },
  text: 'RUN v4.1.11\n✓ 524 passed\n',
  next: 30,
  lossy: false,
  ...over,
});

beforeEach(() => {
  __resetJobLiveForTest();
  mocks.jobSnapshot.mockReset();
  mocks.frameHandler = undefined;
  mocks.messages = [];
});

afterEach(() => cleanup());

const notice = (status: string, detail = 'exit code: 0', label = 'npm test') =>
  `Background job bash-1 (bash: ${label}) finished ${status}.\n[status: ${status}, ${detail}]\nRead its output with job_output.`;

const expand = (testId = 'job-done-pill') => fireEvent.click(screen.getByTestId(`${testId}-head`));

describe('jobNoticeTitle', () => {
  it('keeps the old export working for model-facing heads', () => {
    expect(jobNoticeTitle('Background job subagent-1 (subagent: L) finished completed.')).toBe(
      '后台任务 subagent-1 已完成 · L',
    );
    expect(jobNoticeHead.exec('Background job bash-2 (bash: npm test) finished completed.')?.[1]).toBe('bash-2');
  });
});

describe('JobDonePill · compact header', () => {
  it('shows the real terminal state and short task description in a collapsed single row', () => {
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', kind: 'bash', status: 'completed' }} />);
    const pill = screen.getByTestId('job-done-pill');
    expect(pill.getAttribute('data-state')).toBe('closed');
    expect(pill.textContent).toContain('后台任务 bash-1 已完成 · npm test');
    expect(pill.textContent).not.toContain('已注入上下文');
    expect(pill.getAttribute('data-outcome')).toBe('completed');
    expect(pill.getAttribute('data-tone')).toBe('ok');
    // 关键缺失事实要能进展开区，但收起时不出现整段说明。
    expect(screen.queryByTestId('job-done-unresolved')).toBeNull();
  });

  it('toggles the detail section open and closed', () => {
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} />);
    expand();
    expect(screen.getByTestId('job-done-pill').getAttribute('data-state')).toBe('open');
    expect(screen.getByTestId('job-done-unresolved').textContent).toContain('取不到留存输出');
    expand();
    expect(screen.getByTestId('job-done-pill').getAttribute('data-state')).toBe('closed');
    expect(screen.queryByTestId('job-done-unresolved')).toBeNull();
  });

  it('puts the failure and exit code in the header instead of the body', () => {
    render(<JobDonePill content={notice('completed', 'exit code: 2')} details={{ jobId: 'bash-1', status: 'completed' }} />);
    const pill = screen.getByTestId('job-done-pill');
    expect(pill.getAttribute('data-outcome')).toBe('failed');
    expect(screen.getByTestId('task-notice-title').textContent).toBe('后台任务 bash-1 失败 · 退出码 2 · npm test');
    // 头部只写一次：没有单独的状态列。
    expect(screen.queryByTestId('task-notice-status')).toBeNull();
    expand();
    // 纯退出码已经在头部标题里，展开体不重复同句。
    expect(screen.queryByTestId('job-done-detail')).toBeNull();
  });

  it('shortens a long task label in the header but keeps the identity and state', () => {
    const long = 'npm run build --workspace @scope/very-long-package-name && node scripts/verify-production-bundle.js --strict';
    render(
      <JobDonePill
        content={notice('completed', 'exit code: 0', long)}
        details={{ jobId: 'bash-1', status: 'completed' }}
      />,
    );
    const title = screen.getByTestId('task-notice-title').textContent ?? '';
    expect(title.startsWith('后台任务 bash-1 已完成 · ')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThan(70);
  });

  it('distinguishes user cancellation, termination and timeouts', () => {
    const view = (content: string) => {
      const status = /finished (\w+)\./.exec(content)?.[1];
      const { unmount } = render(<JobDonePill content={content} details={{ jobId: 'bash-1', status }} />);
      const pill = screen.getByTestId('job-done-pill');
      const title = screen.getByTestId('task-notice-title').textContent ?? '';
      expand();
      const detail = screen.getByTestId('job-done-detail').textContent ?? '';
      const result = { outcome: pill.getAttribute('data-outcome'), title, detail };
      unmount();
      return result;
    };
    expect(view(notice('killed', 'killed before exit; cancelled by the user'))).toMatchObject({
      outcome: 'cancelled',
      title: '后台任务 bash-1 已取消 · npm test',
      detail: '终态原因：进程在退出前被停止；用户停止',
    });
    expect(view(notice('killed', 'killed before exit'))).toMatchObject({
      outcome: 'killed',
      title: '后台任务 bash-1 已终止 · npm test',
    });
    const timedOut = view(notice('failed', 'idle timeout: no activity for 300s'));
    expect(timedOut.outcome).toBe('timeout');
    expect(timedOut.title).toBe('后台任务 bash-1 已超时 · npm test');
    expect(timedOut.detail).toContain('空闲超时');
  });

  it('never shows an unknown status as completed', () => {
    render(<JobDonePill content={notice('paused')} details={{ jobId: 'bash-1', status: 'paused' }} />);
    const pill = screen.getByTestId('job-done-pill');
    expect(pill.getAttribute('data-outcome')).toBe('unknown');
    expect(screen.getByTestId('task-notice-title').textContent).toContain('状态未知');
    expect(pill.textContent).not.toContain('已完成');
  });

  it('turns sandbox markers in the reason into Chinese facts after expanding', () => {
    render(
      <JobDonePill
        content={notice('completed', 'exit code: 1; [sandbox: file access denied under read-only mode]')}
        details={{ jobId: 'bash-1', status: 'completed' }}
      />,
    );
    expand();
    const detail = screen.getByTestId('job-done-detail').textContent ?? '';
    expect(detail).toContain('沙箱拒绝（只读）');
    expect(detail).not.toContain('[sandbox:');
  });

  it('keeps legacy history readable when details are missing', () => {
    render(<JobDonePill content={'Background job bash-7 (bash: cargo build) finished failed.\n[status: failed]'} />);
    expect(screen.getByTestId('task-notice-title').textContent).toBe('后台任务 bash-7 失败 · cargo build');
  });

  it('does not invent an identity for an unparseable notice', () => {
    render(<JobDonePill content="something else" />);
    const pill = screen.getByTestId('job-done-pill');
    expect(pill.getAttribute('data-outcome')).toBe('unknown');
    // 认不出的正文原样当标题；但空正文无 id 时仍有可读头。
    expect(screen.getByTestId('task-notice-title').textContent).toBe('something else');
    expect(parseJobNotice('').title).toBe('后台任务 · 状态未知');
    expect(parseJobNotice(undefined).title).toBe('后台任务 · 状态未知');
  });

  it('never prints the model-only job_output instruction', () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(null);
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    expand();
    expect(screen.getByTestId('job-done-pill').textContent).not.toContain('job_output');
  });
});

describe('JobDonePill · job snapshot resolution', () => {
  it('reads the retained output and real duration from job_snapshot', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(snapshot());
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    await waitFor(() => expect(screen.getByTestId('task-notice-duration')).toBeTruthy());
    expect(mocks.jobSnapshot).toHaveBeenCalledWith('bash-1', 100);
    expect(screen.getByTestId('task-notice-duration').textContent).toBe('10m20s');
    expect(screen.queryByTestId('job-done-output')).toBeNull();
    expand();
    expect(screen.getByTestId('job-done-output').textContent).toContain('524 passed');
    expect(screen.queryByTestId('job-done-detail')).toBeNull();
  });

  it('explains the data gap when the job was already cleaned up', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(null);
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    expand();
    await waitFor(() => expect(screen.getByTestId('job-done-missing')).toBeTruthy());
    expect(screen.getByTestId('job-done-missing').textContent).toContain('结算通知里的终态');
  });

  it('keeps the settlement when a late running snapshot disagrees', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(
      snapshot({ job: { ...snapshot().job, status: 'running', detail: undefined, finishedAt: undefined } }),
    );
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    await waitFor(() => expect(screen.getByTestId('job-done-pill').getAttribute('data-status')).toBe('已完成'));
    expand();
    expect(screen.getByTestId('job-done-live-note').textContent).toContain('以通知的终态为准');
  });

  it('prefers the snapshot terminal reason when it has one', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(
      snapshot({ job: { ...snapshot().job, status: 'killed', detail: 'killed before exit; cancelled by the user' } }),
    );
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('task-notice-title').textContent).toBe('后台任务 bash-1 已取消 · npm test'),
    );
    expand();
    expect(screen.getByTestId('job-done-detail').textContent).toContain('用户停止');
  });

  it('marks truncated output instead of silently showing only the tail', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(
      snapshot({ text: 'tail only\n', lossy: true, spillPaths: ['/tmp/bash-1.log'] }),
    );
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    expand();
    await waitFor(() => expect(screen.getByTestId('job-done-output-lossy')).toBeTruthy());
    expect(screen.getByTestId('job-done-output-lossy').textContent).toContain('/tmp/bash-1.log');
  });
});

describe('JobDonePill · empty retained tail', () => {
  it('does not claim "no output" when the retained head was dropped', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(snapshot({ text: '', lossy: true, spillPaths: ['/tmp/bash-1.log'] }));
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    expand();
    await waitFor(() => expect(screen.getByTestId('job-done-lossy-empty')).toBeTruthy());
    expect(screen.queryByTestId('job-done-empty-output')).toBeNull();
    // 空尾部不再画一个空的白框。
    expect(screen.queryByTestId('job-done-output')).toBeNull();
    expect(screen.getByTestId('job-done-lossy-empty').textContent).toContain('/tmp/bash-1.log');
    expect(screen.getByTestId('job-done-lossy-empty').textContent).toContain('尾部也没有可显示的留存内容');
  });

  it('says there was no output only when the retained log really is empty', async () => {
    mocks.messages = [bashResult('bash-1', 100)];
    mocks.jobSnapshot.mockResolvedValue(snapshot({ text: '', lossy: false }));
    render(<JobDonePill content={notice('completed')} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={700_000} />);
    expand();
    await waitFor(() => expect(screen.getByTestId('job-done-empty-output')).toBeTruthy());
  });
});
