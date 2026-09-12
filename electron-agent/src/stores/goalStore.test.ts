import { beforeEach, describe, expect, it } from 'vitest';
import type { GoalSnapshot } from './goalStore';
import { useGoalStore } from './goalStore';

const snapshot = (sessionId: string, revision: number, status: GoalSnapshot['status'] = 'active'): GoalSnapshot => ({
  goalId: `goal-${sessionId}`,
  sessionId,
  revision,
  condition: `condition-${sessionId}`,
  status,
  roundsStarted: 0,
  maxRounds: 256,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: `2026-09-01T00:00:0${revision}.000Z`,
  activation: 'disarmed',
});

describe('goalStore session projection', () => {
  beforeEach(() => {
    useGoalStore.setState({ bySession: {}, goal: undefined });
  });

  it('keeps snapshots for two sessions independent', () => {
    const first = snapshot('session-a', 1);
    const second = snapshot('session-b', 1);

    useGoalStore.getState().setSnapshot('session-a', first);
    useGoalStore.getState().setSnapshot('session-b', second);

    expect(useGoalStore.getState().getSnapshot('session-a')).toEqual(first);
    expect(useGoalStore.getState().getSnapshot('session-b')).toEqual(second);
  });

  it('does not let an older revision replace a newer snapshot', () => {
    const current = snapshot('session-a', 3);
    useGoalStore.getState().setSnapshot('session-a', current);

    useGoalStore.getState().setSnapshot('session-a', snapshot('session-a', 2, 'paused'));

    expect(useGoalStore.getState().getSnapshot('session-a')).toEqual(current);
  });

  it('does not let an old clear remove a newer snapshot', () => {
    useGoalStore.getState().setSnapshot('session-a', snapshot('session-a', 4));

    useGoalStore.getState().clearSnapshot('session-a', 3);

    expect(useGoalStore.getState().getSnapshot('session-a')?.revision).toBe(4);
  });

  it('accepts a new Goal generation even when its revision restarts at one', () => {
    const old = { ...snapshot('session-a', 8, 'complete'), goalId: 'old-goal', createdAt: '2026-09-01T00:00:00.000Z' };
    const next = { ...snapshot('session-a', 1, 'active'), goalId: 'new-goal', createdAt: '2026-09-02T00:00:00.000Z' };
    useGoalStore.getState().setSnapshot('session-a', old);
    useGoalStore.getState().setSnapshot('session-a', next);
    expect(useGoalStore.getState().getSnapshot('session-a')).toEqual(next);

    useGoalStore.getState().setSnapshot('session-a', { ...old, revision: 9, updatedAt: '2026-09-03T00:00:00.000Z' });
    expect(useGoalStore.getState().getSnapshot('session-a')?.goalId).toBe('new-goal');
  });

  it('returns no goal after switching to a session without a snapshot', () => {
    useGoalStore.getState().setSnapshot('session-a', snapshot('session-a', 1));

    expect(useGoalStore.getState().getSnapshot('session-b')).toBeUndefined();
  });

  it('drops only the live projection for a deleted session', () => {
    useGoalStore.getState().setSnapshot('session-a', snapshot('session-a', 1));
    useGoalStore.getState().setSnapshot('session-b', snapshot('session-b', 1));

    useGoalStore.getState().dropSession('session-a');

    expect(useGoalStore.getState().getSnapshot('session-a')).toBeUndefined();
    expect(useGoalStore.getState().getSnapshot('session-b')).toBeDefined();
  });
});
