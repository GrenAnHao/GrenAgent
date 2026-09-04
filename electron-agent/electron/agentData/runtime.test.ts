import { describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AgentDataRuntime', () => {
  it('serves hello/status and rejects invalid or unknown requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const endpoint = await runtime.start();
    const client = new AgentDataClient(endpoint);
    await expect(client.request('system.hello')).resolves.toMatchObject({ version: 1 });
    await expect(client.request('system.status')).resolves.toMatchObject({ state: 'ready' });
    await expect(client.request('no.such.method')).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(new AgentDataClient({ ...endpoint, token: 'bad' }).request('system.status')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await client.close();
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits when stdin reaches EOF', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', stdin: undefined });
    await runtime.start();
    runtime.handleStdinEnd();
    expect(runtime.isClosed()).toBe(true);
  });

  it('exposes durable memory capture and commit RPCs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-capture-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const endpoint = await runtime.start();
    const client = new AgentDataClient(endpoint);
    const params = { userId: 'u', workspace: '/a', sessionId: 's', source: 'session:s', transcript: 'user: one', fingerprint: 'fp1' };
    await expect(client.request('memory.capture', params)).resolves.toMatchObject({ changed: true, delta: 'user: one' });
    await expect(client.request('memory.commitCapture', params)).resolves.toBeNull();
    await expect(client.request('memory.capture', params)).resolves.toMatchObject({ changed: false, delta: '' });
    await client.close();
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes memory extraction through the configured system task executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-worker-'));
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      executeServiceTask: async () => ({ l1: { theme: 'dark' } }),
    });
    const client = new AgentDataClient(await runtime.start());
    const params = { userId: 'u', workspace: '/a', projectId: '/a', sessionId: 's', source: 'session:s', transcript: 'user: dark mode', fingerprint: 'fp1' };

    const capture = await client.request<{ taskId: string }>('memory.capture', params);
    await expect.poll(() => client.request<Array<{ content: string }>>('memory.search', { ...params, query: 'dark', limit: 10 })).toEqual([
      expect.objectContaining({ content: '{"theme":"dark"}' }),
    ]);
    expect(capture.taskId).toBeTruthy();

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('returns VERSION_CONFLICT for stale admin config writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-admin-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    await expect(client.request('admin.config.update', { module: 'memory', value: { enabled: true }, version: 0 })).resolves.toMatchObject({ version: 1 });
    await expect(client.request('admin.config.update', { module: 'memory', value: { enabled: false }, version: 0 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('exposes module overview and code retrieval status contracts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-overview-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    const scope = { userId: 'u', workspace: '/workspace' };

    await expect(client.request('memory.admin.overview', scope)).resolves.toMatchObject({
      total: 0,
      byLevel: { L0: 0, L1: 0, L2: 0, L3: 0 },
    });
    await client.request('memory.upsert', { ...scope, level: 1, content: 'a' });
    await client.request('memory.upsert', { ...scope, level: 3, content: 'b' });
    await expect(client.request('memory.admin.overview', scope)).resolves.toMatchObject({
      total: 2,
      byLevel: { L0: 0, L1: 1, L2: 0, L3: 1 },
    });

    await expect(client.request('wiki.admin.overview', { workspace: '/workspace' })).resolves.toMatchObject({
      pages: 0,
      latestUpdatedAt: null,
    });
    await client.request('wiki.replace', { workspace: '/workspace', page: 'guide', title: 'Guide', content: '# Guide\nbody' });
    await expect(client.request('wiki.admin.overview', { workspace: '/workspace' })).resolves.toMatchObject({
      pages: 1,
      latestUpdatedAt: expect.any(Number),
    });

    await expect(client.request('codeRetrieval.admin.status')).resolves.toMatchObject({
      connected: false,
      indexed: false,
    });
    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('answers memory overview and search globally when no workspace is supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-global-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());

    await client.request('memory.upsert', { userId: 'u', workspace: '/repo-a', level: 1, content: 'alpha fact' });
    await client.request('memory.upsert', { userId: 'u', workspace: '/repo-b', level: 1, content: 'beta fact' });

    await expect(client.request('memory.admin.overview', { userId: 'u', includeOtherProjects: true }))
      .resolves.toMatchObject({ total: 2, byLevel: { L0: 0, L1: 2, L2: 0, L3: 0 } });
    await expect(client.request<Array<{ content: string }>>('memory.search', { userId: 'u', includeOtherProjects: true, query: 'fact', limit: 10 }))
      .resolves.toHaveLength(2);

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('filters admin jobs by requested state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobs-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    await client.request('admin.jobs.create', { kind: 'wiki-sync', workspace: '/workspace' });
    await expect(client.request('admin.jobs.list', { state: 'running' })).resolves.toEqual([]);
    await expect(client.request('admin.jobs.list')).resolves.toHaveLength(1);
    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
});
