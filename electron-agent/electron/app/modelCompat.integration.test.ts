import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSessionResources, type Message } from '@earendil-works/pi-ai';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';

const roots: string[] = [];
const sessions: string[] = [];
afterEach(async () => {
  for (const id of sessions.splice(0)) cleanupSessionResources(id);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real UI serialization -> models.json -> SDK model -> provider serializer.
// Fetch always stops at the transport boundary; no external service or real auth is used.
async function payload(api: string, compat: Record<string, unknown>, messages?: Message[]) {
  // Load the renderer's pure adapter at the test boundary, outside the main composite project's source list.
  const { loadState, serializeState } = await import(new URL('../../src/features/settings/providerConfigAdapter.ts', import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), 'gren-model-compat-'));
  roots.push(root);
  const provider = {
    id: 'compat-fixture', name: 'Fixture', builtIn: false, api,
    baseUrl: 'https://fixture.invalid/v1',
    models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024, compat }],
  };
  const saved = serializeState([provider]);
  const restored = loadState(saved.modelsJson, '{}', []).find((p: { id: string }) => p.id === provider.id)!;
  await writeFile(join(root, 'models.json'), serializeState([restored]).modelsJson);
  const runtime = await ModelRuntime.create({
    modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
    modelsStorePath: join(root, 'model-cache.json'), allowModelNetwork: false,
  });
  expect(runtime.getError()).toBeUndefined();
  const model = runtime.getModel(provider.id, 'fixture')!;
  expect(model).toBeDefined();
  const sessionId = `compat-${roots.length}-${api}`;
  sessions.push(sessionId);
  const requests: Array<Record<string, any>> = [];
  await runtime.streamSimple(model, { messages: messages ?? [{ role: 'user', content: 'fixture', timestamp: 1 }] }, {
    apiKey: 'fixture-key', sessionId, cacheRetention: 'short', maxRetries: 0,
    fetch: (async (_url, init) => {
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      const json = new Headers(init?.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8');
      requests.push(JSON.parse(json));
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture-stop' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  }).result();
  expect(requests.length).toBeGreaterThan(0);
  return { body: requests[0], sessionId };
}

const toolHistory: Message[] = [
  { role: 'user', content: 'use fixture tool', timestamp: 1 },
  {
    role: 'assistant', api: 'openai-completions', provider: 'compat-fixture', model: 'fixture',
    content: [{ type: 'toolCall', id: 'fixture-call', name: 'fixture_tool', arguments: {} }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse', timestamp: 2,
  },
  { role: 'toolResult', toolCallId: 'fixture-call', toolName: 'fixture_tool', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
];

describe('Pi 1.5 model compatibility reaches the real SDK request', () => {
  for (const enabled of [true, false]) {
    it(`applies OpenAI tool-history overrides when ${enabled}`, async () => {
      const { body, sessionId } = await payload('openai-completions', {
        requiresNonNullAssistantContent: enabled, requiresToolsWithToolHistory: enabled,
        promptCacheKeyMode: enabled ? 'enabled' : 'disabled',
      }, toolHistory);
      expect(body.messages.find((message: { role: string }) => message.role === 'assistant').content).toBe(enabled ? '' : null);
      if (enabled) {
        expect(body.tools).toEqual([]);
        expect(body.prompt_cache_key).toBe(sessionId);
      } else {
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('prompt_cache_key');
      }
    });

    it(`applies Anthropic message threads when ${enabled}`, async () => {
      const { body } = await payload('anthropic-messages', { supportsMessageThreads: enabled });
      if (enabled) expect(body.thread).toEqual({ type: 'create' });
      else expect(body).not.toHaveProperty('thread');
    });

    it(`applies Responses prompt cache keys when ${enabled}`, async () => {
      const { body, sessionId } = await payload('openai-responses', { promptCacheKeyMode: enabled ? 'enabled' : 'disabled' });
      if (enabled) expect(body.prompt_cache_key).toBe(sessionId);
      else expect(body).not.toHaveProperty('prompt_cache_key');
    });
  }
});
