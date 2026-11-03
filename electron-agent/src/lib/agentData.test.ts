import { describe, expect, it, vi } from 'vitest';
import { agentDataApi } from './agentData';
import * as runtime from '../platform/runtime';

describe('agentDataApi', () => {
  it('does not expose retired Memory operations', () => {
    expect(agentDataApi).not.toHaveProperty('memory');
  });
  it('uses fixed operations commands with composite task identities and bounded query inputs', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      expect(agentDataApi).toHaveProperty('tasks');
      const ref = { source: 'system' as const, id: 'same-id' };
      await agentDataApi.tasks.list({ group: 'active', cursor: 'cursor', limit: 100 });
      await agentDataApi.tasks.read(ref);
      await agentDataApi.tasks.previewRetry({ source: 'user', id: 'same-id' });
      await agentDataApi.tasks.retry({ source: 'user', id: 'same-id' }, { expectedModel: 'provider/model' });
      await agentDataApi.audits.query({ action: 'job.stage', resource: { type: 'wiki', id: 'k' } });
      await agentDataApi.audits.export({ from: 1, to: 2 });
      await agentDataApi.checks.check(); await agentDataApi.checks.open('diagnostic-id');
      await agentDataApi.overview({ userId: 'u' });
      expect(spy.mock.calls).toEqual([
        ['agentData_tasks_list', { group: 'active', cursor: 'cursor', limit: 100 }], ['agentData_tasks_read', ref],
        ['agentData_tasks_previewRetry', { source: 'user', id: 'same-id' }], ['agentData_tasks_retry', { source: 'user', id: 'same-id', expectedModel: 'provider/model' }],
        ['agentData_audit_query', { action: 'job.stage', resource: { type: 'wiki', id: 'k' } }], ['agentData_audit_export', { from: 1, to: 2 }],
        ['agentData_diagnostics_check', {}], ['agentData_diagnostics_open', { id: 'diagnostic-id' }], ['agentData_overview', { userId: 'u' }],
      ]);
    } finally { spy.mockRestore(); }
  });

  it('routes Wiki list create and overview through fixed commands', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockImplementation(async (command) => {
      if (command === 'agentData_wiki_list') return [];
      return {};
    });
    try {
      expect(agentDataApi.wiki).toHaveProperty('list', expect.any(Function));
      expect(agentDataApi.wiki).not.toHaveProperty('libraries');
      expect(agentDataApi.wiki).not.toHaveProperty('pages');
      expect(agentDataApi.wiki).not.toHaveProperty('sources');
      await agentDataApi.wiki.list();
      await agentDataApi.wiki.create({ name: '手册' });
      await agentDataApi.wiki.overview();
      expect(spy).toHaveBeenNthCalledWith(1, 'agentData_wiki_list');
      expect(spy).toHaveBeenNthCalledWith(2, 'agentData_wiki_create', { name: '手册' });
      expect(spy).toHaveBeenNthCalledWith(3, 'agentData_wiki_list');
    } finally { spy.mockRestore(); }
  });

  it('passes explicit task IDs to removal and bulk cleanup', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      expect(agentDataApi.jobs).toHaveProperty('remove');
      expect(agentDataApi.jobs).toHaveProperty('clear');
      await agentDataApi.jobs.remove('job-1');
      await agentDataApi.jobs.clear(['job-1', 'job-2']);
      expect(spy).toHaveBeenNthCalledWith(1, 'agentData_admin_jobs_remove', { id: 'job-1' });
      expect(spy).toHaveBeenNthCalledWith(2, 'agentData_admin_jobs_clear', { ids: ['job-1', 'job-2'] });
    } finally { spy.mockRestore(); }
  });
  it('uses typed IPC commands', async () => { const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({ state: 'ready', version: 1 }); await agentDataApi.status(); expect(spy).toHaveBeenCalledWith('agentData_status'); spy.mockRestore(); });

  it('exposes typed module queries and job creation', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockImplementation(async (command) => {
      if (command === 'agentData_wiki_list') return [];
      return {};
    });
    await agentDataApi.wiki.overview();
    await agentDataApi.code.status('/w');
    await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(1, 'agentData_wiki_list');
    expect(spy).toHaveBeenNthCalledWith(2, 'agentData_code_status', { workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(3, 'agentData_jobs_create', { kind: 'wiki.sync', workspace: '/w' });
    spy.mockRestore();
  });

  it('does not expose Goal RPC on the renderer API', () => {
    expect(agentDataApi.goals).toBeUndefined();
  });
});
