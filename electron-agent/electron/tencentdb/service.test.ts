import { describe, expect, it } from 'vitest';
import { TencentDbService, type TencentDbSecretStore } from './service';

function secrets(values: Record<string, string> = {}): TencentDbSecretStore {
  const store = new Map(Object.entries(values));
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => void store.set(key, value),
    clear: async (key) => void store.delete(key),
  };
}

describe('TencentDB service', () => {
  it('keeps local credentials deterministic per gateway key', async () => {
    const service = new TencentDbService({ secrets: secrets({ localGatewayApiKey: 'gateway-key' }) });
    const first = await service.resolveCredentials();
    const second = await service.resolveCredentials();
    expect(first.gatewayApiKey).toBe('gateway-key');
    expect(first.userKey).toBe(second.userKey);
    expect(first.userKey).toMatch(/^sk-mem-[a-f0-9]{32}$/);
  });

  it('rejects remote configuration without both endpoints and credentials', async () => {
    const service = new TencentDbService({ secrets: secrets() });
    await expect(service.saveConnection({
      config: {
        mode: 'remote',
        endpoint: 'https://gateway.example',
        serviceId: 'service-a',
        teamId: 'team-a',
        agentId: 'agent-a',
        userId: 'user-a',
      },
    })).rejects.toThrow('TencentDB remote Knowledge endpoint is required');
  });
});
