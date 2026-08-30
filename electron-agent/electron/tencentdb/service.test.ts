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

  it('loads and persists the connection config through the host store', async () => {
    let saved: Record<string, unknown> | null = null;
    const service = new TencentDbService({
      configStore: {
        read: async () => ({ mode: 'remote', endpoint: 'https://gateway.example', knowledgeEndpoint: 'https://knowledge.example/v3', serviceId: 'service-a', teamId: 'team-a', agentId: 'agent-a', userId: 'user-a' }),
        write: async (config) => { saved = config; },
      },
      secrets: secrets({ remoteGatewayApiKey: 'gateway', userApiKey: 'user' }),
    });
    await service.load();
    expect(service.getConfig().serviceId).toBe('service-a');
    await service.saveConnection({ config: { ...service.getConfig(), userId: 'user-b' } });
    expect(saved).toEqual(expect.objectContaining({ userId: 'user-b' }));
  });
});
