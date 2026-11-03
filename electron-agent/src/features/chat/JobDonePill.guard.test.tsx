import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentStoreApi } from '../../stores/agent';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import { MessageTimelineContext } from './MessageTimelineContext';
import type { DisplayMessage } from './groupMessages';

vi.mock('../../lib/pi', () => ({
  pi: { jobSnapshot: vi.fn().mockResolvedValue(null), jobKill: vi.fn() },
  onJobFrames: () => Promise.resolve(() => {}),
}));

import { AgentIdentityContext } from './AgentCommunicationCard';
import { JobDonePill } from './JobDonePill';
import { SubagentSettledPill } from './SubagentSettledPill';

afterEach(() => cleanup());

const CONTENT =
  'Background job bash-1 (bash: npm test) finished completed.\n[status: completed, exit code: 0]\nRead its output with job_output.';
const expand = () => fireEvent.click(screen.getByTestId('job-done-pill-head'));

describe('task notice cards without a usable store', () => {
  it('renders when the context exists but has no store (partial harness / test mocks)', () => {
    render(
      <AgentStoreContext.Provider value={{ workspace: '/ws' } as unknown as never}>
        <JobDonePill content={CONTENT} details={{ jobId: 'bash-1', status: 'completed' }} />
      </AgentStoreContext.Provider>,
    );
    const pill = screen.getByTestId('job-done-pill');
    expect(pill.textContent).toContain('后台任务 bash-1 已完成 · npm test');
    expand();
    expect(screen.getByTestId('job-done-unresolved').textContent).toContain('取不到留存输出与耗时');
  });

  it('renders with no provider at all', () => {
    render(<JobDonePill content={CONTENT} details={{ jobId: 'bash-1', status: 'completed' }} />);
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
  });

  it('copes with an undefined / non-string legacy content', () => {
    render(<SubagentSettledPill content={undefined as unknown as string} details={{ childId: 'sa-1', stopReason: 'completed' }} />);
    expect(screen.getByTestId('subagent-settled-pill').textContent).toContain('子代理 sa-1 已完成');
  });

  it('takes the job start time from the rendered timeline (child transcripts included)', () => {
    const timeline: DisplayMessage[] = [
      {
        kind: 'turn',
        id: 'turn-1',
        segments: [
          {
            kind: 'tool',
            id: 'seg-1',
            toolCallId: 'c-1',
            toolName: 'bash',
            args: { command: 'npm test', run_in_background: true },
            result: { details: { background: true, jobId: 'bash-1', jobStartedAt: 1234 } },
            status: 'done',
          },
        ],
      },
    ];
    render(
      <MessageTimelineContext.Provider value={timeline}>
        <JobDonePill content={CONTENT} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={9_000_000} />
      </MessageTimelineContext.Provider>,
    );
    // 不读父 store 也能认出这次任务：属于「已定位、正在读快照」的路径，而不是「无法定位」。
    expand();
    expect(screen.queryByTestId('job-done-unresolved')).toBeNull();
    expect(screen.getByTestId('job-done-loading')).toBeTruthy();
  });

  it('does not borrow the parent store inside a child transcript without its own timeline', () => {
    const store = {
      useStore: {
        getState: () => ({
          messages: [
            {
              kind: 'tool',
              id: 't-1',
              toolCallId: 'c-1',
              toolName: 'bash',
              args: {},
              result: { details: { jobId: 'bash-1', jobStartedAt: 1234 } },
              status: 'done',
            },
          ],
        }),
        subscribe: () => () => {},
      },
    } as unknown as AgentStoreApi;
    render(
      <AgentIdentityContext.Provider value="sa-9">
        <AgentStoreContext.Provider value={{ workspace: '/ws', store } as unknown as never}>
          <JobDonePill content={CONTENT} details={{ jobId: 'bash-1', status: 'completed' }} timestamp={9_000_000} />
        </AgentStoreContext.Provider>
      </AgentIdentityContext.Provider>,
    );
    expand();
    expect(screen.getByTestId('job-done-unresolved')).toBeTruthy();
  });
});
