import { describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

describe('retired Memory RPCs', () => {
  it('rejects old Memory entry points on host, project and management connections while Wiki and threads still work', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const host = new AgentDataClient(await runtime.start());
    const project = new AgentDataClient(runtime.agentEndpoint('/repo'));
    const params = { userId: 'local', workspace: '/repo', query: 'old', level: 1, content: 'old' };
    try {
      for (const method of ['memory.capture', 'memory.upsert', 'memory.search', 'memory.conversations.search', 'memory.admin.overview', 'memory.delete']) {
        await expect(host.request(method, params), method).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
        await expect(project.request(method, params), method).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
      }
      for (const method of ['memory.list', 'memory.create', 'memory.update', 'memory.conversations.list']) {
        await expect(runtime.requestAdmin(method, params)).rejects.toThrow('METHOD_NOT_FOUND');
      }
      await expect(host.request('admin.config.update', { module: 'memory', value: { enabled: true }, version: 0 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(host.request('admin.jobs.create', { kind: 'memory_extract', workspace: '/repo' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await host.request('admin.import', { data: { configs: { memory: { version: 1, value: { enabled: true } }, codeRetrieval: { version: 1, value: { enabled: true } } } } });
      const exported = await host.request<{ jobs: unknown[]; configs: Record<string, unknown> }>('admin.export');
      expect(exported.jobs).toEqual([]);
      expect(exported.configs).toHaveProperty('codeRetrieval');
      expect(exported.configs).not.toHaveProperty('memory');
      await expect(runtime.requestAdmin('wiki.create', { name: 'Keep Wiki' })).resolves.toMatchObject({ name: 'Keep Wiki' });
      await expect(project.request('wiki.list')).resolves.toEqual([expect.objectContaining({ name: 'Keep Wiki' })]);
      await expect(host.request('thread.list')).resolves.toEqual([]);
      const overview = await runtime.requestAdmin('admin.overview');
      expect(overview).not.toHaveProperty('recentMemories');
    } finally {
      await host.close();
      await project.close();
      runtime.close();
      await runtime.waitClosed();
    }
  });
});
