import { describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

describe('AgentData job cleanup RPC', () => {
  it('removes only terminal records and preserves Wiki, memory and audit data', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const create = () => client.request<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: '/repo' });
      const done = await create(); const cancelled = await create(); const active = await create(); const waiting = await create();
      await client.request('admin.jobs.complete', { id: done.id });
      await client.request('admin.jobs.cancel', { id: cancelled.id });
      await client.request('admin.jobs.start', { id: active.id });
      await runtime.requestAdmin('wiki.replace', { workspace: '/repo', page: 'guide', title: 'Guide', content: '# Retained wiki' });
      await client.request('memory.upsert', { userId: 'local', workspace: '/repo', level: 1, content: 'retained memory' });
      const audit = await client.request<unknown[]>('admin.audit.list');

      await expect(client.request('admin.jobs.remove', { id: active.id })).rejects.toMatchObject({ code: 'JOB_ACTIVE' });
      await expect(client.request('admin.jobs.remove', { id: cancelled.id })).resolves.toEqual({ deleted: true });
      await expect(client.request('admin.jobs.clear', { ids: [done.id, cancelled.id, active.id, waiting.id] })).resolves.toEqual({ deletedIds: [done.id] });
      const remaining = await client.request<Array<{ id: string }>>('admin.jobs.list');
      expect(remaining.map((job) => job.id).sort()).toEqual([active.id, waiting.id].sort());
      await expect(runtime.requestAdmin('wiki.read', { workspace: '/repo', page: 'guide' })).resolves.toMatchObject({ content: '# Retained wiki' });
      await expect(client.request('memory.search', { userId: 'local', workspace: '/repo', query: 'retained' })).resolves.toHaveLength(1);
      await expect(client.request('admin.audit.list')).resolves.toEqual(expect.arrayContaining(audit));
    } finally { await client.close(); runtime.close(); }
  });

  it('requires explicit valid IDs instead of interpreting missing input as clear-all', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });
      await client.request('admin.jobs.complete', { id: job.id });
      for (const params of [{}, { ids: null }, { ids: [job.id, 1] }, { ids: [''] }]) {
        await expect(client.request('admin.jobs.clear', params)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      }
      await expect(client.request('admin.jobs.clear', { ids: [] })).resolves.toEqual({ deletedIds: [] });
      await expect(client.request('admin.jobs.list')).resolves.toHaveLength(1);
    } finally { await client.close(); runtime.close(); }
  });
});
