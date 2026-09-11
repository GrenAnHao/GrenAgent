import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { GoalCoordinator, type GoalDataPort, type GoalWorkerPort } from './goalCoordinator';
import { PiRuntimeService } from './piRuntimeService';
import { AgentDataStorage } from '../agentData/storage';
import { GoalStore } from '../agentData/goalStore';
import type { GoalSnapshot } from '../agentData/goalContracts';

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

  it('releases every claimed lease when the Goal worker exits with an active and a queued turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-worker-exit-'));
    const sessionPath = join(root, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/work' })}\n`);
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const store = new GoalStore(storage.db);
    const client = { send: vi.fn(async () => ({ ok: true })), respondUi: vi.fn(), setSessionIdentity: vi.fn() };
    const manager = {
      get: vi.fn(() => client),
      open: vi.fn(() => client),
      openGoalWorker: vi.fn(() => client),
      closeGoalWorker: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as any;
    const thread = {
      createThread: vi.fn(async (input: any) => ({ ...input, status: 'active', createdAt: 1, updatedAt: 1 })),
      createTurn: vi.fn(async (input: any) => ({ ...input, status: 'queued', mode: 'goal', createdAt: 1 })),
      updateTurn: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
    };
    let coordinator: GoalCoordinator;
    const disposeGoal = vi.fn(async () => {});
    const pi = new PiRuntimeService({
      manager, processCommand: { command: 'pi', args: [] }, agentDir: 'C:/agent',
      agentHost: {
        open: async () => ({ session: { sessionId: 'session-a', sessionFile: sessionPath }, prompt: async () => {}, getState: () => ({ sessionId: 'session-a', sessionFile: sessionPath }), dispose: async () => {} }) as never,
        get: () => undefined,
        close: async () => {},
      },
      goalHost: {
        open: async () => ({ session: { sessionId: 'session-a', sessionFile: sessionPath }, prompt: async () => {}, getState: () => ({ sessionId: 'session-a', sessionFile: sessionPath }), dispose: async () => {} }) as never,
        get: () => undefined,
        findBySessionPath: () => undefined,
        dispose: disposeGoal,
        disposeAllForWorkspace: async () => {},
      },
      modelRuntimeHost: { refresh: async () => {} },
      threadStore: thread as any,
      onTurnSettled: (result) => {
        if (!result.goal || !result.sessionId) return;
        return coordinator.onTurnCompleted({
          workspace: result.workspace, sessionId: result.sessionId, turnId: result.turnId,
          status: result.status, summary: result.summary, goal: result.goal,
        });
      },
    });
    coordinator = new GoalCoordinator({
      data: {
        get: (sessionId) => store.get(sessionId),
        update: (input) => store.update(input),
        claimRound: (input) => store.claimRound(input),
        settleRound: (input) => store.settleRound(input),
        judgeResult: (input) => store.recordJudge(input),
        runtimeError: (input) => store.failRuntime(input),
        cancelRound: (input) => store.cancelRound(input) ?? null,
      },
      worker: { enqueueGoalTurn: (input) => pi.enqueueGoalTurn(input), closeGoalWorker: (sessionId, workspace) => pi.closeGoalWorker(sessionId, workspace) },
    });

    try {
      const goal = store.create({ sessionId: 'session-a', workspace: 'C:/work', condition: 'ship it', origin: 'human-ui' });
      const activeKey = `${goal.goalId}:${goal.revision}:1`;
      store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: activeKey, workspace: 'C:/work', turnId: 'turn-1' });
      await pi.enqueueGoalTurn({
        workspace: 'C:/work', sessionId: 'session-a', sessionPath, turnId: 'turn-1',
        goal: { goalId: goal.goalId, revision: goal.revision, nextRound: 1, idempotencyKey: activeKey, condition: goal.condition },
      });

      // A human pause/resume advances the revision while round one is still in
      // flight, so the next dispatch claims a second lease and gets queued.
      const paused = store.update({ sessionId: goal.sessionId, goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' });
      const resumed = store.update({ sessionId: goal.sessionId, goalId: goal.goalId, revision: paused.revision, action: 'resume', origin: 'human-ui' });
      const queuedKey = `${goal.goalId}:${resumed.revision}:1`;
      store.claimRound({ sessionId: goal.sessionId, goalId: goal.goalId, revision: resumed.revision, nextRound: 1, idempotencyKey: queuedKey, workspace: 'C:/work', turnId: 'turn-2' });
      await pi.enqueueGoalTurn({
        workspace: 'C:/work', sessionId: 'session-a', sessionPath, turnId: 'turn-2',
        goal: { goalId: goal.goalId, revision: resumed.revision, nextRound: 1, idempotencyKey: queuedKey, condition: goal.condition },
      });
      expect(storage.db.prepare("SELECT COUNT(*) AS n FROM goal_turn_leases WHERE status='claimed'").get()).toMatchObject({ n: 2 });

      await pi.handlePiExit('C:/work', 1, { key: 'k', logicalWorkspace: 'C:/work', sessionId: 'session-a', source: 'goal' });

      expect(storage.db.prepare('SELECT idempotency_key,status FROM goal_turn_leases ORDER BY revision').all()).toEqual([
        { idempotency_key: activeKey, status: 'failed' },
        { idempotency_key: queuedKey, status: 'failed' },
      ]);
      expect(store.get('session-a')).toMatchObject({ status: 'error', stopReason: { kind: 'runtime_error' } });
      expect(disposeGoal).toHaveBeenCalledWith('C:/work', 'session-a');
      await coordinator.stop();
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
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
