import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetGoalControlsForTest, captureGoalOwnerFailureFence, controlGoal, registerGoalControl, reportGoalOwnerFailure } from './control.js';
import { __resetGoalActivationsForTest, beginGoalOwner, getGoalOwnerStoppedAt } from './status.js';
import { __resetGoalAuthForTest, occupiedGoalRound } from './auth.js';
import { __resetGoalContinueForTest, goalRunUnavailable, startArmedGoalRound } from './continue.js';
import { installGoalOwnerLossPort } from './owner-loss.js';
import { clearGoal, createGoal, editGoal, pauseGoal, readSnapshot } from './session.js';
import type { GoalControlRequest } from './control-contract.js';
import type { ConfirmedGoalOwnerLoss } from '../../electron-agent/electron/agentProcess/contract.js';

let number = 0;
function setup(entries: unknown[] = []) {
  const sessionId = `control-${++number}`;
  let failAppend = false;
  const pi = { appendEntry: vi.fn((customType, data) => {
    if (failAppend) throw new Error('disk unavailable');
    entries.push({ type: 'custom', customType, data });
  }), sendMessage: vi.fn() };
  const ctx = { cwd: '/project', sessionManager: { getSessionId: () => sessionId,
    getSessionFile: () => `/sessions/${sessionId}.jsonl`, getEntries: () => entries }, ui: { notify: vi.fn(), setStatus: vi.fn() } };
  beginGoalOwner(sessionId);
  registerGoalControl(pi as never, ctx as never);
  return { sessionId, entries, pi, ctx: ctx as never, failAppend: (value: boolean) => { failAppend = value; } };
}
function editRequest(f: ReturnType<typeof setup>, operationId = 'edit-1'): GoalControlRequest {
  const snapshot = readSnapshot(f.ctx)!;
  return { action: 'edit', operationId, goalId: snapshot.goalId, expectedRevision: snapshot.revision, expectedConditionRevision: snapshot.conditionRevision, condition: 'second' };
}
afterEach(() => { installGoalOwnerLossPort(undefined); __resetGoalControlsForTest(); __resetGoalActivationsForTest(); __resetGoalAuthForTest(); __resetGoalContinueForTest(); });

