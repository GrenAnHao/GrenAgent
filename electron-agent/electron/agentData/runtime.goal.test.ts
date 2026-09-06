import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

describe('AgentDataRuntime Goal RPC', () => {
  it('scopes project Goal RPCs to the endpoint workspace and session resolver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-goal-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db'), resolveSession: (workspace, sessionId) => workspace === '/repo' && sessionId === 's1' });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      const goal = await root.request<{ goalId: string; revision: number }>('admin.goal.create', { sessionId: 's1', workspace: '/repo', condition: 'ship it', origin: 'human-ui' });
      await expect(project.request('goal.get', { sessionId: 's2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(project.request('goal.get', { sessionId: 's1', workspace: '/other' })).resolves.toMatchObject({ goalId: goal.goalId });
      await expect(project.request('goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision, action: 'pause' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(root.request('admin.goal.update', { sessionId: 's1', goalId: goal.goalId, revision: goal.revision, action: 'pause', origin: 'human-ui' })).resolves.toMatchObject({ status: 'paused' });
      await expect(root.request('admin.goal.history', { sessionId: 's1' })).resolves.toHaveLength(2);
    } finally {
      await project.close(); await root.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
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
    } finally {
      await client.close(); runtime.close();
    }
  });

  it('allows an authorized project endpoint to submit a judge result', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', resolveSession: (workspace, sessionId) => workspace === '/repo' && sessionId === 's' });
    const root = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    try {
      const goal = await root.request<{ goalId: string; revision: number }>('admin.goal.create', { sessionId: 's', workspace: '/repo', condition: 'ship', origin: 'human-ui' });
      const judging = await root.request<{ revision: number }>('admin.goal.update', { sessionId: 's', goalId: goal.goalId, revision: goal.revision, action: 'begin_judging', origin: 'human-ui' });
      await expect(project.request('goal.judgeResult', { sessionId: 's', goalId: goal.goalId, revision: judging.revision, verdict: 'error', reason: 'judge unavailable' })).resolves.toMatchObject({ status: 'error' });
    } finally {
      await project.close(); await root.close(); runtime.close();
    }
  });
});
