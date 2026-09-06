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

  it('returns only live snapshots from getLive while get keeps tombstones', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(store.getLive('s')?.goalId).toBe(goal.goalId);
    store.clear({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'clear', origin: 'human-ui' });
    expect(store.get('s')?.status).toBe('cleared');
    expect(store.getLive('s')).toBeUndefined();
  });

  it('uses the newest row when goal generations share an updated timestamp', () => {
    const { db, store } = fixture();
    const first = store.create({ sessionId: 's', workspace: '/w', condition: 'first', origin: 'human-ui' });
    store.clear({ sessionId: 's', goalId: first.goalId, revision: first.revision, action: 'clear', origin: 'human-ui' });
    const second = store.create({ sessionId: 's', workspace: '/w', condition: 'second', origin: 'human-ui' });
    db.prepare('UPDATE goal_snapshots SET updated_at=? WHERE session_id=?').run('same-time', 's');
    expect(store.get('s')?.goalId).toBe(second.goalId);
    expect(store.getLive('s')?.goalId).toBe(second.goalId);
  });

  it('requires human-ui authority to change maxRounds', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const update = { sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause' as const, payload: { maxRounds: 4 }, origin: 'system' as const };
    expect(() => store.update(update)).toThrow('HUMAN_AUTH_REQUIRED');
    expect(() => store.update({ ...update, origin: 'human-agent' })).toThrow('HUMAN_AUTH_REQUIRED');
    expect(store.update({ ...update, origin: 'human-ui' })).toMatchObject({ status: 'paused', maxRounds: 4 });
  });

  it('enforces compare-and-swap and retains clear tombstone/history', () => {
    const { store } = fixture(); const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: 0, action: 'pause', origin: 'human-ui' })).toThrow('VERSION_CONFLICT');
    const cleared = store.clear({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'clear', origin: 'human-ui' });
    expect(cleared.status).toBe('cleared'); expect(store.get('s')?.status).toBe('cleared'); expect(store.history('s').length).toBeGreaterThan(1);
    expect(store.history('s', 1)).toHaveLength(1);
    expect(store.history('s', 0)).toEqual([]);
    expect(() => store.history('s', -1)).toThrow('INVALID_HISTORY_LIMIT');
    expect(() => store.history('s', 1.5)).toThrow('INVALID_HISTORY_LIMIT');
  });

  it('forks a disarmed goal with source references and restarts active goals', () => {
    const { store } = fixture(); const source = store.create({ sessionId: 's1', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const fork = store.fork({ sourceSessionId: 's1', sourceGoalId: source.goalId, targetSessionId: 's2' });
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
    const key = `${goal.goalId}:${goal.revision}:1`;
    const claim = store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key });
    expect(store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key })).toEqual(claim);
    const settled = store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 't', summary: 'done' });
    expect(settled.snapshot).toMatchObject({ roundsUsed: 1, status: 'paused', stopReason: { kind: 'max_rounds' } });
    expect(store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 't', summary: 'done' }).dispatch.status).toBe('settled');
    expect(store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'different', turnId: 't', summary: 'retry' })).toMatchObject({ dispatch: { idempotencyKey: key, status: 'settled' } });
  });

  it('rejects non-canonical claim idempotency keys', () => {
    const { db, store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const canonical = `${goal.goalId}:${goal.revision}:1`;
    expect(() => store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: 'custom-key' })).toThrow('INVALID_IDEMPOTENCY_KEY');
    store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: canonical });
    expect(db.prepare('SELECT idempotency_key FROM goal_turn_leases').get()).toMatchObject({ idempotency_key: canonical });
  });

  it('rejects empty claim idempotency keys', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    for (const idempotencyKey of ['', '   ']) {
      expect(() => store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey })).toThrow('INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('does not settle an unclaimed lease through a new idempotency key', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: `${goal.goalId}:${goal.revision}:1` });
    expect(() => store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'other', turnId: 'turn', summary: 'done' })).toThrow('ROUND_NOT_CLAIMED');
  });

  it('rejects skipped rounds while keeping repeated claims idempotent', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 2, idempotencyKey: `${goal.goalId}:${goal.revision}:2` })).toThrow('INVALID_ROUND');
    const key = `${goal.goalId}:${goal.revision}:1`;
    const claim = store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key });
    expect(store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key })).toEqual(claim);
  });

  it('returns committed results when a publish listener throws', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new GoalStore(storage.db, () => { throw new Error('publisher offline'); });
    expect(() => store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' })).not.toThrow();
    expect(store.get('s')?.status).toBe('active');
    expect(store.history('s')).toHaveLength(1);
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    const replayed: unknown[] = [];
    const restarted = new GoalStore(storage.db, (event) => replayed.push(event));
    restarted.replay();
    expect(replayed).toHaveLength(2);
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).not.toMatchObject({ published_at: null });
    storage.close();
  });

  it('disarms active goals when reopening the store and keeps restart history', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const first = new GoalStore(storage.db);
    const goal = first.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const reopened = new GoalStore(storage.db);
    expect(reopened.get('s')).toMatchObject({ goalId: goal.goalId, status: 'disarmed', revision: goal.revision + 1 });
    expect(reopened.getLive('s')).toMatchObject({ status: 'disarmed' });
    expect(reopened.history('s').map((event) => event.kind)).toEqual(['create', 'disarm']);
    expect(reopened.history('s')[1].payload).toMatchObject({ reason: 'restart' });
    storage.close();
  });

  it('keeps events pending until a listener successfully receives them', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new GoalStore(storage.db);
    store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    store.replay();
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    const received: unknown[] = [];
    store.onPublish((event) => received.push(event));
    store.replay();
    expect(received).toHaveLength(1);
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).not.toMatchObject({ published_at: null });
    storage.close();
  });

  it('does not reuse an idempotency key across sessions', () => {
    const { store } = fixture();
    const first = store.create({ sessionId: 's1', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const second = store.create({ sessionId: 's2', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.claimRound({ sessionId: 's1', goalId: first.goalId, revision: first.revision, nextRound: 1, idempotencyKey: 'shared' })).toThrow('INVALID_IDEMPOTENCY_KEY');
    store.claimRound({ sessionId: 's1', goalId: first.goalId, revision: first.revision, nextRound: 1, idempotencyKey: `${first.goalId}:${first.revision}:1` });
    store.claimRound({ sessionId: 's2', goalId: second.goalId, revision: second.revision, nextRound: 1, idempotencyKey: `${second.goalId}:${second.revision}:1` });
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
