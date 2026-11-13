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
