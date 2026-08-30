import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TencentDbService, type TencentDbSecretStore } from './service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { await rm(path, { recursive: true, force: true }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

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

  it('sends knowledge requests to the normalized knowledge v3 endpoint with scoped credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 }));
    const service = new TencentDbService({
      fetch,
      secrets: secrets({ remoteGatewayApiKey: 'gateway', userApiKey: 'user' }),
    });
    await service.saveConnection({ config: {
      mode: 'remote', endpoint: 'https://gateway.example', knowledgeEndpoint: 'https://knowledge.example/v3',
      serviceId: 'service-a', teamId: 'team-a', agentId: 'agent-a', userId: 'user-a',
    } });

    await expect(service.knowledgeRequest('/wiki/list', { team_id: 'team-a' })).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example/v3/wiki/list', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer gateway', 'x-tdai-service-id': 'service-a', 'x-tdai-user-key': 'user' }),
    }));
  });

  it('provisions a CodeGraph and Wiki for a workspace from actual knowledge requests', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/electron-agent-assets-`);
    temporaryDirectories.push(workspace);
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({ code: 0, data: url.includes('code-graph/create') ? { code_graph_id: 'graph-1' } : { wiki_id: 'wiki-1' } }), { status: 200 })));
    const service = new TencentDbService({ fetch, secrets: secrets({ remoteGatewayApiKey: 'gateway', userApiKey: 'user' }) });
    await service.saveConnection({ config: { mode: 'remote', endpoint: 'https://gateway.example', knowledgeEndpoint: 'https://knowledge.example', serviceId: 'service-a', teamId: 'team-a', agentId: 'agent-a', userId: 'user-a' } });

    await expect(service.provisionWorkspaceAssets(workspace)).resolves.toMatchObject({ codeGraphId: 'graph-1', wikiId: 'wiki-1' });
  });

  it('imports validated Wiki files in one batch and triggers Wiki ingest', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/electron-agent-wiki-`);
    temporaryDirectories.push(workspace);
    const markdown = `${workspace}/guide.md`;
    await writeFile(markdown, '# Guide');
    const fetch = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({ code: 0, data: url.includes('/wiki/raw/write') ? { accepted: 1 } : { state: 'processing' } }), { status: 200 })));
    const service = new TencentDbService({ fetch, secrets: secrets({ remoteGatewayApiKey: 'gateway', userApiKey: 'user' }) });
    await service.saveConnection({ config: { mode: 'remote', endpoint: 'https://gateway.example', knowledgeEndpoint: 'https://knowledge.example', serviceId: 'service-a', teamId: 'team-a', agentId: 'agent-a', userId: 'user-a' } });

    await expect(service.importWikiFiles('wiki-1', [markdown])).resolves.toEqual({ uploaded: 1, sync: { state: 'processing' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('changes the persisted Pi reload revision when skills are reloaded', async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/electron-agent-reload-`);
    temporaryDirectories.push(dataDir);
    const service = new TencentDbService({ dataDir, secrets: secrets({ localGatewayApiKey: 'gateway' }) });
    const first = await service.reloadSkills();
    const second = await service.reloadSkills();
    expect(first).not.toBe(second);
  });

  it('tests gateway credentials and knowledge health before marking the connection successful', async () => {
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return Promise.resolve(new Response('{}', { status: 200 }));
      const body = url.includes('/auth/verify') ? { valid: true } : {};
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: body }), { status: 200 }));
    });
    const service = new TencentDbService({ fetch, secrets: secrets({ remoteGatewayApiKey: 'gateway', userApiKey: 'user' }) });
    await service.saveConnection({ config: { mode: 'remote', endpoint: 'https://gateway.example', knowledgeEndpoint: 'https://knowledge.example', serviceId: 'service-a', teamId: 'team-a', agentId: 'agent-a', userId: 'user-a' } });
    await expect(service.testConnection()).resolves.toMatchObject({ state: 'ready', lastSuccessAt: expect.any(String) });
    expect(fetch).toHaveBeenCalledWith('https://gateway.example/v3/meta/auth/verify', expect.anything());
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example/health');
  });
});
