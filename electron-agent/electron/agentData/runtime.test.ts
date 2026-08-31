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

  it('returns VERSION_CONFLICT for stale admin config writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-admin-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    await expect(client.request('admin.config.update', { module: 'memory', value: { enabled: true }, version: 0 })).resolves.toMatchObject({ version: 1 });
    await expect(client.request('admin.config.update', { module: 'memory', value: { enabled: false }, version: 0 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
});
