import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => ({ ...electron, BrowserWindow: {}, dialog: {}, shell: {} }));

import { ProviderService } from './providerService';
import { registerIpcHandlers } from '../ipc/register';
import { IPC_CHANNELS } from '../ipc/contracts';
import { pi } from '../../src/lib/pi';

// Resolve the same CLI SDK copy as production; never construct Models/ModelRuntime or load auth.
const sdk = await import(new URL('../../../cli/node_modules/@earendil-works/pi-ai/dist/providers/all.js', import.meta.url).href);
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  electron.ipcMain.handle.mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function list(service: ProviderService, provider: string): Promise<Record<string, any>[]> {
  expect(service, 'read-only built-in catalog method is available').toHaveProperty('listBuiltinModels');
  return service.listBuiltinModels(provider);
}

describe('read-only built-in chat catalog', () => {
  it('isolates exact provider IDs and excludes image/classifier catalogs', async () => {
    const service = new ProviderService({ agentDir: 'unused' });
    const openai = await list(service, 'openai');
    const anthropic = await list(service, 'anthropic');
    expect(openai.some((model) => model.id === 'chat-latest')).toBe(true);
    expect(anthropic.some((model) => model.id === 'claude-fable-5')).toBe(true);
    expect(openai.some((model) => model.id === 'claude-fable-5')).toBe(false);
    expect(anthropic.some((model) => model.id === 'chat-latest')).toBe(false);
    for (const provider of ['openai', 'openrouter', 'typesafe']) {
      const actual = await list(service, provider);
      expect(actual.map((model) => [model.id, model.api])).toEqual(sdk.getBuiltinModels(provider).map((model: any) => [model.id, model.api]));
      const nonChat = [...sdk.getBuiltinImageModels(provider), ...sdk.getBuiltinClassifierModels(provider)];
      expect(nonChat.length).toBeGreaterThan(0);
      // IDs can be shared by chat and image/classifier entries; the API distinguishes them.
      expect(actual.every((model) => !nonChat.some((other: any) => other.id === model.id && other.api === model.api))).toBe(true);
    }
    for (const provider of ['not-a-provider', '', 'OpenAI', '__proto__', 'constructor']) {
      await expect(list(service, provider)).resolves.toEqual([]);
    }
  });

  it('preserves all editor metadata but strips connection/auth fields and functions', async () => {
    const source = sdk.getBuiltinModels('openai')[0];
    const original = { ...source };
    const metadata = {
      id: source.id, api: 'openai-responses', name: 'Catalog metadata fixture', reasoning: false,
      input: ['text', 'image'], contextWindow: 200000, maxTokens: 12000,
      cost: { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2,
        tiers: [{ inputTokensAbove: 100000, input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0.4 }] },
      thinkingLevelMap: { off: null, low: 'low', max: null },
      compat: { supportsStrictMode: false, supportsLongCacheRetention: true },
      samplingParams: { temperature: 0, top_p: 0.9, nested: { enabled: false } },
      samplingParamsByThinkingLevel: { off: { temperature: 0.5 }, high: { temperature: 0 } },
      inputLimits: { maxRequestBytes: 2048, images: { maxPerMessage: 0, maxPerRequest: 8,
        resize: { maxWidth: 1000, maxHeight: 800, maxBytes: 4096, jpegQuality: 80 } } },
      promptCache: { short: 300, long: 3600 },
    };
    Object.assign(source, metadata, {
      baseUrl: 'https://secret.invalid', headers: { authorization: 'secret-header' },
      apiKey: 'secret-key', credentials: { access: 'secret-access', refresh: 'secret-refresh' },
      callback: () => 'not serializable',
      samplingParams: { ...metadata.samplingParams, callback: () => 'not serializable' },
    });
    try {
      const service = new ProviderService({ agentDir: 'unused' });
      const actual = (await list(service, 'openai')).find((model) => model.id === source.id)!;
      // provider is harmless identity metadata, not connection configuration.
      const { provider, ...editorMetadata } = actual;
      if (provider !== undefined) expect(provider).toBe('openai');
      expect(editorMetadata).toEqual(metadata);
      expect(structuredClone(actual)).toEqual(actual);
      expect(JSON.stringify(actual)).not.toMatch(/secret-|baseUrl|headers|credentials|apiKey|callback/);
      actual.cost.input = 99;
      actual.input.push('mutated');
      actual.inputLimits.images.resize.maxWidth = 1;
      expect((await list(service, 'openai')).find((model) => model.id === source.id)?.cost.input).toBe(0);
      expect(source.input).toEqual(['text', 'image']);
      expect(source.inputLimits.images.resize.maxWidth).toBe(1000);
    } finally {
      for (const key of Object.keys(source)) delete source[key];
      Object.assign(source, original);
    }
  });

  it('reads SDK defaults offline without runtime, credentials, disk changes or user overrides', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'builtin-models-'));
    directories.push(agentDir);
    const auth = '{"openai":{"type":"oauth","access":"temporary-secret","refresh":"temporary-refresh"}}';
    const models = '{"providers":{"openai":{"apiKey":"temporary-key","modelOverrides":{"chat-latest":{"name":"User override"}}}}}';
    await writeFile(join(agentDir, 'auth.json'), auth);
    await writeFile(join(agentDir, 'models.json'), models);
    const forbidden = async (): Promise<never> => { throw new Error('runtime/network must not be used'); };
    vi.stubGlobal('fetch', forbidden);
    const service = new ProviderService({ agentDir, fetch: forbidden, runtime: forbidden, probeModels: forbidden, refresh: forbidden });
    const actual = await list(service, 'openai');
    expect(actual.find((model) => model.id === 'chat-latest')?.name).toBe('Chat Latest');
    expect(JSON.stringify(actual)).not.toMatch(/temporary-|User override/);
    expect(await readFile(join(agentDir, 'auth.json'), 'utf8')).toBe(auth);
    expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toBe(models);
    expect((await readdir(agentDir)).sort()).toEqual(['auth.json', 'models.json']);
  });

  it('serves the renderer API through validated list_builtin_models IPC with the exact provider', async () => {
    const service = new ProviderService({ agentDir: 'unused' });
    registerIpcHandlers({ provider: service });
    const handler = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === IPC_CHANNELS.invoke)?.[1];
    expect(handler).toBeTypeOf('function');
    vi.stubGlobal('window', { gren: { invoke: (command: string, args: unknown) => handler({}, { command, args }) } });
    expect(pi).toHaveProperty('listBuiltinModels');
    const result = await pi.listBuiltinModels('anthropic');
    expect(result.some((model) => model.id === 'claude-fable-5')).toBe(true);
    expect(result.some((model) => model.id === 'chat-latest')).toBe(false);
    await expect(pi.listBuiltinModels('not-a-provider')).resolves.toEqual([]);
    for (const args of [{}, { provider: 42 }, { provider: null }]) {
      await expect(handler({}, { command: 'list_builtin_models', args })).rejects.toThrow('provider');
    }
  });
});
