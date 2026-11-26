import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore } from '../../stores/goalStore';
import { applyGoalOwnerLoss, applyGoalStatus, parseGoalStatus, refreshGoalStatus, shouldConfirmGoalOwner } from './goalStatus';
import { pi } from '../../lib/pi';
vi.mock('../../lib/pi', () => ({ pi: { getGoal: vi.fn() } }));
const path = 'D:/project/session.jsonl';
const envelope = (sequence: number, snapshot: unknown = { goalId: 'g', revision: 2, condition: 'work', status: 'active', roundsStarted: 2, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:01Z' }) => ({ schemaVersion: 1, sessionId: 's', source: 'live', ownerEpoch: 'owner', sequence, snapshot });
beforeEach(() => {
  useGoalStore.setState({ bySession: {}, watermarks: {}, mutationFences: {}, sessionIdByPath: {} });
  vi.mocked(pi.getGoal).mockReset();
});

describe('Goal status protocol', () => {
  it('freezes a confirmed dead owner without falsely persisting pause, and only a confirmed new owner can replace it', async () => {
    const running = { ...parseGoalStatus(envelope(1))!.snapshot!, activation: 'armed', runStartedAt: '2026-11-17T00:00:00.000Z' };
    applyGoalStatus(envelope(3, running), undefined, path);
    applyGoalOwnerLoss({ sessionPath: path, sessionId: 's', ownerEpoch: 'owner', goalId: 'g', revision: 2, runNumber: 1, conditionRevision: 1 });
    expect(useGoalStore.getState().bySession.s).toMatchObject({ status: 'active', activation: 'disarmed', runtimeUnavailable: 'GOAL_OWNER_LOST' });
    expect(useGoalStore.getState().bySession.s.runStartedAt).toBeUndefined();
    expect(applyGoalStatus(envelope(99, running), undefined, path, true)).toBe(false);
    const announced = { ...envelope(1, { ...running, activation: 'disarmed' }), ownerEpoch: 'new-owner' };
    expect(applyGoalStatus(announced, undefined, path)).toBe(false);
    expect(shouldConfirmGoalOwner(announced)).toBe(true);
    expect(applyGoalStatus(announced, undefined, path, true)).toBe(true);
    expect(useGoalStore.getState().bySession.s).toMatchObject({ runtimeUnavailable: 'GOAL_OWNER_LOST', activation: 'disarmed' });
    expect(useGoalStore.getState().bySession.s.runStartedAt).toBeUndefined();
    const recovered = { ...envelope(2), ownerEpoch: 'new-owner', snapshot: { ...running, revision: 3, status: 'paused', activation: 'disarmed', runStartedAt: undefined, pauseReason: { code: 'runtime-error' } } };
    vi.mocked(pi.getGoal).mockResolvedValue(recovered);
    await refreshGoalStatus('/project', path);
    expect(useGoalStore.getState().bySession.s).toMatchObject({ status: 'paused', pauseReason: { code: 'runtime-error' } });
    expect(useGoalStore.getState().bySession.s.runtimeUnavailable).toBeUndefined();
    applyGoalOwnerLoss({ sessionPath: path, sessionId: 's', ownerEpoch: 'owner', goalId: 'g', revision: 2, runNumber: 1, conditionRevision: 1 });
    expect(useGoalStore.getState().bySession.s.status).toBe('paused');
  });

  it('reads legacy batch baselines and new pause details without changing historical bodies', () => {
    const legacy = parseGoalStatus(envelope(1))!;
    expect(legacy.snapshot).toMatchObject({ conditionRevision: 1, runNumber: 1, runRoundsStarted: 2 });
    const current = parseGoalStatus(envelope(2, { ...legacy.snapshot, runNumber: 2, runRoundsStarted: 0, conditionRevision: 3, status: 'paused', pauseReason: { code: 'max-rounds' } }));
    expect(current?.snapshot).toMatchObject({ runNumber: 2, conditionRevision: 3, pauseReason: { code: 'max-rounds' } });
  });

  it('rejects a late live projection after a clear and does not reset watermarks for new goalIds', () => {
    expect(applyGoalStatus(envelope(3), undefined, path)).toBe(true);
    expect(applyGoalStatus(envelope(4, null), undefined, path)).toBe(true);
    expect(applyGoalStatus(envelope(3), undefined, path)).toBe(false);
    expect(useGoalStore.getState().bySession.s).toBeUndefined();
    const next = { ...parseGoalStatus(envelope(1))!.snapshot!, goalId: 'new', revision: 1 };
    expect(applyGoalStatus(envelope(5, next), undefined, path)).toBe(true);
    expect(applyGoalStatus(envelope(4), undefined, path)).toBe(false);
    expect(useGoalStore.getState().bySession.s.goalId).toBe('new');
  });

  it('drops a pull started before a mutation and does not infer prompt success', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(pi.getGoal).mockReturnValue(new Promise((done) => { resolve = done; }));
    const reading = refreshGoalStatus('/project', path);
    useGoalStore.getState().bumpMutationFence(path);
    resolve(envelope(100));
    await reading;
    expect(useGoalStore.getState().bySession.s).toBeUndefined();
  });

  it('keeps original session ownership when a delayed pull completes', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(pi.getGoal).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const reading = refreshGoalStatus('/project', path);
    applyGoalStatus({ ...envelope(1), sessionId: 'other' }, undefined, 'D:/project/other.jsonl');
    resolve(envelope(1)); await reading;
    expect(useGoalStore.getState().bySession.s?.sessionId).toBe('s');
    expect(useGoalStore.getState().bySession.other?.sessionId).toBe('other');
  });
});
