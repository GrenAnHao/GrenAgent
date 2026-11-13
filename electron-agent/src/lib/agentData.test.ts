import { describe, expect, it, vi } from 'vitest';
import { agentDataApi } from './agentData';
import * as runtime from '../platform/runtime';

describe('agentDataApi', () => {
  it('does not expose retired capabilities', () => {
    // 已下线：长期记忆、任务产品面（重试/详情）、审计、诊断、概览、资料 Wiki。
    for (const retired of ['memory', 'tasks', 'audits', 'checks', 'overview', 'wiki', 'config', 'audit', 'diagnostics', 'export', 'import', 'start', 'stop']) {
      expect(agentDataApi).not.toHaveProperty(retired);
    }
  });

  it('routes code index queries through fixed commands', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await agentDataApi.jobs.create({ kind: 'codegraph.sync', workspace: '/w' });
      await agentDataApi.code.projects();
      await agentDataApi.code.status('/w');
      await agentDataApi.code.search('/w', 'parse', 5);
      await agentDataApi.code.call({ workspace: '/w', tool: 'codegraph_search', args: { query: 'x' } } as never);
      expect(spy.mock.calls).toEqual([
        ['agentData_jobs_create', { kind: 'codegraph.sync', workspace: '/w' }],
        ['agentData_code_projects'],
        ['agentData_code_status', { workspace: '/w' }],
        ['agentData_code_search', { workspace: '/w', query: 'parse', limit: 5 }],
        ['agentData_code_call', { workspace: '/w', tool: 'codegraph_search', args: { query: 'x' } }],
      ]);
    } finally { spy.mockRestore(); }
  });

  it('does not expose Goal RPC on the renderer API', () => {
    for (const retired of ['goal', 'goals', 'goalEvents', 'updateGoal']) {
      expect(agentDataApi).not.toHaveProperty(retired);
    }
  });
});
