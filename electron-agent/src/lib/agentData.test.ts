import { describe, expect, it, vi } from 'vitest';
import { agentDataApi } from './agentData';
import * as runtime from '../platform/runtime';

describe('agentDataApi', () => {
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

  it('passes explicit Memory owners, users, cursors and revisions without using a chat workspace', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      expect(agentDataApi.memory).toHaveProperty('list', expect.any(Function));
      const query = { userId: 'u', filter: { scope: 'all' as const }, query: '', cursor: 'cursor', limit: 50 };
      const read = { userId: 'u', id: 'm' };
      const draft = { content: 'manual', level: 1 as const, owner: { scope: 'global' as const }, source: undefined };
      await agentDataApi.memory.list(query);
      await agentDataApi.memory.read(read);
      await agentDataApi.memory.create({ userId: 'u', draft });
      await agentDataApi.memory.update({ ...read, draft, expectedRevision: 3 });
      await agentDataApi.memory.conversations.list(query);
      await agentDataApi.memory.conversations.read(read);
      await agentDataApi.memory.delete({ userId: 'u' }, 'm');
      expect(spy.mock.calls).toEqual([
        ['agentData_memory_list', query], ['agentData_memory_read', read], ['agentData_memory_create', { userId: 'u', draft }],
        ['agentData_memory_update', { ...read, draft, expectedRevision: 3 }], ['agentData_memory_conversations_list', query],
        ['agentData_memory_conversations_read', read], ['agentData_memory_delete', { userId: 'u', id: 'm' }],
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
    await agentDataApi.memory.overview({ userId: 'u', workspace: '/w' });
    await agentDataApi.wiki.overview();
    await agentDataApi.code.status('/w');
    await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(1, 'agentData_memory_overview', { userId: 'u', workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(2, 'agentData_wiki_list');
    expect(spy).toHaveBeenNthCalledWith(3, 'agentData_code_status', { workspace: '/w' });
    expect(spy).toHaveBeenNthCalledWith(4, 'agentData_jobs_create', { kind: 'wiki.sync', workspace: '/w' });
    await agentDataApi.memory.overview({ userId: 'u', includeOtherProjects: true });
    expect(spy).toHaveBeenLastCalledWith('agentData_memory_overview', { userId: 'u', includeOtherProjects: true });
    spy.mockRestore();
  });

  it('does not expose Goal RPC on the renderer API', () => {
    expect(agentDataApi.goals).toBeUndefined();
  });
});
