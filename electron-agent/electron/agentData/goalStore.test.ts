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

  it('recovers a legacy goal as a disarmed, idempotent snapshot', () => {
    const { store } = fixture();
    const input = { sessionId: 'legacy-session', workspace: '/w', condition: 'finish the migration', react: 3, paused: true, legacyEntryTimestamp: '2026-09-07T00:00:00.000Z' };
    const recovered = store.recoverLegacy(input);
    expect(recovered).toMatchObject({ status: 'disarmed', source: 'legacy', revision: 1, maxRounds: 256, condition: input.condition });
    expect(store.get(input.sessionId)).toMatchObject({ goalId: recovered.goalId, source: 'legacy', status: 'disarmed' });
    expect(store.history(input.sessionId).at(-1)).toMatchObject({ kind: 'legacy_goal_restored', payload: expect.objectContaining({ condition: input.condition, react: 3, paused: true, legacyEntryTimestamp: input.legacyEntryTimestamp }) });
    expect(store.recoverLegacy({ ...input, condition: 'a different condition' })).toEqual(recovered);
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

  it('requires human-ui authority for pause, resume, and clear', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'system' })).toThrow('HUMAN_AUTH_REQUIRED');
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-agent' })).toThrow('HUMAN_AUTH_REQUIRED');
    const paused = store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: paused.revision, action: 'resume', origin: 'system' })).toThrow('HUMAN_AUTH_REQUIRED');
    const resumed = store.update({ sessionId: 's', goalId: goal.goalId, revision: paused.revision, action: 'resume', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: resumed.revision, action: 'clear', origin: 'human-agent' })).toThrow('HUMAN_AUTH_REQUIRED');
    expect(store.update({ sessionId: 's', goalId: goal.goalId, revision: resumed.revision, action: 'clear', origin: 'human-ui' }).status).toBe('cleared');
  });

  it('rejects condition changes from non-human origins', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 's', workspace: '/w', condition: 'old', origin: 'human-ui' });
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', payload: { condition: 'new' }, origin: 'system' })).toThrow('HUMAN_AUTH_REQUIRED');
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
    expect(fork.status).toBe('disarmed'); expect(fork.source).toBe('fork'); expect(fork.sourceGoalId).toBe(source.goalId); expect(fork.sourceSessionId).toBe('s1');
    expect(store.fork({ sourceSessionId: 's1', sourceGoalId: source.goalId, targetSessionId: 's2' })).toEqual(fork);
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
    const claim = store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 't' });
    expect(store.claimRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key })).toEqual(claim);
    const settled = store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 't', summary: 'done' });
    expect(settled.snapshot).toMatchObject({ roundsUsed: 1, status: 'paused', stopReason: { kind: 'max_rounds' } });
    expect(store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 't', summary: 'done' }).dispatch.status).toBe('settled');
    expect(() => store.settleRound({ sessionId: 's', goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'different', turnId: 't', summary: 'retry' })).toThrow('VERSION_CONFLICT');
  });

  it('rejects a settlement whose turn does not match the claimed lease', () => {
    const { db, store } = fixture();
    const goal = store.create({ sessionId: 'turn-check', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const key = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 'claimed-turn' });
    expect(() => store.settleRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 'wrong-turn', summary: 'done' })).toThrow('TURN_ID_MISMATCH');
    expect(db.prepare('SELECT status FROM goal_turn_leases WHERE idempotency_key=?').get(key)).toMatchObject({ status: 'claimed' });
    expect(store.settleRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 'claimed-turn', summary: 'done' }).snapshot.roundsUsed).toBe(1);
  });

  it('marks a claimed lease failed when a Goal runtime error stops the turn', () => {
    const { db, store } = fixture();
    const goal = store.create({ sessionId: 'runtime-error', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const key = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 'turn-a' });
    const failed = store.failRuntime({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, reason: 'workspace closed', turnId: 'turn-a' });
    expect(failed.status).toBe('error');
    expect(db.prepare('SELECT status,error FROM goal_turn_leases WHERE idempotency_key=?').get(key)).toMatchObject({ status: 'failed', error: 'workspace closed' });
  });

  it('cancels a claimed lease idempotently without moving the Goal snapshot', () => {
    const { db, store } = fixture();
    const goal = store.create({ sessionId: 'cancel', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const key = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 'turn-a' });
    const cancelled = store.cancelRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 'turn-a', reason: 'Pi exited unexpectedly (1)' });
    expect(cancelled).toMatchObject({ idempotencyKey: key, status: 'failed' });
    expect(db.prepare('SELECT status,error FROM goal_turn_leases WHERE idempotency_key=?').get(key)).toMatchObject({ status: 'failed', error: 'Pi exited unexpectedly (1)' });
    expect(store.get(goal.sessionId)).toMatchObject({ status: 'active', revision: goal.revision });
    expect(store.cancelRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, reason: 'again' })).toMatchObject({ status: 'failed' });
    expect(store.history(goal.sessionId).filter((event) => event.kind === 'round_cancel')).toHaveLength(1);
  });

  it('validates lease ownership and refuses to reopen a settled round', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 'cancel-guard', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const key = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 'turn-a' });
    const identity = { sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, reason: 'crash' };
    expect(() => store.cancelRound({ ...identity, sessionId: 'other-session' })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() => store.cancelRound({ ...identity, goalId: 'other-goal' })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() => store.cancelRound({ ...identity, revision: goal.revision + 1 })).toThrow('IDEMPOTENCY_CONFLICT');
    expect(() => store.cancelRound({ ...identity, turnId: 'other-turn' })).toThrow('TURN_ID_MISMATCH');
    expect(() => store.cancelRound({ ...identity, idempotencyKey: '  ' })).toThrow('INVALID_IDEMPOTENCY_KEY');
    expect(store.cancelRound({ ...identity, idempotencyKey: `${goal.goalId}:${goal.revision}:9` })).toBeUndefined();
    const settled = store.settleRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 'turn-a', summary: 'done' });
    expect(store.cancelRound(identity)).toMatchObject({ status: 'settled' });
    expect(store.get(goal.sessionId)).toMatchObject({ revision: settled.snapshot.revision, roundsUsed: 1 });
  });

  it('cancels a lease whose generation has already been superseded', () => {
    const { db, store } = fixture();
    const goal = store.create({ sessionId: 'stale-cancel', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const staleKey = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: staleKey, turnId: 'turn-a' });
    const paused = store.update({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' });
    const resumed = store.update({ sessionId: goal.sessionId, goalId: goal.goalId, revision: paused.revision, action: 'resume', origin: 'human-ui' });
    // The live revision moved on, so failRuntime can no longer reach this lease.
    expect(() => store.failRuntime({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, reason: 'crash' })).toThrow('VERSION_CONFLICT');
    expect(store.cancelRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: staleKey, turnId: 'turn-a', reason: 'crash' })).toMatchObject({ status: 'failed' });
    expect(db.prepare('SELECT status FROM goal_turn_leases WHERE idempotency_key=?').get(staleKey)).toMatchObject({ status: 'failed' });
    expect(store.get(goal.sessionId)).toMatchObject({ status: 'active', revision: resumed.revision });
  });

  it('forks a cleared Goal as a tombstone that legacy recovery cannot resurrect', () => {
    const { store } = fixture();
    const source = store.create({ sessionId: 'cleared-source', workspace: '/w', condition: 'stop this', origin: 'human-ui' });
    store.clear({ sessionId: source.sessionId, goalId: source.goalId, revision: source.revision, action: 'clear', origin: 'human-ui' });
    const forked = store.fork({ sourceSessionId: source.sessionId, sourceGoalId: source.goalId, targetSessionId: 'fork-target' });
    expect(forked).toMatchObject({ status: 'cleared', source: 'fork', sourceGoalId: source.goalId, sourceSessionId: source.sessionId, stopReason: { kind: 'cleared' } });
    expect(forked.clearedAt).toBeTruthy();
    expect(store.getLive('fork-target')).toBeUndefined();
    expect(store.fork({ sourceSessionId: source.sessionId, sourceGoalId: source.goalId, targetSessionId: 'fork-target' })).toEqual(forked);
    // The forked JSONL still carries the old legacy Goal entry; the tombstone
    // is what keeps recovery from recreating the cleared goal.
    const recovered = store.recoverLegacy({ sessionId: 'fork-target', workspace: '/w', condition: 'stop this', react: 2, paused: false });
    expect(recovered).toEqual(forked);
    expect(store.getLive('fork-target')).toBeUndefined();
    expect(store.history('fork-target').map((event) => event.kind)).toEqual(['fork']);
  });

  it('still recovers a legacy Goal for a fork target with no AgentData snapshot', () => {
    const { store } = fixture();
    const recovered = store.recoverLegacy({ sessionId: 'plain-fork-target', workspace: '/w', condition: 'keep going', react: 1, paused: false });
    expect(recovered).toMatchObject({ status: 'disarmed', source: 'legacy', condition: 'keep going' });
    expect(store.getLive('plain-fork-target')?.goalId).toBe(recovered.goalId);
  });

  /**
   * Pi writes a UUID session id into the JSONL header and mirrors it in the
   * file name, so session_id alone is the AgentData ownership key. The runtime
   * maps additionally key by workspace only because callers can supply an
   * unverified session id there.
   */
  it('treats session_id as the sole Goal ownership key across workspaces', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 'shared-id', workspace: '/w-a', condition: 'c', origin: 'human-ui' });
    expect(() => store.create({ sessionId: 'shared-id', workspace: '/w-b', condition: 'other', origin: 'human-ui' })).toThrow('GOAL_ALREADY_EXISTS');
    expect(store.get('shared-id')).toMatchObject({ goalId: goal.goalId, workspace: '/w-a' });
    const other = store.create({ sessionId: 'other-id', workspace: '/w-a', condition: 'c', origin: 'human-ui' });
    expect(store.get('other-id')?.goalId).toBe(other.goalId);
  });

  it('does not let turn deduplication bypass a stale revision', () => {
    const { store } = fixture();
    const goal = store.create({ sessionId: 'stale-settle', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const key = `${goal.goalId}:${goal.revision}:1`;
    store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: key, turnId: 'reused-turn' });
    store.settleRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: key, turnId: 'reused-turn', summary: 'done' });
    expect(() => store.settleRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, idempotencyKey: 'different-key', turnId: 'reused-turn', summary: 'stale' })).toThrow('VERSION_CONFLICT');
  });

  it('counts the same blockage across settled rounds and blocks only on the third', () => {
    const { store } = fixture();
    let current = store.create({ sessionId: 'blocked', workspace: '/w', condition: 'c', origin: 'human-ui' });
    for (let round = 1; round <= 3; round += 1) {
      const key = `${current.goalId}:${current.revision}:${round}`;
      store.claimRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, nextRound: round, idempotencyKey: key, turnId: `t-${round}` });
      expect(store.recordProgress({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, fingerprint: 'same', summary: 'waiting' }).status).toBe('active');
      current = store.settleRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, idempotencyKey: key, turnId: `t-${round}`, summary: 'waiting' }).snapshot;
      expect(current.blockage?.count).toBe(round);
    }
    expect(current.status).toBe('blocked');
    expect(current.stopReason).toMatchObject({ kind: 'blocked' });
  });

  it('resets blockage continuity when a round reports normal progress', () => {
    const { store } = fixture();
    let current = store.create({ sessionId: 'reset', workspace: '/w', condition: 'c', origin: 'human-ui' });
    for (let round = 1; round <= 2; round += 1) {
      const key = `${current.goalId}:${current.revision}:${round}`;
      store.claimRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, nextRound: round, idempotencyKey: key, turnId: `b-${round}` });
      store.recordProgress({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, fingerprint: 'same', summary: 'waiting' });
      current = store.settleRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, idempotencyKey: key, turnId: `b-${round}`, summary: 'waiting' }).snapshot;
    }
    const normalRound = 3;
    const normalKey = `${current.goalId}:${current.revision}:${normalRound}`;
    store.claimRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, nextRound: normalRound, idempotencyKey: normalKey, turnId: 'normal' });
    current = store.settleRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, idempotencyKey: normalKey, turnId: 'normal', summary: 'progress' }).snapshot;
    expect(current.blockage).toBeUndefined();
    const nextKey = `${current.goalId}:${current.revision}:4`;
    store.claimRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, nextRound: 4, idempotencyKey: nextKey, turnId: 'b-4' });
    store.recordProgress({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, fingerprint: 'same', summary: 'waiting' });
    current = store.settleRound({ sessionId: current.sessionId, goalId: current.goalId, revision: current.revision, idempotencyKey: nextKey, turnId: 'b-4', summary: 'waiting' }).snapshot;
    expect(current).toMatchObject({ status: 'active', blockage: { fingerprint: 'same', count: 1 } });
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

  it('disarms a judging goal on restart instead of leaving an active acceptance run', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const first = new GoalStore(storage.db);
    const goal = first.create({ sessionId: 'judging-restart', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const judging = first.update({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'system' });
    const reopened = new GoalStore(storage.db);
    expect(reopened.get(goal.sessionId)).toMatchObject({ goalId: goal.goalId, status: 'disarmed', revision: judging.revision + 1 });
    expect(reopened.history(goal.sessionId).map((event) => event.kind)).toEqual(['create', 'begin_judging', 'disarm']);
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

  it('waits for async listeners before acknowledging an event', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new GoalStore(storage.db);
    store.create({ sessionId: 'async-publish', workspace: '/w', condition: 'c', origin: 'human-ui' });
    let reject = true;
    store.onPublish(async () => {
      await Promise.resolve();
      if (reject) throw new Error('publisher offline');
    });
    await store.replay();
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    reject = false;
    await store.replay();
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).not.toMatchObject({ published_at: null });
    storage.close();
  });

  it('does not re-enter synchronous publication when a listener writes another Goal event', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    let store: GoalStore;
    const received: string[] = [];
    let nested = false;
    store = new GoalStore(storage.db, (event) => {
      received.push(event.kind);
      if (!nested) {
        nested = true;
        store.update({ sessionId: 'reentrant', goalId: String(event.goalId), revision: 1, action: 'pause', origin: 'human-ui' });
      }
    });
    store.create({ sessionId: 'reentrant', workspace: '/w', condition: 'c', origin: 'human-ui' });
    expect(received).toEqual(['create', 'pause']);
    expect(store.history('reentrant').map((event) => event.kind)).toEqual(['create', 'pause']);
    storage.close();
  });

  it('keeps an event pending when only some listeners receive it', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new GoalStore(storage.db);
    store.create({ sessionId: 'partial-publish', workspace: '/w', condition: 'c', origin: 'human-ui' });
    const received: unknown[] = [];
    let fail = true;
    store.onPublish((event) => received.push(event));
    store.onPublish(() => { if (fail) throw new Error('publisher offline'); });
    store.replay();
    expect(received).toHaveLength(1);
    expect(storage.db.prepare('SELECT published_at FROM goal_events').get()).toMatchObject({ published_at: null });
    fail = false;
    store.replay();
    expect(received).toHaveLength(2);
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
    expect(() => store.update({ sessionId: 's', goalId: goal.goalId, revision: judging.revision, action: 'judge_pass', origin: 'system' })).toThrow('INVALID_TRANSITION');
    expect(store.recordJudge({ sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'pass', reason: 'done' }).status).toBe('complete');
  });

  it('migrates legacy threads and turns with session_id', () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const threadCols = storage.db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    const turnCols = storage.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
    expect(threadCols.some((c) => c.name === 'session_id')).toBe(true); expect(turnCols.some((c) => c.name === 'session_id')).toBe(true);
    const leaseCols = storage.db.prepare('PRAGMA table_info(goal_turn_leases)').all() as Array<{ name: string }>;
    expect(leaseCols.map((c) => c.name)).toEqual(expect.arrayContaining(['turn_id', 'session_id', 'workspace', 'origin', 'prompt_digest', 'continuous_intent', 'blockage_fingerprint', 'blockage_summary']));
    expect(storage.schemaVersion()).toBe(4); storage.close();
  });
});
