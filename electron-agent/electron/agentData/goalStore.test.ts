import { describe, expect, it } from 'vitest';
import { AgentDataStorage } from './storage';
import { GoalStore } from './goalStore';

function fixture(publish?: (event: unknown) => void) {
  const storage = new AgentDataStorage(':memory:');
  storage.migrate();
  const store = new GoalStore(storage.db, publish);
  return { db: storage.db, store, storage };
}

describe('GoalStore', () => {
  it('isolates sessions and rejects duplicate live goals', () => {
    const { store } = fixture();
    const a = store.create({ sessionId: 'a', workspace: '/w', condition: 'one', origin: 'human-ui' });
    const b = store.create({ sessionId: 'b', workspace: '/w', condition: 'two', origin: 'human-ui' });
    expect(store.get('a')?.goalId).toBe(a.goalId); expect(store.get('b')?.goalId).toBe(b.goalId);
    expect(() => store.create({ sessionId: 'a', workspace: '/w', condition: 'again', origin: 'human-ui' })).toThrow('GOAL_ALREADY_EXISTS');
  });

  it('enforces compare-and-swap and retains clear tombstone/history', () => {
    const { store } = fixture(); const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: 0, action: 'pause', origin: 'human-ui' })).toThrow('VERSION_CONFLICT');
    const cleared = store.clear({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'clear', origin: 'human-ui' });
    expect(cleared.status).toBe('cleared'); expect(store.get('s')?.status).toBe('cleared'); expect(store.history('s').length).toBeGreaterThan(1);
  });

  it('forks a disarmed goal with source references and restarts active goals', () => {
    const { store } = fixture(); const source = store.create({ sessionId: 's1', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const fork = store.fork({ sessionId: 's1', goalId: source.goalId, newSessionId: 's2' });
    expect(fork.status).toBe('disarmed'); expect(fork.sourceGoalId).toBe(source.goalId); expect(fork.sourceSessionId).toBe('s1');
    expect(store.restart('s1')?.status).toBe('disarmed');
  });

  it('publishes events only after a successful commit', () => {
    const events: unknown[] = []; const { db, store } = fixture((event) => events.push(event));
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(events).toHaveLength(1);
    db.exec("CREATE TRIGGER fail_goal_event BEFORE INSERT ON goal_events BEGIN SELECT RAISE(ABORT, 'fail'); END");
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' })).toThrow('fail');
    expect(events).toHaveLength(1); expect(store.get('s')?.status).toBe('active');
  });

  it('claims and settles a round idempotently and pauses at the cap', () => {
    const { store } = fixture(); const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui', maxRounds: 1 });
    const claim = store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: 'k' });
    expect(store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: 'k2' })).toEqual(claim);
    const settled = store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'k', turnId: 't', summary: 'done' });
    expect(settled.snapshot).toMatchObject({ roundsUsed: 1, status: 'paused', stopReason: { kind: 'max_rounds' } });
    expect(store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'k', turnId: 't', summary: 'done' }).dispatch.status).toBe('settled');
  });

  it('rejects skipped rounds while keeping repeated claims idempotent', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 2, idempotencyKey: 'skip' })).toThrow('INVALID_ROUND');
    const claim = store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: 'round-1' });
    expect(store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: 'retry' })).toEqual(claim);
  });

  it('returns committed results when a publish listener throws', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new GoalStore(storage.db, () => { throw new Error('publisher offline'); });
    expect(() => store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' })).not.toThrow();
    expect(store.get('s')?.status).toBe('active');
    expect(store.history('s')).toHaveLength(1);
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    storage.close();
  });

  it('does not reuse an idempotency key across sessions', () => {
    const { store } = fixture();
    const first = store.create({ sessionId: 's1', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const second = store.create({ sessionId: 's2', workspace: '/w', condition: 'c', origin: 'human-ui' });
    store.claimRound({ sessionId: 's1', goalId: first.goalId, revision: first.revision, nextRound: 1, idempotencyKey: 'shared' });
    expect(() => store.claimRound({ sessionId: 's2', goalId: second.goalId, revision: second.revision, nextRound: 1, idempotencyKey: 'shared' })).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('requires judging state before recording a judge result', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.recordJudge({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, verdict: 'pass', reason: 'done' })).toThrow('INVALID_TRANSITION');
    const judging = store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'system' });
    expect(store.recordJudge({ sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'pass', reason: 'done' }).status).toBe('complete');
  });

  it('migrates legacy threads and turns with session_id', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const threadCols = storage.db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    const turnCols = storage.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    expect(threadCols.some((c) => c.name === 'session_id')).toBe(true); expect(turnCols.some((c) => c.name === 'session_id')).toBe(true);
    const leaseCols = storage.db.prepare('PRAGMA table_info(goal_turn_leases)').all() as Array<{ name: string }>;
    expect(leaseCols.map((c) => c.name)).toEqual(expect.arrayContaining(['turn_id', 'session_id', 'workspace', 'origin', 'prompt_digest', 'continuous_intent']));
    expect(storage.schemaVersion()).toBe(3); storage.close();
  });
});
