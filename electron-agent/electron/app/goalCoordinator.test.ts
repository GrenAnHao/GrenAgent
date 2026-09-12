import { describe, expect, it, vi } from 'vitest';
import { GoalCoordinator, type GoalDataPort, type GoalSnapshot, type GoalWorkerPort } from './goalCoordinator';

function fixture(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return { goalId: 'g', sessionId: 's', workspace: '/repo', revision: 1, condition: 'ship', status: 'active', roundsUsed: 0, maxRounds: 2, createdAt: 'a', updatedAt: 'a', ...overrides };
}

function harness(initial = fixture()) {
  let current = initial;
  const worker: GoalWorkerPort = { enqueueGoalTurn: vi.fn(async () => {}), closeGoalWorker: vi.fn(async () => {}) };
  const data: GoalDataPort = {
    get: vi.fn(() => current),
    update: vi.fn(async (input) => { current = { ...current, status: 'judging', revision: current.revision + 1 }; return current; }),
    claimRound: vi.fn(async (input) => ({ idempotencyKey: input.idempotencyKey, goalId: input.goalId, revision: input.revision, nextRound: input.nextRound, status: 'claimed' as const, turnId: input.turnId })),
    settleRound: vi.fn(async (input) => { current = { ...current, roundsUsed: current.roundsUsed + 1, revision: current.revision + 1, status: current.roundsUsed + 1 >= current.maxRounds ? 'paused' : 'active' }; return { snapshot: current, dispatch: { idempotencyKey: input.idempotencyKey, goalId: input.goalId, revision: input.revision, nextRound: current.roundsUsed, status: 'settled' as const, turnId: input.turnId } }; }),
    judgeResult: vi.fn(async (input) => { current = { ...current, status: input.verdict === 'pass' ? 'complete' : input.verdict === 'error' ? 'error' : 'paused', revision: current.revision + 1 }; return current; }),
    runtimeError: vi.fn(async () => { current = { ...current, status: 'error', revision: current.revision + 1 }; return current; }),
    cancelRound: vi.fn(async (input) => ({ idempotencyKey: input.idempotencyKey, goalId: input.goalId, revision: input.revision, nextRound: 1, status: 'failed' as const })),
  };
  return { data, worker, get current() { return current; }, set current(value: GoalSnapshot) { current = value; } };
}

