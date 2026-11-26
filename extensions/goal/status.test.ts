import { afterEach, describe, expect, it } from 'vitest';
import { __resetGoalActivationsForTest, beginGoalOwner, buildGoalStatus, setActivation } from './status.js';

const created = { type: 'custom', customType: 'goal', data: { kind: 'create', goalId: 'g', revision: 1, at: '2026-11-17T00:00:00.000Z', payload: { condition: 'work', maxRounds: 2 } } };
afterEach(__resetGoalActivationsForTest);

describe('Goal owner status issuer', () => {
  it('shares monotonic push/pull sequence, including activation-only and clear updates', () => {
    const epoch = beginGoalOwner('s');
    const first = buildGoalStatus({ entries: [created], sessionId: 's' });
    setActivation('s', 'armed');
    const second = buildGoalStatus({ entries: [created], sessionId: 's' });
    const clear = buildGoalStatus({ entries: [created, { type: 'custom', customType: 'goal', data: { kind: 'clear', goalId: 'g', revision: 2, at: created.data.at, payload: {} } }], sessionId: 's' });
    expect([first.sequence, second.sequence, clear.sequence]).toEqual([1, 2, 3]);
    expect(second.ownerEpoch).toBe(epoch);
    expect(first.snapshot?.revision).toBe(second.snapshot?.revision);
    expect(second.snapshot?.activation).toBe('armed');
    expect(clear.snapshot).toBeNull();
    expect(clear.ownerEpoch).toBe(epoch);
  });

  it('keeps offline reads disarmed and does not allocate a live owner or consume its sequence', () => {
    beginGoalOwner('s'); setActivation('s', 'armed');
    const offline = buildGoalStatus({ entries: [created], sessionId: 's', source: 'offline' });
    expect(offline).toMatchObject({ source: 'offline', snapshot: { activation: 'disarmed', runNumber: 1, conditionRevision: 1 } });
    expect(offline.ownerEpoch).toBeUndefined();
    expect(buildGoalStatus({ entries: [created], sessionId: 's' }).sequence).toBe(1);
  });

  it('does not grant a new budget to legacy exhausted data', () => {
    const legacy = { type: 'custom', customType: 'goal', data: { kind: 'round', goalId: 'g', revision: 2, at: created.data.at, payload: { round: 2 } } };
    const result = buildGoalStatus({ entries: [created, legacy], sessionId: 's', source: 'offline' });
    expect(result.snapshot).toMatchObject({ runNumber: 1, runRoundsStarted: 2, roundsStarted: 2, activation: 'disarmed', pauseReason: { code: 'max-rounds' } });
  });
});
