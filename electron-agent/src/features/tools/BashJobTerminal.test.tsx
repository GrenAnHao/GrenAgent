import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobFrame, JobLiveView } from '../../lib/pi';

const mocks = vi.hoisted(() => ({
  jobSnapshot: vi.fn(),
  jobKill: vi.fn(),
  frameHandler: undefined as undefined | ((p: { frames: JobFrame[] }) => void),
}));

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { jobSnapshot: mocks.jobSnapshot, jobKill: mocks.jobKill },
  onJobFrames: (handler: (p: { frames: JobFrame[] }) => void) => {
    mocks.frameHandler = handler;
    return Promise.resolve(() => {});
  },
}));

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ToolExecution } from './ToolExecution';
import { __resetJobLiveForTest } from '../../stores/jobLiveStore';
import { jobEndedBadly, jobFooterText, jobStatusLabel } from './bashCardModel';

const view = (over: Partial<JobLiveView> = {}): JobLiveView => ({
  id: 'bash-3',
  kind: 'bash',
  label: 'autoninja -C out chrome',
  owner: 's1',
  workspace: '/ws',
  status: 'running',
  startedAt: 500,
  ...over,
});

const promotedResult = {
  content: [{ type: 'text', text: '[1/5] CXX a.obj\n[still running after 120s; moved to background job bash-3]' }],
  details: { promoted: true, jobId: 'bash-3', jobStartedAt: 500 },
};

function renderCard(result: unknown = promotedResult) {
  return render(
    <ThemeProvider themeMode="dark">
      <ToolExecution
        toolName="bash"
        args={{ command: 'autoninja -C out chrome', description: 'Build chrome' }}
        result={result}
        status="done"
      />
    </ThemeProvider>,
  );
}

function openCard() {
  fireEvent.click(screen.getByText('Build chrome'));
}

beforeEach(() => {
  __resetJobLiveForTest();
  mocks.jobSnapshot.mockReset();
  mocks.jobKill.mockReset();
});
afterEach(cleanup);

describe('bash card following a background job', { timeout: 30_000 }, () => {
  it('shows live output, the running state on the row, and a stop button that kills the job', async () => {
    mocks.jobSnapshot.mockResolvedValue({ job: view(), text: '[1/5] CXX a.obj\n', next: 16, lossy: false });
    mocks.jobKill.mockResolvedValue('requested');
    renderCard();
    await screen.findByTestId('bash-job-meta');
    expect(screen.getByTestId('bash-job-meta').textContent).toBe('后台运行中');
    openCard();
    expect(screen.getByTestId('terminal-output').textContent).toBe('[1/5] CXX a.obj\n');
    expect(screen.getByTestId('terminal-block').hasAttribute('data-running')).toBe(true);
    expect(screen.getByTestId('bash-job-status').textContent).toBe('后台任务 bash-3 · 运行中');

    act(() => {
      mocks.frameHandler?.({ frames: [{ job: view(), delta: { from: 16, text: '[5/5] LINK chrome.dll\n', next: 38, lossy: false } }] });
    });
    expect(screen.getByTestId('terminal-output').textContent).toBe('[1/5] CXX a.obj\n[5/5] LINK chrome.dll\n');

    fireEvent.click(screen.getByTestId('bash-job-stop'));
    expect(mocks.jobKill).toHaveBeenCalledWith('bash-3', 500);
    expect(screen.getByTestId('bash-job-stop').textContent).toContain('正在停止');
  });

  it('settles with the exit status; a non-zero exit reads as an error', async () => {
    mocks.jobSnapshot.mockResolvedValue({ job: view(), text: 'x\n', next: 2, lossy: false });
    renderCard();
    await screen.findByTestId('bash-job-meta');
    openCard();
    act(() => {
      mocks.frameHandler?.({ frames: [{ job: view({ status: 'completed', detail: 'exit code: 1', finishedAt: 900 }) }] });
    });
    expect(screen.getByTestId('bash-job-meta').textContent).toBe('后台已结束，退出码 1');
    expect(screen.getByTestId('bash-job-status').textContent).toBe('后台任务 bash-3 · 已结束，退出码 1');
    expect(screen.queryByTestId('bash-job-stop')).toBeNull();
    expect(screen.getByTestId('terminal-block').hasAttribute('data-running')).toBe(false);
    expect(screen.getByTestId('terminal-output').className).toBeTruthy();
  });

  it('falls back to the tool result when the job is gone (app restarted)', async () => {
    mocks.jobSnapshot.mockResolvedValue(null);
    renderCard();
    openCard();
    await screen.findByTestId('bash-job-missing');
    expect(screen.getByTestId('terminal-output').textContent).toContain('moved to background job bash-3');
    expect(screen.queryByTestId('bash-job-meta')).toBeNull();
  });

  it('a plain foreground result does not follow any job', () => {
    renderCard({ content: [{ type: 'text', text: 'done\n' }] });
    openCard();
    expect(mocks.jobSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-footer')).toBeNull();
  });
});

describe('job status copy', () => {
  it('labels each state; killed and failed carry the reason in the footer', () => {
    expect(jobStatusLabel(view())).toBe('后台运行中');
    expect(jobStatusLabel(view({ status: 'completed', detail: 'exit code: 0' }))).toBe('后台已完成');
    expect(jobFooterText(view({ status: 'killed', detail: 'killed before exit; cancelled by the user' })))
      .toBe('后台任务 bash-3 · 已停止 · killed before exit; cancelled by the user');
    expect(jobEndedBadly(view({ status: 'completed', detail: 'exit code: 0' }))).toBe(false);
    expect(jobEndedBadly(view({ status: 'completed', detail: 'exit code: 2' }))).toBe(true);
    expect(jobEndedBadly(view({ status: 'killed' }))).toBe(true);
  });
});
