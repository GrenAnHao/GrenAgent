import { describe, expect, it, vi } from 'vitest';
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

  it('dispatches a created job to its registered runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobrunner-'));
    const started: Array<{ id: string; workspace: string }> = [];
    let release!: () => void;
    let released = false;
    const gate = new Promise<void>((resolve) => {
      release = () => { released = true; resolve(); };
    });
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      jobRunners: {
        'wiki.sync': {
          run: async (id, workspace) => {
            started.push({ id, workspace });
            await gate;
          },
          cancel: () => {},
        },
      },
    });
    const client = new AgentDataClient(await runtime.start());

    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });
    // create 必须 fire-and-forget：返回时 gate 还没 resolve，证明没有 await run。
    expect(released).toBe(false);
    expect(started).toEqual([{ id: job.id, workspace: '/repo' }]);
    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'pending' });

    // 同 workspace 同 kind 并发创建被拒绝（避免两个同步进程写同一份索引）。
    await expect(client.request('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' })).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
    // 没有注册 runner 的 kind 仍然只落库，不报错、不做并发拒绝。
    await expect(client.request('admin.jobs.create', { kind: 'unknown.kind', workspace: '/repo' })).resolves.toMatchObject({ state: 'pending' });

    release();
    await gate;
    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('does not record a runner rejection as failure after the job is already terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobfail-terminal-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runResult: Promise<void> | undefined;
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      jobRunners: {
        'wiki.sync': {
          run: () => {
            runResult = gate.then(() => { throw new Error('runner stopped'); });
            return runResult;
          },
          cancel: () => {},
        },
      },
    });
    const client = new AgentDataClient(await runtime.start());
    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });
    await client.request('admin.jobs.markCancelled', { id: job.id });

    release();
    await runResult?.catch(() => {});

    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'cancelled' });
    const audit = await client.request<Array<{ action: string }>>('admin.audit.list');
    expect(audit.map((event) => event.action)).not.toContain('job.fail');

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('defers the cancelled state to the runner so no work happens after it lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobcancel-'));
    const cancelRequests: string[] = [];
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      jobRunners: { 'wiki.sync': { run: () => new Promise(() => {}), cancel: (id) => { cancelRequests.push(id); } } },
    });
    const client = new AgentDataClient(await runtime.start());
    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });

    // 取消只是"请求"：runner 收到通知，状态还没落定。
    await client.request('admin.jobs.cancel', { id: job.id });
    expect(cancelRequests).toEqual([job.id]);
    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'pending' });

    // runner 确认停止后才写状态。
    await client.request('admin.jobs.markCancelled', { id: job.id });
    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'cancelled' });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('cancels a runner-less job immediately because nothing is running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobcancel-none-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'unknown.kind', workspace: '/repo' });

    await expect(client.request('admin.jobs.cancel', { id: job.id })).resolves.toMatchObject({ state: 'cancelled' });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('delegates code retrieval queries to the injected provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-code-'));
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      codeRetrieval: {
        projects: () => [{ workspace: '/repo', indexed: true }, { workspace: '/bare', indexed: false }],
        status: (workspace) => ({ workspace, connected: true, indexed: true, files: 12, nodes: 34, edges: 56 }),
        search: async (workspace, query) => ({ workspace, available: true, results: [{ file: 'src/a.ts', line: 3, symbol: query }] }),
      },
    });
    const client = new AgentDataClient(await runtime.start());

    await expect(client.request('codeRetrieval.admin.projects')).resolves.toEqual([
      { workspace: '/repo', indexed: true }, { workspace: '/bare', indexed: false },
    ]);
    await expect(client.request('codeRetrieval.admin.status', { workspace: '/repo' })).resolves.toMatchObject({ indexed: true, files: 12 });
    await expect(client.request('codeRetrieval.search', { workspace: '/repo', query: 'parse', limit: 5 }))
      .resolves.toMatchObject({ available: true, results: [{ symbol: 'parse' }] });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('reports code retrieval as unavailable when no provider is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-code-none-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());

    await expect(client.request('codeRetrieval.admin.projects')).resolves.toEqual([]);
    await expect(client.request('codeRetrieval.admin.status', { workspace: '/repo' })).resolves.toMatchObject({ connected: false, indexed: false });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
});
