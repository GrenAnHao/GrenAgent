import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import type { GoalSnapshot } from './goalContracts';

describe('AgentDataRuntime Goal RPC', () => {
  it('scopes project Goal RPCs to the endpoint workspace and session resolver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-goal-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db'), resolveSession: (workspace, sessionId) => workspace === '/repo' && sessionId === 's1' });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      const goal = await root.request<{ goalId: string; revision: number }>('admin.goal.create', { sessionId: 's1', workspace: '/repo', condition: 'ship it', origin: 'human-ui' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 's1' });
      await expect(project.request('goal.get', { sessionId: 's2' })).rejects.toMatchObject({ code: 'SESSION_NOT_BOUND' });
      await expect(project.request('goal.get', { sessionId: 's1', workspace: '/other' })).resolves.toMatchObject({ goalId: goal.goalId });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision, action: 'pause' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(root.request('admin.goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' })).resolves.toMatchObject({ status: 'paused' });
      await expect(root.request('admin.goal.history', { sessionId: 's1' })).resolves.toHaveLength(2);
    } finally {
      await project.close(); await root.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a legacy Goal through the trusted admin RPC and remains idempotent', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const input = {
        sessionId: 'legacy', workspace: '/repo', condition: 'finish migration', react: 4, paused: true,
        legacyEntryTimestamp: '2026-09-07T00:00:00.000Z',
      };
      const recovered = await client.request<{ goalId: string; status: string; source: string; revision: number }>('admin.goal.recoverLegacy', input);
      expect(recovered).toMatchObject({ status: 'disarmed', source: 'legacy', revision: 1 });
      const repeated = await client.request<{ goalId: string; revision: number }>('admin.goal.recoverLegacy', { ...input, condition: 'different' });
      expect(repeated).toEqual(expect.objectContaining({ goalId: recovered.goalId, revision: recovered.revision }));
      await expect(client.request('admin.goal.recoverLegacy', { ...input, react: -1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    } finally {
      await client.close(); runtime.close();
    }
  });

  it('records admin judge results through the GoalStore judge path', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const goal = await client.request<{ goalId: string; revision: number; status: string }>('admin.goal.create', {
        sessionId: 'judge-pass', workspace: '/repo', condition: 'ship it', origin: 'human-ui',
      });
      const judging = await client.request<{ revision: number; status: string }>('admin.goal.update', {
        sessionId: 'judge-pass', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'human-ui',
      });
      const complete = await client.request<{ revision: number; status: string; judge: { verdict: string } }>('admin.goal.judgeResult', {
        sessionId: 'judge-pass', goalId: goal.goalId, revision: judging.revision, verdict: 'pass', reason: 'condition met', model: 'test-model',
      });
      expect(complete).toMatchObject({ status: 'complete', judge: { verdict: 'pass', model: 'test-model' } });

      const failed = await client.request<{ goalId: string; revision: number }>('admin.goal.create', {
        sessionId: 'judge-fail', workspace: '/repo', condition: 'ship it', origin: 'human-ui',
      });
      const failedJudging = await client.request<{ revision: number }>('admin.goal.update', {
        sessionId: 'judge-fail', goalId: failed.goalId, revision: failed.revision, action: 'begin_judging', origin: 'human-ui',
      });
      await expect(client.request<{ status: string; judge: { verdict: string } }>('admin.goal.judgeResult', {
        sessionId: 'judge-fail', goalId: failed.goalId, revision: failedJudging.revision, verdict: 'fail', reason: 'missing tests', missing: ['tests'],
      })).resolves.toMatchObject({ status: 'paused', judge: { verdict: 'fail' } });

      const errored = await client.request<{ goalId: string; revision: number }>('admin.goal.create', {
        sessionId: 'judge-error', workspace: '/repo', condition: 'ship it', origin: 'human-ui',
      });
      const erroredJudging = await client.request<{ revision: number }>('admin.goal.update', {
        sessionId: 'judge-error', goalId: errored.goalId, revision: errored.revision, action: 'begin_judging', origin: 'human-ui',
      });
      await expect(client.request<{ status: string; judge: { verdict: string } }>('admin.goal.judgeResult', {
        sessionId: 'judge-error', goalId: errored.goalId, revision: erroredJudging.revision, verdict: 'error', reason: 'judge unavailable', model: 'test-model', turnId: 'turn-1',
      })).resolves.toMatchObject({ status: 'error', judge: { verdict: 'error', turnId: 'turn-1' } });
    } finally {
      await client.close(); runtime.close();
    }
  });

  it('rejects project endpoints that try to submit a judge result', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: (workspace, sessionId) => workspace === '/repo' && sessionId === 's' });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      const goal = await root.request<{ goalId: string; revision: number }>('admin.goal.create', { sessionId: 's', workspace: '/repo', condition: 'ship', origin: 'human-ui' });
      const judging = await root.request<{ revision: number }>('admin.goal.update', { sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'human-ui' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 's' });
      await expect(project.request('goal.judgeResult', { sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'error', reason: 'judge unavailable' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });

  it('exposes project progress and completion goal operations', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: (workspace, sessionId) => workspace === '/repo' && sessionId === 's' });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      const goal = await root.request<{ goalId: string; revision: number }>('admin.goal.create', { sessionId: 's', workspace: '/repo', condition: 'ship', origin: 'human-ui' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 's' });
      let current: GoalSnapshot = { ...goal, sessionId: 's', workspace: '/repo', condition: 'ship', status: 'active', roundsUsed: 0, maxRounds: 256, createdAt: '', updatedAt: '' };
      for (let round = 1; round <= 3; round += 1) {
        const key = `${current.goalId}:${current.revision}:${round}`;
        await root.request('admin.goal.claimRound', { sessionId: 's', goalId: current.goalId, revision: current.revision, nextRound: round, idempotencyKey: key, turnId: `turn-${round}` });
        const reported = await project.request<{ revision: number; status: string }>('goal.recordProgress', {
          sessionId: 's', goalId: current.goalId, revision: current.revision, action: 'block', payload: { reason: 'waiting', fingerprint: 'dependency' },
        });
        expect(reported).toMatchObject({ status: 'active', revision: current.revision });
        const settled = await root.request<{ snapshot: GoalSnapshot }>('admin.goal.settleRound', {
          sessionId: 's', goalId: current.goalId, revision: current.revision, idempotencyKey: key, turnId: `turn-${round}`, summary: 'waiting',
        });
        current = settled.snapshot;
      }
      expect(current).toMatchObject({ status: 'blocked', roundsUsed: 3, blockage: { fingerprint: 'dependency', count: 3 } });
      await expect(project.request('goal.recordProgress', {
        sessionId: 's', goalId: goal.goalId, revision: current.revision, action: 'pause', payload: { reason: 'invalid' },
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const resumed = await root.request<{ revision: number }>('admin.goal.update', { sessionId: 's', goalId: goal.goalId, revision: current.revision, action: 'resume', origin: 'human-ui' });
      const judging = await project.request<{ revision: number; status: string }>('goal.requestCompletion', { sessionId: 's', goalId: goal.goalId, revision: resumed.revision });
      expect(judging).toMatchObject({ status: 'judging' });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });

  it('requires and audits explicit continuous intent evidence for project creates', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: () => true });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 'missing' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 'bad' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 'good' });
      await expect(project.request('goal.create', { sessionId: 'missing', condition: 'ship' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(project.request('goal.create', { sessionId: 'bad', condition: 'ship', continuousIntentEvidence: 'do it' })).rejects.toMatchObject({ code: 'GOAL_CREATE_INTENT_REQUIRED' });
      const goal = await project.request<{ goalId: string; sessionId: string }>('goal.create', {
        sessionId: 'good', condition: 'ship', continuousIntentEvidence: '/goal ship',
      });
      expect(goal).toMatchObject({ sessionId: 'good' });
      const events = await project.request<Array<{ kind: string; payload: Record<string, unknown> }>>('goal.history', { sessionId: 'good' });
      expect(events[0]).toMatchObject({ kind: 'create', payload: { continuousIntentEvidence: '/goal ship' } });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });

  it('requires an explicit session binding even when the resolver accepts the session', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: () => true });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      await expect(project.request('goal.get', { sessionId: 's' })).rejects.toMatchObject({ code: 'SESSION_NOT_BOUND' });
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 's' });
      await expect(project.request('goal.get', { sessionId: 's' })).resolves.toBeUndefined();
      await root.request('admin.goal.session.unbind', { workspace: '/repo', sessionId: 's' });
      await expect(project.request('goal.get', { sessionId: 's' })).rejects.toMatchObject({ code: 'SESSION_NOT_BOUND' });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });

  it('does not let a Goal worker create another Goal through the project RPC', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: () => true });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      await root.request('admin.goal.session.bind', { workspace: '/repo', sessionId: 's', source: 'goal' });
      await expect(project.request('goal.create', {
        sessionId: 's', condition: 'spawn another', continuousIntentEvidence: 'until complete',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });

  it('replays each unpublished event with its own goal generation snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-goal-replay-'));
    const dataPath = join(dir, 'data.db');
    const first = new AgentDataRuntime({ dataPath });
    const firstClient = new AgentDataClient(await first.start());
    try {
      const oldGoal = await firstClient.request<{ goalId: string; revision: number }>('admin.goal.create', {
        sessionId: 's', workspace: '/repo', condition: 'old', origin: 'human-ui',
      });
      const cleared = await firstClient.request<{ revision: number }>('admin.goal.update', {
        sessionId: 's', goalId: oldGoal.goalId, revision: oldGoal.revision, action: 'clear', origin: 'human-ui',
      });
      expect(cleared.revision).toBe(2);
      await firstClient.request('admin.goal.create', { sessionId: 's', workspace: '/repo', condition: 'new', origin: 'human-ui' });
    } finally {
      await firstClient.close(); first.close();
    }
    const second = new AgentDataRuntime({ dataPath });
    const events: Array<{ eventGoalId: string; snapshotGoalId?: string }> = [];
    try {
      await second.start();
      second.onGoalEvent((event, snapshot) => events.push({ eventGoalId: event.goalId, snapshotGoalId: snapshot?.goalId }));
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every((entry) => entry.snapshotGoalId === entry.eventGoalId)).toBe(true);
    } finally {
      second.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a disarmed independent Goal copy through the admin fork RPC', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const source = await client.request<{ goalId: string; sessionId: string }>('admin.goal.create', {
        sessionId: 'source', workspace: '/repo', condition: 'ship', origin: 'human-ui',
      });
      const fork = await client.request<{ goalId: string; sessionId: string; status: string; sourceGoalId: string; sourceSessionId: string }>('admin.goal.fork', {
        sourceSessionId: source.sessionId, sourceGoalId: source.goalId, targetSessionId: 'target',
      });
      expect(fork).toMatchObject({ sessionId: 'target', status: 'disarmed', sourceGoalId: source.goalId, sourceSessionId: 'source' });
      expect(fork.goalId).not.toBe(source.goalId);
    } finally {
      await client.close(); runtime.close();
    }
  });
});
