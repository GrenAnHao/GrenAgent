import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobFrame, JobLiveSnapshot, JobLiveView } from '../lib/pi';

const mocks = vi.hoisted(() => ({
  jobSnapshot: vi.fn(),
  jobKill: vi.fn(),
  frameHandler: undefined as undefined | ((p: { frames: JobFrame[] }) => void),
}));

vi.mock('../lib/pi', () => ({
  pi: { jobSnapshot: mocks.jobSnapshot, jobKill: mocks.jobKill },
  onJobFrames: (handler: (p: { frames: JobFrame[] }) => void) => {
    mocks.frameHandler = handler;
    return Promise.resolve(() => {});
  },
}));

import { applyFrame, JOB_TEXT_CAP, jobKey, useJobLiveStore, __resetJobLiveForTest, type JobLiveEntry } from './jobLiveStore';

const view = (over: Partial<JobLiveView> = {}): JobLiveView => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'npm run build',
  owner: 's1',
  workspace: '/ws',
  status: 'running',
  startedAt: 100,
  ...over,
});
const ref = { jobId: 'bash-1', jobStartedAt: 100 };
const live = (over: Partial<JobLiveEntry> = {}): JobLiveEntry => ({ state: 'live', job: view(), text: 'abc', next: 3, lossy: false, ...over });

beforeEach(() => {
  __resetJobLiveForTest();
  mocks.jobSnapshot.mockReset();
  mocks.jobKill.mockReset();
  mocks.frameHandler = undefined;
});

describe('applyFrame', () => {
  it('appends a contiguous delta and takes the new job view', () => {
    const next = applyFrame(live(), { job: view({ status: 'completed', detail: 'exit code: 0' }), delta: { from: 3, text: 'de', next: 5, lossy: false } });
    expect(next).toMatchObject({ text: 'abcde', next: 5, job: { status: 'completed' } });
  });

  it('skips the bytes a snapshot already holds, by UTF-8 byte offset', () => {
    const entry = live({ text: '构', next: 3 });
    // 帧从 0 开始，'构' 3 字节已有，只接 '建'。
    expect(applyFrame(entry, { job: view(), delta: { from: 0, text: '构建', next: 6, lossy: false } })).toMatchObject({ text: '构建', next: 6 });
    // 完全重复的帧不改文本。
    expect(applyFrame(entry, { job: view(), delta: { from: 0, text: '构', next: 3, lossy: false } })).toMatchObject({ text: '构', next: 3 });
  });

  it('reports a gap when the frame starts past what the entry holds', () => {
    expect(applyFrame(live(), { job: view(), delta: { from: 9, text: 'x', next: 10, lossy: false } })).toBe('gap');
  });

  it('keeps only the tail past the cap and marks the entry lossy', () => {
    const big = `${'x'.repeat(JOB_TEXT_CAP)}\ntail\n`;
    const next = applyFrame(live({ text: '', next: 0 }), { job: view(), delta: { from: 0, text: big, next: big.length, lossy: false } });
    expect(next).not.toBe('gap');
    const entry = next as JobLiveEntry;
    expect(entry.lossy).toBe(true);
    expect(entry.text.length).toBeLessThanOrEqual(JOB_TEXT_CAP);
    expect(entry.text.endsWith('tail\n')).toBe(true);
  });
});

describe('useJobLiveStore', () => {
  it('ensure fetches the snapshot once, then follows frames for that job only', async () => {
    const snapshot: JobLiveSnapshot = { job: view(), text: 'line 1\n', next: 7, lossy: false };
    mocks.jobSnapshot.mockResolvedValue(snapshot);
    useJobLiveStore.getState().ensure(ref);
    useJobLiveStore.getState().ensure(ref);
    await vi.waitFor(() => expect(useJobLiveStore.getState().entries[jobKey(ref)]?.state).toBe('live'));
    expect(mocks.jobSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.jobSnapshot).toHaveBeenCalledWith('bash-1', 100);

    mocks.frameHandler?.({
      frames: [
        { job: view(), delta: { from: 7, text: 'line 2\n', next: 14, lossy: false } },
        { job: view({ id: 'bash-2', startedAt: 200 }), delta: { from: 0, text: 'other', next: 5, lossy: false } },
      ],
    });
    const entries = useJobLiveStore.getState().entries;
    expect(entries[jobKey(ref)]).toMatchObject({ text: 'line 1\nline 2\n', next: 14 });
    expect(entries['bash-2@200']).toBeUndefined();
  });

  it('a gap triggers a fresh snapshot', async () => {
    mocks.jobSnapshot.mockResolvedValueOnce({ job: view(), text: 'a', next: 1, lossy: false });
    useJobLiveStore.getState().ensure(ref);
    await vi.waitFor(() => expect(useJobLiveStore.getState().entries[jobKey(ref)]?.state).toBe('live'));
    mocks.jobSnapshot.mockResolvedValueOnce({ job: view(), text: 'abcdef', next: 6, lossy: false });
    mocks.frameHandler?.({ frames: [{ job: view(), delta: { from: 5, text: 'f', next: 6, lossy: false } }] });
    await vi.waitFor(() => expect(useJobLiveStore.getState().entries[jobKey(ref)]).toMatchObject({ text: 'abcdef', next: 6 }));
  });

  it('a job the main process no longer has reads as missing', async () => {
    mocks.jobSnapshot.mockResolvedValue(null);
    useJobLiveStore.getState().ensure(ref);
    await vi.waitFor(() => expect(useJobLiveStore.getState().entries[jobKey(ref)]?.state).toBe('missing'));
  });

  it('kill forwards the ref', async () => {
    mocks.jobKill.mockResolvedValue('requested');
    await useJobLiveStore.getState().kill(ref);
    expect(mocks.jobKill).toHaveBeenCalledWith('bash-1', 100);
  });
});
