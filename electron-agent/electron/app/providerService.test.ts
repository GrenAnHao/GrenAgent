import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('discovers OpenAI-compatible model ids from the provider endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
    const service = new ProviderService({ agentDir: 'C:/agent', fetch });

    await expect(service.fetchModels('https://provider.example', 'secret', 'openai-completions')).resolves.toEqual(['model-a']);
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer secret' },
    }));
  });

  it('uses the active workspace model for Mermaid repair and streams diagnostics', async () => {
    const requests: Record<string, unknown>[] = [];
    const service = new ProviderService({
      agentDir: 'C:/agent',
      activeModel: async () => ({ provider: 'openai', modelId: 'gpt-5' }),
      oneshot: async (request, onLine) => {
        requests.push(request);
        if ('system' in request) { onLine?.('{"ok":true,"content":"hello"}'); return; }
        onLine?.('{"type":"delta","text":"hello"}');
        onLine?.('{"type":"done","usage":{"total_tokens":3}}');
      },
    });
    const chunks: string[] = [];

    await expect(service.fixMermaid('C:/project', 'graph TD', 'parse error')).resolves.toBe('hello');
    await expect(service.diagnose('openai', 'gpt-5', '', true, (chunk) => chunks.push(chunk))).resolves.toMatchObject({ ok: true, content: 'hello', totalTokens: 3 });
    expect(requests[0]).toMatchObject({ provider: 'openai', modelId: 'gpt-5' });
    expect(chunks).toEqual(['hello']);
  });
});
