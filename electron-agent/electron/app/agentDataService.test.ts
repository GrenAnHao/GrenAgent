import { describe, expect, it } from 'vitest';
import { AgentDataService } from './agentDataService';

describe('AgentDataService', () => {
  it('starts, reports status and shuts down', async () => {
    const service = new AgentDataService({ dataPath: ':memory:' });
    await expect(service.start()).resolves.toMatchObject({ version: 1 });
    await expect(service.status()).resolves.toMatchObject({ state: 'ready' });
    await service.stop();
  });
});
