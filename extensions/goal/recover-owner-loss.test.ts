import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetGoalAuthForTest, occupyGoalRound, releaseGoalRound, subscribeGoalWorkslot } from './auth.js';
import { __resetGoalContinueForTest } from './continue.js';
import { __resetGoalActivationsForTest, beginGoalOwner, getActivation, setActivation } from './status.js';
import { installGoalOwnerLossPort } from './owner-loss.js';
import { recoverGoalOwnerLoss } from './recover-owner-loss.js';
import { registerGoalControl } from './control.js';
import { startArmedGoalRound } from './continue.js';
import { readSnapshot } from './session.js';
import type { ConfirmedGoalOwnerLoss } from '../../electron-agent/electron/agentProcess/contract.js';
import type { GoalEvent } from './types.js';

const loss: ConfirmedGoalOwnerLoss = {
  workspace: '/repo', sessionPath: '/sessions/a.jsonl', sessionId: 'session-a', ownerEpoch: 'dead-owner',
  goalId: 'goal-a', revision: 2, runNumber: 1, conditionRevision: 1, roundId: 'dead-round',
  sequence: 1, occupied: true,
};
const created: GoalEvent = { kind: 'create', goalId: 'goal-a', revision: 1, at: '2026-11-17T00:00:00.000Z',
  payload: { condition: 'finish', maxRounds: 3 } };
const round: GoalEvent = { kind: 'round', goalId: 'goal-a', revision: 2, at: '2026-11-17T00:00:01.000Z',
  payload: { round: 1, runNumber: 1, runRound: 1 } };

const supersedes = { ownerEpoch: loss.ownerEpoch, roundId: loss.roundId, sequence: loss.sequence };
const taggedPause: GoalEvent = { kind: 'pause', goalId: 'goal-a', revision: 3, at: '2026-11-17T00:00:02.000Z',
  payload: { pauseReason: { code: 'runtime-error' }, confirmedLoss: supersedes } };
const laterEdit: GoalEvent = { kind: 'edit', goalId: 'goal-a', revision: 4, at: '2026-11-17T00:00:03.000Z',
  payload: { condition: 'changed' } };
const laterResume: GoalEvent = { kind: 'resume', goalId: 'goal-a', revision: 5, at: '2026-11-17T00:00:04.000Z', payload: {} };
function entryOf(data: GoalEvent) { return { type: 'custom' as const, customType: 'goal' as const, data }; }

function fixture() {
  const entries: Array<{ type: 'custom'; customType: 'goal'; data: GoalEvent }> = [created, round].map(data => ({ type: 'custom', customType: 'goal', data }));
  let failWrite = false;
  const statuses: string[] = [];
  const pi = { sendMessage: vi.fn(async () => {}), appendEntry: vi.fn((_name: string, event: GoalEvent) => {
    if (failWrite) throw new Error('disk unavailable');
    entries.push({ type: 'custom', customType: 'goal', data: event });
  }) };
  const ctx = { cwd: '/repo', sessionManager: {
    getSessionId: () => 'session-a', getSessionFile: () => '/sessions/a.jsonl', getEntries: () => entries,
  }, ui: { setStatus: (_name: string, value: string) => statuses.push(value), notify: vi.fn() } };
  return { pi: pi as never, ctx: ctx as never, entries, statuses, failWrite: () => { failWrite = true; } };
}
function port(claim: () => Promise<ConfirmedGoalOwnerLoss | undefined> = async () => loss) {
  const ack = vi.fn(async (_loss: ConfirmedGoalOwnerLoss) => true);
  installGoalOwnerLossPort({ publish: () => {}, claim, ack });
  return ack;
}
afterEach(() => {
  installGoalOwnerLossPort(undefined);
  __resetGoalAuthForTest(); __resetGoalContinueForTest(); __resetGoalActivationsForTest();
});

