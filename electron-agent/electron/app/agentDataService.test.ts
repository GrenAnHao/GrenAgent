import { describe, expect, it, vi } from 'vitest';
import { AgentDataService } from './agentDataService';
import { AgentDataClient } from '../agentData/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AgentDataService', () => {
  it('keeps queued memory extraction recoverable while stopping a Wiki executor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wiki-stop-memory-')); let release!: (value: string) => void;
    const execute = vi.fn(async (task: { kind: string }) => {
      if (task.kind === 'wiki_page_generate') return new Promise<string>((resolve) => { release = resolve; });
      if (task.kind === 'memory_scene') return { scenes: [] };
      if (task.kind === 'memory_persona') return { content: '# Team Operating Doctrine' };
      return { l1: [{ content: 'resumedmemory', type: 'work_fact', priority: 80 }] };
    });
    const service = new AgentDataService({ dataPath: join(directory, 'data.db'), executeServiceTask: execute });
    await service.start();
    const work = service.runServiceTask({ id: 'wiki-hold', kind: 'wiki_page_generate', input: { source: 'A' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const scope = { userId: 'local', workspace: '/repo', sessionId: 's', source: 'session:s' };
    try {
      await service.request('memory.capture', { ...scope, transcript: 'user: resumedmemory', fingerprint: 'first' });
      const stopped = service.stop();
      await vi.waitFor(() => expect(service.endpoint()).toBeUndefined());
      release('# complete'); await work; await stopped;
      await service.start();
      await vi.waitFor(async () => expect(await service.request('memory.search', { ...scope, query: 'resumedmemory' })).toHaveLength(1));
    } finally { release('# complete'); await work.catch(() => {}); await service.stop(); rmSync(directory, { recursive: true, force: true }); }
  });

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
    const service = new AgentDataService({ dataPath: ':memory:', validateProject: async (p) => p });
    await service.start(); let oldClient: AgentDataClient | undefined; let nextClient: AgentDataClient | undefined;
    try {
      expect(service).toHaveProperty('agentEndpoint', expect.any(Function));
      const previous = service.agentEndpoint('D:/a');
      await service.stop(); await service.start();
      const next = service.agentEndpoint('D:/a');
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

  it('queues Wiki and memory work together so waiting does not consume the execution timeout', async () => {
    let releaseWiki!: (value: string) => void;
    const wikiResult = new Promise<string>((resolve) => { releaseWiki = resolve; });
    const started: string[] = [];
    const service = new AgentDataService({ dataPath: ':memory:', executeServiceTask: async (task) => {
      started.push(task.kind);
      if (task.kind === 'wiki_page_generate') return wikiResult;
      if (task.kind === 'memory_scene') return { scenes: [] };
      if (task.kind === 'memory_persona') return { content: '# Team Operating Doctrine' };
      return { l1: [{ content: 'prefer dark', type: 'work_fact', priority: 80 }] };
    } });
    await service.start();
    let wiki: Promise<unknown> | undefined;
    try {
      expect(service).toHaveProperty('runServiceTask', expect.any(Function));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      wiki = service.runServiceTask({ id: 'wiki-1', kind: 'wiki_page_generate', input: { source: '# Guide' } });
      await vi.waitFor(() => expect(started).toEqual(['wiki_page_generate']));
      const scope = { userId: 'local', workspace: '/repo', sessionId: 'session-1', source: 'session:session-1' };
      await service.request('memory.capture', { ...scope, transcript: 'user: prefer dark', fingerprint: 'first' });

      await vi.advanceTimersByTimeAsync(35_000);
      expect(started).toEqual(['wiki_page_generate']);
      releaseWiki('# Wiki');
      await expect(wiki).resolves.toBe('# Wiki');
      await vi.waitFor(() => expect(started.slice(0, 2)).toEqual(['wiki_page_generate', 'memory_extract']));
      await expect(service.request('memory.search', { ...scope, query: 'dark' })).resolves.toEqual([
        expect.objectContaining({ content: expect.stringContaining('dark') }),
      ]);
    } finally {
      releaseWiki('# Wiki');
      await wiki?.catch(() => {});
      vi.useRealTimers();
      await service.stop();
    }
  });
});
