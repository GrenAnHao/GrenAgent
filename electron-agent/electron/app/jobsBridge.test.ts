import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobs, __resetJobsForTest } from '../../../extensions/jobs/service.js';
import type { JobOutcome } from '../../../extensions/jobs/types.js';
import { startJobsBridge, type JobsBridge } from './jobsBridge';

let bridge: JobsBridge | undefined;

beforeEach(() => {
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});
afterEach(() => bridge?.stop());

function startJob() {
  let append!: (text: string) => void;
  let finish!: (o: JobOutcome) => void;
  const id = jobs.start({
    kind: 'bash',
    label: 'npm run build',
    owner: 's1',
    workspace: 'D:/repo',
    run: (job) => {
      append = (text) => job.append(text);
      return { cancel: () => {}, done: new Promise<JobOutcome>((r) => (finish = r)) };
    },
  });
  return { id, append, finish, startedAt: jobs.snapshot(id)!.startedAt };
}

describe('startJobsBridge', () => {
  it('broadcasts pi://jobs frames with the job workspace mapped to the handle workspace', async () => {
    const broadcast = vi.fn();
    bridge = startJobsBridge(broadcast, { workspaceForCwd: (cwd) => (cwd === 'D:/repo' ? 'repo-key' : cwd), intervalMs: 5 });
    const { append } = startJob();
    append('hello\n');
    await vi.waitFor(() => expect(broadcast.mock.calls.some(([, p]) => p.frames.some((f: { delta?: unknown }) => f.delta))).toBe(true));
    const [event, payload] = broadcast.mock.calls.at(-1)!;
    expect(event).toBe('pi://jobs');
    expect(payload.frames[0]).toMatchObject({ job: { id: 'bash-1', workspace: 'repo-key' }, delta: { from: 0, text: 'hello\n', next: 6 } });
  });

  it('snapshot and kill check the start time so a reused id after restart is not confused', () => {
    bridge = startJobsBridge(vi.fn());
    const { id, append, startedAt } = startJob();
    append('x\n');
    expect(bridge.snapshot(id, startedAt)).toMatchObject({ text: 'x\n', next: 2 });
    expect(bridge.snapshot(id, startedAt + 1)).toBeNull();
    expect(bridge.kill(id, startedAt + 1)).toBe('not-found');
    expect(bridge.kill(id, startedAt)).toBe('requested');
    expect(jobs.get(id, 's1').status).toBe('stopping');
  });
});
