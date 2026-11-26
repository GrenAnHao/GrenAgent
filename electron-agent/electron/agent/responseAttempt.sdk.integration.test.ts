import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ModelRuntime, SessionManager } from '../../../cli/src/pi-sdk.js';
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createResponseAttemptBinder } from './responseAttempt.js';
import { toRendererEvent } from './streamingEvent.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('real AgentSession retry events bind the first valid SDK delta to its new attempt before snapshots are stripped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gren-attempt-sdk-'));
  roots.push(root);
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'https://never-called.invalid', apiKey: 'fixture-only',
    models: [{ id: 'local', contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.inMemory(root);
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } }),
    resourceLoaderOptions: { extensionFactories: [], noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: runtime.getModel('fixture', 'local')!, noTools: 'all' });
  const binder = createResponseAttemptBinder();
  const observed: Array<{ type: string; attempt?: { runId: number; attempt: number }; payload?: unknown }> = [];
  session.subscribe(raw => {
    const attempt = binder(raw as Record<string, unknown>);
    const event = toRendererEvent(raw as never);
    if (!event) return;
    const tagged = { ...event, ...(attempt ? { responseAttempt: attempt } : {}) };
    observed.push({ type: String(event.type), attempt, payload: tagged });
  });
  let calls = 0;
  session.agent.streamFunction = ((model: { api: string; provider: string; id: string }) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: calls * 1000, content: calls === 1 ? [] : [{ type: 'text', text: 'valid response' }],
      stopReason: calls === 1 ? 'error' : 'stop', ...(calls === 1 ? { errorMessage: '429 Too Many Requests: fixture rate limit' } : {}),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message } as never);
      if (calls === 2) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'valid response', partial: message } as never);
      stream.push(calls === 1 ? { type: 'error', reason: 'error', error: message } as never
        : { type: 'done', reason: 'stop', message } as never);
      stream.end(message as never);
    });
    return stream;
  }) as never;
  try {
    await session.prompt('local fixture');
    await session.waitForIdle();
    expect(calls).toBe(2);
    expect(observed.some(item => item.type === 'auto_retry_start' && item.attempt?.attempt === 1)).toBe(true);
    const delta = observed.find(item => item.type === 'message_update'
      && (item.payload as { assistantMessageEvent?: { type: string } }).assistantMessageEvent?.type === 'text_delta');
    expect(delta?.attempt).toMatchObject({ runId: 1, attempt: 1 });
    expect((delta?.payload as { message?: unknown }).message).toBeUndefined();
    expect(observed.some(item => item.type === 'auto_retry_end')).toBe(true);
  } finally { session.dispose(); }
}, 15_000);
