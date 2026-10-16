import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { agentDataTiming } from './methodTiming';

describe('AgentDataRuntime sync timing', () => {
  let runtime: AgentDataRuntime;
  let client: AgentDataClient;

  beforeEach(async () => {
    agentDataTiming.drain();
    runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    client = new AgentDataClient(await runtime.start());
  });

  afterEach(async () => {
    await client.close();
    runtime.close();
    agentDataTiming.drain();
  });

  it('records socket requests by method, folding unresolved names into fixed labels', async () => {
    const params = { userId: 'u', workspace: '/a', sessionId: 's', source: 'session:s', transcript: 'user: one', fingerprint: 'fp1' };
    await client.request('system.status');
    await client.request('memory.capture', params);
    await expect(client.request('no.such.method')).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(client.request('system.nope')).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(new AgentDataClient({ ...(runtime.getEndpoint()!), token: 'bad' }).request('system.status')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const sample = agentDataTiming.drain()!;
    const methods = new Map(sample.methods.map((row) => [row.method, row]));
    expect(methods.get('system.status')?.n).toBe(1);
    expect(methods.get('memory.capture')).toMatchObject({ n: 1 });
    expect(methods.get('memory.capture')!.totalMs).toBeGreaterThanOrEqual(methods.get('memory.capture')!.syncMs);
    expect(methods.get('rejected')?.n).toBe(2);
    expect(methods.get('invalid')?.n).toBe(1);
    expect(methods.has('no.such.method')).toBe(false);
    expect(sample.n).toBe(5);
    expect(agentDataTiming.nested).toBe(false);
  });

  it('records trusted admin calls and keeps the existing error shape', async () => {
    await runtime.requestAdmin('admin.tasks.list', { limit: 5 });
    await expect(runtime.requestAdmin('admin.nothing')).rejects.toThrow('METHOD_NOT_FOUND: unknown management method: admin.nothing');
    const methods = new Map(agentDataTiming.drain()!.methods.map((row) => [row.method, row]));
    expect(methods.get('admin.tasks.list')?.n).toBe(1);
    expect(methods.get('admin.unknown')?.n).toBe(1);
    expect(agentDataTiming.nested).toBe(false);
  });
});
