import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataService } from '../app/agentDataService';
import { agentDataPipePath } from '../agentDataProcess/pipePath';
import { __resetForTest } from '../../../extensions/_shared/runtime-config.js';

const originalConfig = process.env.PI_RUNTIME_CONFIG;
const services: AgentDataService[] = [];
const roots: string[] = [];
const cleanupGates: Array<() => void> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  cleanupGates.push(() => resolve(undefined as T));
  return { promise, resolve };
}

function setup(completeSimple: NonNullable<ConstructorParameters<typeof AgentDataRuntime>[0]['completeSimple']>, describeModel = async () => 'configured/model') {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-completion-'));
  roots.push(root);
  const config = join(root, 'settings.json');
  writeFileSync(config, JSON.stringify({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1', KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '1', KNOWLEDGE_WIKI_INGEST_MODE: 'single-stage' }));
  process.env.PI_RUNTIME_CONFIG = config;
  __resetForTest();
  const dataPath = join(root, 'agent-data.db');
  const runtime = new AgentDataRuntime({ dataPath, wikiRootDir: join(root, 'wiki'), listenPath: agentDataPipePath(), completeSimple, describeModel });
  const service = new AgentDataService({ runtime });
  services.push(service);
  return { runtime, service, dataPath, config };
}

afterEach(async () => {
  for (const release of cleanupGates.splice(0)) release();
  for (const service of services.splice(0)) await service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.PI_RUNTIME_CONFIG;
  else process.env.PI_RUNTIME_CONFIG = originalConfig;
  __resetForTest();
});

describe('host knowledge completion shares the production Wiki scheduler', () => {
  it('waits behind actual Wiki ingest and preserves the RepoWiki JSON request', async () => {
    const release = deferred();
    const inputs: any[] = [];
    const { runtime, service } = setup(async (input) => {
      inputs.push(input);
      if (input.user !== 'repo exact input') { await release.promise; return ''; }
      return '{"title":"page","body":"json output"}';
    });
    await service.start();
    const wiki = await runtime.requestAdmin<{ wikiId: string }>('wiki.create', { name: 'Existing Wiki' });
    await runtime.requestAdmin('wiki.rawWrite', { wikiId: wiki.wikiId, filename: 'source.md', content: 'Repository architecture source' });
    const ingest = runtime.requestAdmin('wiki.ingest', { wikiId: wiki.wikiId }).catch(() => undefined);
    await vi.waitFor(() => expect(inputs.length).toBeGreaterThan(0));
    const expectedConfiguration = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const request = service.completeKnowledge({ systemPrompt: 'strict repo JSON system', user: 'repo exact input', maxTokens: 1600, expectedModel: 'configured/model', expectedConfiguration, sourceProjectId: 'approved-project' });
    try {
      await new Promise((done) => setTimeout(done, 20));
      expect(inputs.filter((input) => input.user === 'repo exact input')).toHaveLength(0);
    } finally { release.resolve(); }
    await expect(request).resolves.toBe('{"title":"page","body":"json output"}');
    await ingest;
    expect(inputs.find((input) => input.user === 'repo exact input')).toMatchObject({ systemPrompt: 'strict repo JSON system', maxTokens: 1600, expectedConfiguration });
    await expect(service.describeKnowledgeModel()).resolves.toBe('configured/model');
  });

  it('cancels a queued request promptly and never dispatches it later', async () => {
    const release = deferred();
    const seen: string[] = [];
    const { service } = setup(async ({ user }) => { seen.push(user); if (user === 'active') await release.promise; return '{}'; });
    await service.start();
    const active = service.completeKnowledge({ user: 'active' });
    await vi.waitFor(() => expect(seen).toEqual(['active']));
    const controller = new AbortController();
    const cancelled = service.completeKnowledge({ user: 'cancelled' }, { signal: controller.signal });
    controller.abort();
    try { await expect(cancelled).rejects.toThrow(/abort|cancel/i); }
    finally { release.resolve(); }
    await active;
    await expect(service.completeKnowledge({ user: 'after' })).resolves.toBe('{}');
    expect(seen).toEqual(['active', 'after']);
  });

  it('keeps an aborted active provider in the budget until it really settles', async () => {
    const release = deferred();
    const seen: string[] = [];
    let signal: AbortSignal | undefined;
    const { service } = setup(async (input) => {
      seen.push(input.user);
      if (input.user === 'ignores-abort') { signal = input.signal; await release.promise; }
      return '{}';
    });
    await service.start();
    const controller = new AbortController();
    const first = service.completeKnowledge({ user: 'ignores-abort' }, { signal: controller.signal });
    const failure = first.catch((error: Error) => error.message);
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    const next = service.completeKnowledge({ user: 'next' });
    try {
      await new Promise((done) => setTimeout(done, 20));
      expect(signal!.aborted).toBe(true);
      expect(seen).toEqual(['ignores-abort']);
    } finally { release.resolve(); }
    expect(await failure).toMatch(/abort|cancel/i);
    await next;
    expect(seen).toEqual(['ignores-abort', 'next']);
  });

  it('checks the expected model at actual dispatch after waiting', async () => {
    const release = deferred();
    const seen: string[] = [];
    let model = 'provider/old';
    const { service } = setup(async ({ user }) => { seen.push(user); if (user === 'active') await release.promise; return '{}'; }, async () => model);
    await service.start();
    const active = service.completeKnowledge({ user: 'active' });
    await vi.waitFor(() => expect(seen).toEqual(['active']));
    const waiting = service.completeKnowledge({ user: 'stale', expectedModel: 'provider/old' });
    const failure = waiting.catch((error: Error) => error.message);
    model = 'provider/new';
    release.resolve();
    await active;
    expect(await failure).toContain('MODEL_CHANGED');
    expect(seen).toEqual(['active']);
  });

  it('refreshes the configured concurrency without losing already active work', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const seen: string[] = [];
    const { service, config } = setup(async ({ user }) => {
      seen.push(user);
      if (user === 'first') await firstGate.promise;
      if (user === 'second') await secondGate.promise;
      return '{}';
    });
    await service.start();
    const first = service.completeKnowledge({ user: 'first' });
    await vi.waitFor(() => expect(seen).toEqual(['first']));
    const second = service.completeKnowledge({ user: 'second' });
    writeFileSync(config, JSON.stringify({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '2' }));
    const third = service.completeKnowledge({ user: 'third' });
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']));
    writeFileSync(config, JSON.stringify({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1' }));
    const fourth = service.completeKnowledge({ user: 'fourth' });
    // Both calls share facade startup; let fourth enter the runtime before
    // releasing first so the new budget has actually been read.
    await service.describeKnowledgeModel();
    firstGate.resolve();
    await first;
    await new Promise((done) => setTimeout(done, 20));
    expect(seen).toEqual(['first', 'second']);
    secondGate.resolve();
    await Promise.all([second, third, fourth]);
    expect(seen).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('shutdown aborts active calls and drains before closing storage', async () => {
    let signal: AbortSignal | undefined;
    const { service } = setup((input) => new Promise((_resolve, reject) => {
      signal = input.signal;
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await service.start();
    const running = service.completeKnowledge({ user: 'active' });
    const failure = running.catch((error: Error) => error.message);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const waiting = service.completeKnowledge({ user: 'queued' }).catch((error: Error) => error.message);
    await service.stop();
    expect(signal!.aborted).toBe(true);
    expect(await failure).toMatch(/abort/i);
    expect(await waiting).toMatch(/abort|not started/i);
  });
});
