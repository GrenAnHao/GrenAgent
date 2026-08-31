import { describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

describe('AgentDataClient', () => {
  it('times out requests', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', methods: { 'slow.test': async () => new Promise(() => {}) } });
    const endpoint = await runtime.start();
    const client = new AgentDataClient(endpoint, { timeoutMs: 20 });
    await expect(client.request('slow.test')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await client.close(); runtime.close();
  });
});