describe('GoalCoordinator', () => {
  it('dispatches one round and settles it exactly once', async () => {
    const h = harness(); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    c.onGoalChanged(h.current, { kind: 'create', payload: {} });
    await vi.waitFor(() => expect(h.worker.enqueueGoalTurn).toHaveBeenCalledOnce());
    const call = (h.worker.enqueueGoalTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await c.onTurnCompleted({ workspace: '/repo', sessionId: 's', turnId: call.turnId, status: 'completed', summary: 'done', goal: call.goal });
    await c.onTurnCompleted({ workspace: '/repo', sessionId: 's', turnId: call.turnId, status: 'completed', summary: 'duplicate', goal: call.goal });
    expect(h.data.settleRound).toHaveBeenCalledOnce();
    expect(h.current.roundsUsed).toBe(1);
    await c.stop();
  });

  it('does not settle a late revision', async () => {
    const h = harness(fixture({ revision: 3 })); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    await c.onTurnCompleted({ workspace: '/repo', sessionId: 's', turnId: 'old', status: 'completed', summary: 'old', goal: { goalId: 'g', revision: 2, nextRound: 1, idempotencyKey: 'g:2:1' } });
    expect(h.data.settleRound).not.toHaveBeenCalled();
    expect(h.data.cancelRound).not.toHaveBeenCalled();
    expect(h.worker.closeGoalWorker).not.toHaveBeenCalled();
    await c.stop();
  });

  it('releases the lease of a stale generation whose turn did not complete', async () => {
    const h = harness(fixture({ revision: 3 })); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    await c.onTurnCompleted({
      workspace: '/repo', sessionId: 's', turnId: 'old', status: 'failed', summary: 'Pi exited unexpectedly (1)',
      goal: { goalId: 'g', revision: 2, nextRound: 1, idempotencyKey: 'g:2:1' },
    });
    expect(h.data.cancelRound).toHaveBeenCalledWith({
      sessionId: 's', goalId: 'g', revision: 2, idempotencyKey: 'g:2:1', turnId: 'old', reason: 'Pi exited unexpectedly (1)',
    });
    // A stale generation has no state transition and no worker of its own.
    expect(h.data.runtimeError).not.toHaveBeenCalled();
    expect(h.worker.closeGoalWorker).not.toHaveBeenCalled();
    await c.stop();
  });

  it('releases the lease and records a runtime error for a failed live turn', async () => {
    const h = harness(); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    await c.onTurnCompleted({
      workspace: '/repo', sessionId: 's', turnId: 't', status: 'failed', summary: 'Pi exited unexpectedly (1)',
      goal: { goalId: 'g', revision: 1, nextRound: 1, idempotencyKey: 'g:1:1' },
    });
    expect(h.data.cancelRound).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'g:1:1', revision: 1, turnId: 't' }));
    expect(h.data.runtimeError).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g', revision: 1, reason: 'Pi exited unexpectedly (1)' }));
    expect(h.current.status).toBe('error');
    expect(h.data.settleRound).not.toHaveBeenCalled();
    await c.stop();
  });

  it('ignores a settled turn reported for another workspace', async () => {
    const h = harness(fixture({ workspace: '/repo-a' })); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    await c.onTurnCompleted({
      workspace: '/repo-b', sessionId: 's', turnId: 'foreign', status: 'completed', summary: 'foreign',
      goal: { goalId: 'g', revision: 1, nextRound: 1, idempotencyKey: 'g:1:1' },
    });
    expect(h.data.settleRound).not.toHaveBeenCalled();
    expect(h.data.runtimeError).not.toHaveBeenCalled();
    expect(h.worker.closeGoalWorker).toHaveBeenCalledWith('s', '/repo-b');
    await c.stop();
  });

  it('pauses at the round cap and does not enqueue another round', async () => {
    const h = harness(fixture({ maxRounds: 1 })); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    c.onGoalChanged(h.current, { kind: 'create', payload: {} });
    await vi.waitFor(() => expect(h.worker.enqueueGoalTurn).toHaveBeenCalledOnce());
    const call = (h.worker.enqueueGoalTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await c.onTurnCompleted({ workspace: '/repo', sessionId: 's', turnId: call.turnId, status: 'completed', summary: 'done', goal: call.goal });
    expect(h.current.status).toBe('paused');
    expect(h.worker.enqueueGoalTurn).toHaveBeenCalledOnce();
    expect(h.worker.closeGoalWorker).toHaveBeenCalledWith('s', '/repo');
  });

  it('closes a worker when a completion request changes the goal revision', async () => {
    const h = harness(); const c = new GoalCoordinator({ data: h.data, worker: h.worker });
    c.onGoalChanged(h.current, { kind: 'create', payload: {} });
    await vi.waitFor(() => expect(h.worker.enqueueGoalTurn).toHaveBeenCalledOnce());
    const call = (h.worker.enqueueGoalTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await c.onCompletionRequested({ sessionId: 's', goalId: 'g', revision: call.goal.revision, evidence: 'done' });
    await c.onTurnCompleted({ workspace: '/repo', sessionId: 's', turnId: call.turnId, status: 'completed', summary: 'done', goal: call.goal });
    expect(h.worker.closeGoalWorker).toHaveBeenCalledWith('s', '/repo');
  });

  it('starts one independent judge and fails closed when unavailable', async () => {
    const h = harness(fixture({ status: 'judging', revision: 2 }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'error' as const, reason: 'MODEL_UNAVAILABLE', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });
    await Promise.all([
      c.onCompletionRequested({ sessionId: 's', goalId: 'g', revision: 2, evidence: 'e' }),
      c.onCompletionRequested({ sessionId: 's', goalId: 'g', revision: 2, evidence: 'e' }),
    ]);
    expect(judge.judge).toHaveBeenCalledOnce();
    expect(h.data.judgeResult).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'error' }));
    await c.stop();
  });

  it('records a runtime error when the judge result cannot be persisted', async () => {
    const h = harness(fixture({ status: 'judging', revision: 2 }));
    h.data.judgeResult = vi.fn().mockRejectedValue(new Error('DB_WRITE_FAILED'));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });

    await c.onCompletionRequested({ sessionId: 's', goalId: 'g', revision: 2, evidence: 'done' });

    expect(h.data.runtimeError).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's', goalId: 'g', revision: 2, reason: expect.stringContaining('DB_WRITE_FAILED'),
    }));
    expect(h.worker.closeGoalWorker).toHaveBeenCalledWith('s', '/repo');
    await c.stop();
  });

  it('does not replay a stale begin_judging event after restart disarms the Goal', async () => {
    const h = harness(fixture({ status: 'disarmed', revision: 3 }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const onGoalChanged = vi.fn();
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge, onGoalChanged });
    c.onGoalChanged(h.current, {
      goalId: 'g', sessionId: 's', revision: 2, kind: 'begin_judging', payload: { evidence: 'old' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(judge.judge).not.toHaveBeenCalled();
    expect(onGoalChanged).not.toHaveBeenCalled();
    await c.stop();
  });

  it('does not reuse evidence from another Goal generation', async () => {
    const h = harness(fixture({ goalId: 'goal-a', revision: 1 }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });

    await c.onTurnCompleted({
      workspace: '/repo', sessionId: 's', turnId: 'turn-a', status: 'completed', summary: 'evidence-a',
      goal: { goalId: 'goal-a', revision: 1, nextRound: 1, idempotencyKey: 'goal-a:1:1' },
    });
    // Reuse the session with a different Goal whose revision starts at one.
    h.current = fixture({ goalId: 'goal-b', revision: 1, status: 'active' });
    await c.onCompletionRequested({ sessionId: 's', goalId: 'goal-b', revision: 1, evidence: '' });

    expect(judge.judge).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'goal-b', evidence: '' }));
    expect(judge.judge).not.toHaveBeenCalledWith(expect.objectContaining({ evidence: 'evidence-a' }));
    await c.stop();
  });

  it('replays only a matching begin_judging generation', async () => {
    const h = harness(fixture({ status: 'judging', revision: 3 }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });

    await c.onGoalChanged(h.current, {
      goalId: 'g', sessionId: 's', revision: 2, kind: 'begin_judging', payload: { evidence: 'stale' },
    });
    expect(judge.judge).not.toHaveBeenCalled();
    await c.onGoalChanged(h.current, {
      goalId: 'g', sessionId: 's', revision: 3, kind: 'begin_judging', payload: { evidence: 'current' },
    });
    expect(judge.judge).toHaveBeenCalledWith(expect.objectContaining({ revision: 3, evidence: 'current' }));
    await c.stop();
  });

  it('does not invoke the judge for a stale replay generation', async () => {
    const h = harness(fixture({ goalId: 'new-goal', revision: 4, status: 'active' }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });

    await c.onGoalChanged(fixture({ goalId: 'old-goal', revision: 2, status: 'judging' }), {
      goalId: 'old-goal', sessionId: 's', revision: 2, kind: 'begin_judging', payload: { evidence: 'stale' },
    });

    expect(judge.judge).not.toHaveBeenCalled();
    expect(h.worker.closeGoalWorker).not.toHaveBeenCalled();
    await c.stop();
  });

  it.skip('releases every claimed lease when the Goal worker exits with an active and a queued turn', () => {
    // Task 14 removed GoalStore; this case is deleted in task 15.
  });

  it('does not close the live worker when a stale judge request has no workspace', async () => {
    const h = harness(fixture({ goalId: 'new-goal', revision: 4, status: 'active' }));
    const judge = { judge: vi.fn().mockResolvedValue({ verdict: 'pass' as const, reason: 'done', missing: [] }) };
    const c = new GoalCoordinator({ data: h.data, worker: h.worker, judge });

    await c.onGoalChanged(fixture({ goalId: 'old-goal', revision: 2, status: 'judging' }), {
      goalId: 'old-goal', sessionId: 's', revision: 2, kind: 'begin_judging', payload: { evidence: 'stale' },
    });

    expect(judge.judge).not.toHaveBeenCalled();
    expect(h.worker.closeGoalWorker).not.toHaveBeenCalled();
    await c.stop();
  });
});
