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
      // config/import/export 与资料 Wiki RPC 已随任务面下线：整个入口返回 METHOD_NOT_FOUND，
      // 记忆不可能经它们回流。
      for (const [method, args] of [
        ['admin.config.update', { module: 'memory', value: { enabled: true }, version: 0 }],
        ['admin.jobs.create', { kind: 'memory_extract', workspace: '/repo' }],
        ['admin.import', { data: {} }],
        ['admin.export', {}],
        ['wiki.create', { name: 'Keep Wiki' }],
      ] as const) {
        // wiki.* 在项目连接上是 FORBIDDEN（管理受限），其余是 METHOD_NOT_FOUND；两者都意味着能力不可达。
        await expect(host.request(method, args as never)).rejects.toMatchObject({ code: expect.stringMatching(/METHOD_NOT_FOUND|FORBIDDEN/) });
      }
      await expect(host.request('thread.list')).resolves.toEqual([]);
    } finally {
      await host.close();
      await project.close();
      runtime.close();
      await runtime.waitClosed();
    }
  });
});