describe('new Goal owner after confirmed process loss', () => {
  it('claim waits before owner epoch/status/auto-dispatch; append is by the new owner, then ACK', async () => {
    const f = fixture(); let resolve!: (value: ConfirmedGoalOwnerLoss) => void;
    const ack = port(() => new Promise(r => { resolve = r; }));
    const pending = recoverGoalOwnerLoss(f.pi, f.ctx);
    expect(f.entries).toHaveLength(2);
    expect(f.statuses).toHaveLength(0);
    resolve(loss);
    await expect(pending).resolves.toBe(false);
    expect(f.entries).toHaveLength(3);
    expect(f.entries.at(-1)?.data).toMatchObject({ kind: 'pause', revision: 3, payload: {
      pauseReason: { code: 'runtime-error' }, confirmedLoss: {
        ownerEpoch: 'dead-owner', roundId: 'dead-round', sequence: 1,
      },
    } });
    expect(ack).toHaveBeenCalledWith(loss);
    expect(readSnapshot(f.ctx)?.status).toBe('paused');
    expect(getActivation('session-a')).toBe('disarmed');
  });

  it('write failure disarms, exposes unavailable and never ACKs the loss', async () => {
    const f = fixture(); f.failWrite(); const ack = port();
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(false);
    expect(f.entries).toHaveLength(2);
    expect(ack).not.toHaveBeenCalled();
    expect(f.statuses.at(-1)).toContain('GOAL_PAUSE_NOT_PERSISTED');
    expect(getActivation('session-a')).toBe('disarmed');
  });

  it('rejects stale revisions and a late lease without writing or ACKing', async () => {
    const f = fixture(); const ack = port();
    f.entries.push({ type: 'custom', customType: 'goal', data: { kind: 'edit', goalId: 'goal-a', revision: 3,
      at: '2026-11-17T00:00:02.000Z', payload: { condition: 'changed' } } });
    await recoverGoalOwnerLoss(f.pi, f.ctx);
    expect(f.entries).toHaveLength(3);
    expect(ack).not.toHaveBeenCalled();
    expect(f.statuses.at(-1)).toContain('GOAL_OWNER_LOSS_STALE');
  });

  it('an unproven normal reopen keeps the existing auto-continue setting, and read-only claim does not write', async () => {
    const f = fixture(); const ack = port(async () => undefined);
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(true);
    expect(f.entries).toHaveLength(2);
    expect(ack).not.toHaveBeenCalled();
  });

  it('claim failure does not treat active JSONL as a proven crash or dispatch', async () => {
    const f = fixture(); const ack = port(async () => { throw new Error('main unreachable'); });
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(false);
    expect(f.entries).toHaveLength(2);
    expect(ack).not.toHaveBeenCalled();
    expect(f.statuses.at(-1)).toContain('GOAL_OWNER_LOSS_UNKNOWN');
  });

  it('a committed tagged pause can be ACKed on a later owner after ACK transport failed', async () => {
    const f = fixture(); port();
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => loss, ack: async () => { throw Error('lost ack'); } });
    await recoverGoalOwnerLoss(f.pi, f.ctx);
    expect(f.statuses.at(-1)).toContain('GOAL_OWNER_LOSS_ACK_FAILED');
    const ack = port();
    await recoverGoalOwnerLoss(f.pi, f.ctx);
    expect(f.entries).toHaveLength(3);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('the trusted control owner publishes occupied/released work with a monotonic sequence', async () => {
    const f = fixture(); const notices: unknown[] = [];
    installGoalOwnerLossPort({ publish: notice => notices.push(notice), claim: async () => undefined, ack: async () => false });
    beginGoalOwner('session-a'); setActivation('session-a', 'armed');
    const unregister = registerGoalControl(f.pi, f.ctx);
    await startArmedGoalRound(f.pi, f.ctx);
    expect(notices).toMatchObject([{ workspace: '/repo', sessionPath: '/sessions/a.jsonl', sessionId: 'session-a',
      ownerEpoch: expect.any(String), goalId: 'goal-a', roundId: expect.any(String),
      revision: 3, sequence: 1, occupied: true }]);
    unregister();
    expect(notices).toMatchObject([{}, { sequence: 2, occupied: false }]);
  });

  it('a disconnected ownership sink does not break Goal append, occupy or release', async () => {
    const f = fixture();
    installGoalOwnerLossPort({ publish: () => { throw new Error('IPC disconnected'); },
      claim: async () => undefined, ack: async () => false });
    beginGoalOwner('session-a'); setActivation('session-a', 'armed');
    const unregister = registerGoalControl(f.pi, f.ctx);
    await expect(startArmedGoalRound(f.pi, f.ctx)).resolves.toBeUndefined();
    expect(f.entries).toHaveLength(3);
    expect(() => unregister()).not.toThrow();
  });

  it('ownership observer errors never break occupy or release', () => {
    const f = fixture(); beginGoalOwner('session-a');
    const stop = subscribeGoalWorkslot('session-a', () => { throw new Error('IPC disconnected'); });
    const ref = occupyGoalRound('session-a', { goalId: 'goal-a', runNumber: 1, conditionRevision: 1, round: 1 })!;
    expect(releaseGoalRound('session-a', ref.roundId)).toBe(true);
    stop();
    expect(f.entries).toHaveLength(2);
  });

  it('a committed loss pause stays provable after later edits and resumes, and is ACKed without another pause', async () => {
    const f = fixture();
    f.entries.push(entryOf(taggedPause), entryOf(laterEdit), entryOf(laterResume));
    const ack = port();
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(false);
    expect(ack).toHaveBeenCalledWith(loss);
    expect(f.entries).toHaveLength(5);
    expect(f.statuses.at(-1)).not.toContain('GOAL_OWNER_LOSS_STALE');
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', revision: 5 });
  });

  it('a loss already superseded by a committed trusted resume is ACKed on reopen without forcing pause', async () => {
    const f = fixture();
    f.entries.push(entryOf({ kind: 'resume', goalId: 'goal-a', revision: 3, at: '2026-11-17T00:00:02.000Z',
      payload: { operationId: 'resume-1', supersedesConfirmedLoss: supersedes } }));
    const ack = port();
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(true);
    expect(ack).toHaveBeenCalledWith(loss);
    expect(f.entries).toHaveLength(3);
    expect(readSnapshot(f.ctx)).toMatchObject({ status: 'active', revision: 3 });
    expect(f.statuses.at(-1)).not.toContain('GOAL_OWNER_LOSS_STALE');
  });

  it('a supersede marker for another fence does not close this loss', async () => {
    const f = fixture();
    f.entries.push(entryOf({ kind: 'resume', goalId: 'goal-a', revision: 3, at: '2026-11-17T00:00:02.000Z',
      payload: { operationId: 'resume-1', supersedesConfirmedLoss: { ...supersedes, sequence: 2 } } }));
    const ack = port();
    await recoverGoalOwnerLoss(f.pi, f.ctx);
    expect(ack).not.toHaveBeenCalled();
    expect(f.entries).toHaveLength(3);
    expect(f.statuses.at(-1)).toContain('GOAL_OWNER_LOSS_STALE');
  });

  it('a lost ACK on a superseded loss is re-proved from the marker on the next owner', async () => {
    const f = fixture();
    f.entries.push(entryOf({ kind: 'resume', goalId: 'goal-a', revision: 3, at: '2026-11-17T00:00:02.000Z',
      payload: { operationId: 'resume-1', supersedesConfirmedLoss: supersedes } }));
    installGoalOwnerLossPort({ publish: () => {}, claim: async () => loss, ack: async () => { throw new Error('lost ack'); } });
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(false);
    expect(f.statuses.at(-1)).toContain('GOAL_OWNER_LOSS_ACK_FAILED');
    const ack = port();
    await expect(recoverGoalOwnerLoss(f.pi, f.ctx)).resolves.toBe(true);
    expect(ack).toHaveBeenCalledWith(loss);
    expect(f.entries).toHaveLength(3);
  });
});
