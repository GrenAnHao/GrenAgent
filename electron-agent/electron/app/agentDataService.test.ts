import { describe, expect, it, vi } from 'vitest';
import { AgentDataService } from './agentDataService';
import { AgentDataClient } from '../agentData/client';

describe('AgentDataService', () => {

  it('does not finish stopping until an existing Wiki executor has actually settled', async () => {
    let release!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const service = new AgentDataService({ dataPath: ':memory:', executeServiceTask: execute });
    await service.start();
    const work = service.runServiceTask({ id: 'drain-task', kind: 'wiki_page_generate', input: { source: 'A' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let stopped = false; const stop = service.stop().then(() => { stopped = true; });
    try {
      await vi.waitFor(() => expect(service.endpoint()).toBeUndefined());
      expect(stopped).toBe(false);
    } finally { release('# done'); await work; await stop; }
    expect(stopped).toBe(true);
  });

  it('rotates project credentials across a service restart and preserves the admin entry', async () => {
    const service = new AgentDataService({ dataPath: ':memory:' });
    await service.start(); let oldClient: AgentDataClient | undefined; let nextClient: AgentDataClient | undefined;
    try {
      expect(service).toHaveProperty('agentEndpoint', expect.any(Function));
      const previous = await service.agentEndpoint('D:/a');
      await service.stop(); await service.start();
      const next = await service.agentEndpoint('D:/a');
      expect(next.token === previous.token).toBe(false);
      oldClient = new AgentDataClient({ ...next, token: previous.token }); nextClient = new AgentDataClient(next);
      await expect(oldClient.request('wiki.list')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(nextClient.request('wiki.list')).resolves.toEqual([]);
      await expect(service.requestAdmin('wiki.create', { name: '无关联' })).resolves.toMatchObject({ name: '无关联' });
    } finally { await oldClient?.close(); await nextClient?.close(); await service.stop(); }
  });

  it('starts, reports status and shuts down', async () => {
    const service = new AgentDataService({ dataPath: ':memory:' });
    await expect(service.start()).resolves.toMatchObject({ version: 1 });
    await expect(service.status()).resolves.toMatchObject({ state: 'ready' });
    await service.stop();
  });

  it('allows CodeGraph requests to exceed the short standalone client timeout', async () => {
    const service = new AgentDataService({ dataPath: ':memory:', methods: {
      'codeRetrieval.call': () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 6_000)),
    } });
    await service.start();
    try {
      const request = service.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: {} });
      await expect(request).resolves.toEqual({ ok: true });
    } finally {
      await service.stop();
    }
  }, 15_000);

});
