import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderService } from './providerService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProviderService', () => {
  it('persists validated model and auth JSON then returns the provider payload', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{"providers":{}}', '{"openai":{"type":"api_key"}}')).resolves.toEqual({ refreshed: [], failed: [] });
    await expect(service.getConfig()).resolves.toEqual({
      modelsJson: '{"providers":{}}',
      authJson: '{"openai":{"type":"api_key"}}',
      agentDir,
    });
    await expect(readFile(join(agentDir, 'models.json'), 'utf8')).resolves.toBe('{"providers":{}}');
  });

  it('rejects malformed provider JSON before writing either file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-provider-'));
    directories.push(agentDir);
    const service = new ProviderService({ agentDir });

    await expect(service.setConfig('{', '{}')).rejects.toThrow('models.json is not valid JSON');
    await expect(service.getConfig()).resolves.toEqual({ modelsJson: null, authJson: null, agentDir });
  });

  it('returns models parsed from the Pi probe output', async () => {
    const service = new ProviderService({
      agentDir: 'C:/agent',
      probeModels: async () => '{"ok":true,"models":[{"provider":"openai","id":"gpt-5"}]}',
    });

    await expect(service.listModels()).resolves.toEqual([{ provider: 'openai', id: 'gpt-5' }]);
  });
});