describe('trusted Goal control commit receipts', () => {
  it('reports only actual commits and replays the same operation without another append', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first');
    const request = editRequest(f);
    const receipt = await controlGoal(f.sessionId, request);
    expect(receipt).toMatchObject({ operationId: 'edit-1', sessionId: f.sessionId, goalId: request.goalId, action: 'edit', outcome: 'committed', committedRevision: 2, expectedConditionRevision: 1, snapshot: { condition: 'second', conditionRevision: 2 } });
    const before = f.entries.length;
    expect(await controlGoal(f.sessionId, request)).toMatchObject({ outcome: 'committed', committedRevision: 2, replayed: true });
    expect(f.entries).toHaveLength(before);
    expect(await controlGoal(f.sessionId, { ...request, condition: 'different' })).toMatchObject({ outcome: 'conflict', message: 'GOAL_OPERATION_ID_CONFLICT' });
  });

  it('recovers durable operation receipts in a new owner and does not borrow another session', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first');
    const request = editRequest(f);
    await controlGoal(f.sessionId, request);
    const restored = setup(structuredClone(f.entries));
    expect(await controlGoal(restored.sessionId, request)).toMatchObject({ outcome: 'committed', committedRevision: 2, replayed: true, snapshot: { condition: 'second' } });
    const other = setup(); createGoal(other.pi as never, other.ctx, 'other');
    expect(await controlGoal(other.sessionId, request)).toMatchObject({ outcome: 'conflict', message: 'VERSION_CONFLICT' });
    expect(readSnapshot(other.ctx)?.condition).toBe('other');
  });

  it('a terminated same-owner prompt without SDK settled releases only its old slot, so control resume really dispatches', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const old = captureGoalOwnerFailureFence(f.sessionId)!;
    expect(old.roundId).toBe(occupiedGoalRound(f.sessionId)?.roundId);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);

    const failure = reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...old }, old.ownerEpoch);
    expect(failure).toMatchObject({ persisted: true, snapshot: { status: 'paused', pauseReason: { code: 'runtime-error' } } });
    expect(occupiedGoalRound(f.sessionId)).toBeUndefined();
    const paused = readSnapshot(f.ctx)!;
    const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-after-failed-prompt',
      goalId: paused.goalId, expectedRevision: paused.revision, expectedConditionRevision: paused.conditionRevision });
    expect(receipt.outcome).toBe('committed');
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', roundsStarted: 2, runRoundsStarted: 2 });
    const fresh = occupiedGoalRound(f.sessionId)!;
    expect(fresh.roundId).not.toBe(old.roundId);

    // A delayed catch from the previous request cannot pause or release this runner.
    expect(reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...old }, old.ownerEpoch)).toMatchObject({ skipped: true });
    expect(occupiedGoalRound(f.sessionId)?.roundId).toBe(fresh.roundId);
    expect(readSnapshot(f.ctx)?.status).toBe('active');
  });

  it('a trusted resume repairs an unpersisted failure pause, keeps its kind and then dispatches', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    expect(reportGoalOwnerFailure(f.sessionId, { kind: 'request-error', ...fence }, fence.ownerEpoch))
      .toMatchObject({ persisted: false, error: 'GOAL_PAUSE_NOT_PERSISTED' });
    expect(goalRunUnavailable(f.sessionId)).toBe('GOAL_PAUSE_NOT_PERSISTED');
    const stoppedAt = getGoalOwnerStoppedAt(f.sessionId);
    expect(stoppedAt).toBeTruthy();
    f.failAppend(false);

    const active = readSnapshot(f.ctx)!;
    const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-unpersisted-pause',
      goalId: active.goalId, expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision });
    expect(receipt.outcome).toBe('committed');
    const events = f.entries.map((entry) => (entry as { data: { kind: string; revision: number; at: string;
      payload: Record<string, unknown> } }).data);
    const pauses = events.filter((event) => event.kind === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ revision: active.revision + 1, at: stoppedAt,
      payload: { pauseReason: { code: 'request-error' } } });
    expect(events.filter((event) => event.kind === 'resume')).toHaveLength(1);
    expect(goalRunUnavailable(f.sessionId)).toBeUndefined();
    expect(JSON.parse((f.ctx as never as { ui: { setStatus: { mock: { calls: string[][] } } } }).ui.setStatus.mock.calls.at(-1)![1]))
      .not.toHaveProperty('unavailable');
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', roundsStarted: 2 });
  });

  it('a failed pause repair commits no resume and keeps the trusted command unavailable', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish');
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...fence }, fence.ownerEpoch);
    const active = readSnapshot(f.ctx)!;
    const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-repair-failed',
      goalId: active.goalId, expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision });
    expect(receipt).toMatchObject({ outcome: 'failed', message: 'GOAL_PAUSE_NOT_PERSISTED' });
    expect(goalRunUnavailable(f.sessionId)).toBe('GOAL_PAUSE_NOT_PERSISTED');
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'resume')).toBe(false);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active' });
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the pause-to-resume wait does not count as run time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
      const f = setup(); createGoal(f.pi as never, f.ctx, 'finish', 4);
      await startArmedGoalRound(f.pi as never, f.ctx);
      vi.setSystemTime(new Date('2026-11-17T00:00:05.000Z'));
      const fence = captureGoalOwnerFailureFence(f.sessionId)!;
      f.failAppend(true);
      reportGoalOwnerFailure(f.sessionId, { kind: 'request-error', ...fence }, fence.ownerEpoch);
      vi.setSystemTime(new Date('2026-11-17T00:00:15.000Z'));
      f.failAppend(false);
      const active = readSnapshot(f.ctx)!;
      const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-ran-ms',
        goalId: active.goalId, expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision });
      expect(receipt.outcome).toBe('committed');
      expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', ranMs: 5000,
        runStartedAt: '2026-11-17T00:00:15.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a trusted resume writes the exact claimed loss fence into the control event and ACKs only after commit', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish');
    const active = readSnapshot(f.ctx)!;
    const claimed: ConfirmedGoalOwnerLoss = { workspace: '/project', sessionPath: `/sessions/${f.sessionId}.jsonl`,
      sessionId: f.sessionId, ownerEpoch: 'dead-owner', goalId: active.goalId, revision: 99, runNumber: 9,
      conditionRevision: 9, roundId: 'dead-round', sequence: 4, occupied: true };
    const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => claimed, ack });

    const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-supersedes-loss',
      goalId: active.goalId, expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision });
    expect(receipt.outcome).toBe('committed');
    const resume = f.entries.map((entry) => (entry as { data: { kind: string; payload: Record<string, unknown> } }).data)
      .find((event) => event.kind === 'resume')!;
    expect(resume.payload.supersedesConfirmedLoss).toEqual({ ownerEpoch: 'dead-owner', roundId: 'dead-round', sequence: 4 });
    expect(ack).toHaveBeenCalledWith(claimed);
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'pause')).toBe(false);
  });

  it('a failed claim commits no resume and keeps the previous pause unavailable', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish');
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...fence }, fence.ownerEpoch);
    f.failAppend(false);
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => { throw new Error('main unreachable'); },
      ack: async () => false });

    const active = readSnapshot(f.ctx)!;
    const receipt = await controlGoal(f.sessionId, { action: 'resume', operationId: 'resume-claim-failed',
      goalId: active.goalId, expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision });
    expect(receipt).toMatchObject({ outcome: 'failed', message: 'GOAL_OWNER_LOSS_UNKNOWN' });
    expect(goalRunUnavailable(f.sessionId)).toBe('GOAL_PAUSE_NOT_PERSISTED');
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'resume')).toBe(false);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'paused', pauseReason: { code: 'runtime-error' } });
  });

  it('replaying a committed resume re-ACKs a lost ACK without appending again', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish');
    const active = readSnapshot(f.ctx)!;
    const claimed: ConfirmedGoalOwnerLoss = { workspace: '/project', sessionPath: `/sessions/${f.sessionId}.jsonl`,
      sessionId: f.sessionId, ownerEpoch: 'dead-owner', goalId: active.goalId, revision: 99, runNumber: 9,
      conditionRevision: 9, roundId: 'dead-round', sequence: 4, occupied: true };
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => claimed,
      ack: async () => { throw new Error('ack transport lost'); } });
    const request = { action: 'resume' as const, operationId: 'resume-lost-ack', goalId: active.goalId,
      expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision };
    await controlGoal(f.sessionId, request);
    const written = f.entries.length;
    const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => claimed, ack });

    expect(await controlGoal(f.sessionId, request)).toMatchObject({ outcome: 'committed', replayed: true });
    expect(f.entries).toHaveLength(written);
    expect(ack).toHaveBeenCalledWith(claimed);
  });

  it('a terminated old prompt after an edit releases only its slot and dispatches the current condition once', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const old = captureGoalOwnerFailureFence(f.sessionId)!;
    editGoal(f.pi as never, f.ctx, 'second');
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);

    const failure = reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...old }, old.ownerEpoch);
    expect(failure).toMatchObject({ persisted: true, skipped: true });
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', condition: 'second',
      conditionRevision: 2, runRoundsStarted: 2 });
    const fresh = occupiedGoalRound(f.sessionId)!;
    expect(fresh.roundId).not.toBe(old.roundId);
    expect(fresh.conditionRevision).toBe(2);
  });

  it('a human pause wins over the late catch of an edited old prompt', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const old = captureGoalOwnerFailureFence(f.sessionId)!;
    editGoal(f.pi as never, f.ctx, 'second');
    pauseGoal(f.pi as never, f.ctx);
    const sent = f.pi.sendMessage.mock.calls.length;

    expect(reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...old }, old.ownerEpoch))
      .toMatchObject({ persisted: true, skipped: true });
    expect(occupiedGoalRound(f.sessionId)).toBeUndefined();
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(sent);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'paused', pauseReason: { code: 'user' } });
  });

  it('a half-committed repair retries with the same operationId without appending a second pause', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    reportGoalOwnerFailure(f.sessionId, { kind: 'request-error', ...fence }, fence.ownerEpoch);
    f.failAppend(false);
    const active = readSnapshot(f.ctx)!;
    let firstClaim = true;
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => {
      if (firstClaim) { firstClaim = false; f.failAppend(true); }
      return undefined;
    }, ack: async () => false });
    const request = { action: 'resume' as const, operationId: 'resume-half-commit', goalId: active.goalId,
      expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision };

    expect(await controlGoal(f.sessionId, request)).toMatchObject({ outcome: 'failed', message: 'disk unavailable' });
    const kinds = () => f.entries.map((entry) => (entry as { data: { kind: string } }).data.kind);
    expect(kinds().filter((kind) => kind === 'pause')).toHaveLength(1);
    expect(kinds()).not.toContain('resume');
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'paused', revision: active.revision + 1 });

    f.failAppend(false);
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => undefined, ack: async () => false });
    expect(await controlGoal(f.sessionId, request)).toMatchObject({ outcome: 'committed' });
    expect(kinds().filter((kind) => kind === 'pause')).toHaveLength(1);
    expect(kinds().filter((kind) => kind === 'resume')).toHaveLength(1);
    expect(goalRunUnavailable(f.sessionId)).toBeUndefined();
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', roundsStarted: 2 });
  });

  it('a replay never ACKs a newer loss from an older marker', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'finish');
    const active = readSnapshot(f.ctx)!;
    const oldLoss: ConfirmedGoalOwnerLoss = { workspace: '/project', sessionPath: `/sessions/${f.sessionId}.jsonl`,
      sessionId: f.sessionId, ownerEpoch: 'old-owner', goalId: active.goalId, revision: 99, runNumber: 9,
      conditionRevision: 9, roundId: 'old-round', sequence: 4, occupied: true };
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => oldLoss, ack: async () => true });
    const request = { action: 'resume' as const, operationId: 'resume-old-marker', goalId: active.goalId,
      expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision };
    await controlGoal(f.sessionId, request);
    const newerLoss: ConfirmedGoalOwnerLoss = { ...oldLoss, ownerEpoch: 'new-owner', roundId: 'new-round', sequence: 9 };
    const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => newerLoss, ack });

    expect(await controlGoal(f.sessionId, request)).toMatchObject({ outcome: 'committed', replayed: true });
    expect(ack).not.toHaveBeenCalled();
  });

  it('a committed clear/create drops the old failure latch and starts the new Goal', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first');
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...fence }, fence.ownerEpoch);
    expect(goalRunUnavailable(f.sessionId)).toBe('GOAL_PAUSE_NOT_PERSISTED');
    f.failAppend(false);

    const old = readSnapshot(f.ctx)!;
    expect(await controlGoal(f.sessionId, { action: 'clear', operationId: 'clear-stale-latch', goalId: old.goalId,
      expectedRevision: old.revision, expectedConditionRevision: old.conditionRevision })).toMatchObject({ outcome: 'committed' });
    expect(goalRunUnavailable(f.sessionId)).toBeUndefined();
    expect(await controlGoal(f.sessionId, { action: 'create', operationId: 'create-after-clear', goalId: '',
      expectedRevision: 0, expectedConditionRevision: 0, condition: 'fresh' })).toMatchObject({ outcome: 'committed' });
    expect(goalRunUnavailable(f.sessionId)).toBeUndefined();
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', condition: 'fresh',
      roundsStarted: 1, runRoundsStarted: 1 });
  });

  it('an edit during the async claim conflicts before resume and never ACKs or clears unavailable', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const fence = captureGoalOwnerFailureFence(f.sessionId)!;
    f.failAppend(true);
    reportGoalOwnerFailure(f.sessionId, { kind: 'runtime-error', ...fence }, fence.ownerEpoch);
    f.failAppend(false);
    const active = readSnapshot(f.ctx)!;
    const claimed: ConfirmedGoalOwnerLoss = { workspace: '/project', sessionPath: `/sessions/${f.sessionId}.jsonl`,
      sessionId: f.sessionId, ownerEpoch: 'dead-owner', goalId: active.goalId, revision: 99, runNumber: 9,
      conditionRevision: 9, roundId: 'dead-round', sequence: 7, occupied: true };
    const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
    let resolveClaim!: (value: ConfirmedGoalOwnerLoss) => void;
    let claimStarted = false;
    installGoalOwnerLossPort({ publish: () => {}, claim: () => {
      claimStarted = true;
      return new Promise<ConfirmedGoalOwnerLoss>((resolve) => { resolveClaim = resolve; });
    }, ack });
    const request = { action: 'resume' as const, operationId: 'resume-claim-gap-edit', goalId: active.goalId,
      expectedRevision: active.revision, expectedConditionRevision: active.conditionRevision };
    const pending = controlGoal(f.sessionId, request);
    await vi.waitFor(() => expect(claimStarted).toBe(true));
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'pause')).toBe(true);

    editGoal(f.pi as never, f.ctx, 'second');
    resolveClaim(claimed);
    expect(await pending).toMatchObject({ outcome: 'conflict', message: 'VERSION_CONFLICT' });
    expect(ack).not.toHaveBeenCalled();
    expect(goalRunUnavailable(f.sessionId)).toBe('GOAL_PAUSE_NOT_PERSISTED');
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'resume')).toBe(false);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(readSnapshot(f.ctx)).toMatchObject({ condition: 'second', conditionRevision: 2, status: 'paused' });
  });

  it('a clear/create during the async claim conflicts before writing a resume to the new Goal', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first', 4);
    await startArmedGoalRound(f.pi as never, f.ctx);
    const old = readSnapshot(f.ctx)!;
    const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
    let resolveClaim!: (value: ConfirmedGoalOwnerLoss | undefined) => void;
    let claimStarted = false;
    installGoalOwnerLossPort({ publish: () => {}, claim: () => {
      claimStarted = true;
      return new Promise<ConfirmedGoalOwnerLoss | undefined>((resolve) => { resolveClaim = resolve; });
    }, ack });
    const request = { action: 'resume' as const, operationId: 'resume-claim-gap-replace', goalId: old.goalId,
      expectedRevision: old.revision, expectedConditionRevision: old.conditionRevision };
    const pending = controlGoal(f.sessionId, request);
    await vi.waitFor(() => expect(claimStarted).toBe(true));

    clearGoal(f.pi as never, f.ctx);
    createGoal(f.pi as never, f.ctx, 'fresh');
    const fresh = readSnapshot(f.ctx)!;
    resolveClaim(undefined);
    expect(await pending).toMatchObject({ outcome: 'conflict', message: 'VERSION_CONFLICT' });
    expect(ack).not.toHaveBeenCalled();
    expect(f.entries.some((entry) => (entry as { data: { kind: string } }).data.kind === 'resume')).toBe(false);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(readSnapshot(f.ctx)).toMatchObject({ goalId: fresh.goalId, condition: 'fresh', status: 'active' });
  });

  it('does not treat scheduling an edit as success before its commit, and fails without losing the current state', async () => {
    const f = setup(); createGoal(f.pi as never, f.ctx, 'first');
    const request = editRequest(f);
    const pending = controlGoal(f.sessionId, request);
    expect(readSnapshot(f.ctx)?.condition).toBe('first');
    await pending;
    expect(readSnapshot(f.ctx)?.condition).toBe('second');
    f.pi.appendEntry.mockImplementation(() => { throw new Error('disk unavailable'); });
    const failed = await controlGoal(f.sessionId, { ...editRequest(f, 'edit-2'), condition: 'third' });
    expect(failed).toMatchObject({ outcome: 'failed', message: 'disk unavailable' });
    expect(readSnapshot(f.ctx)?.condition).toBe('second');
    expect(await controlGoal('missing-owner', request)).toMatchObject({ outcome: 'unavailable' });
  });
});
