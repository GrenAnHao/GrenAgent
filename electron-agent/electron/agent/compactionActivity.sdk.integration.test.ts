import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager } from '../../../cli/src/pi-sdk.js';
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import compactionPolicy from '../../../extensions/compaction-policy/index.js';
import { beginCompactionIntent, getCompactionActivity, forgetCompactionActivity, observeCompactionEvent, subscribeCompactionActivity } from '../../../extensions/_shared/compaction-activity.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('real SDK policy handoff registers trusted intent before native compaction start across async frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gren-compaction-handoff-'));
  roots.push(root);
  vi.stubGlobal('fetch', () => { throw new Error('External fetch forbidden'); });
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'https://never-called.invalid', apiKey: 'fixture-only',
    models: [{ id: 'local', contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.inMemory(root);
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: 'user', content: `older context ${i} ` + 'fixture '.repeat(100), timestamp: i * 2 } as never);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'older answer '.repeat(100) }],
      api: 'openai-completions', provider: 'fixture', model: 'local', stopReason: 'stop', timestamp: i * 2 + 1,
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  }
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 }, retry: { enabled: false } }),
    resourceLoaderOptions: { extensionFactories: [compactionPolicy], noContextFiles: true, noSkills: true, noPromptTemplates: true } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: runtime.getModel('fixture', 'local')!, tools: [] });
  await session.bindExtensions({ mode: 'rpc' });
  const identity = { sessionId: manager.getSessionId(), sessionPath: manager.getSessionFile() ?? undefined };
  const events: Array<{ type: string; phase?: string; origin?: string }> = [];
  const lifecycle: string[] = [];
  const unsubscribe = subscribeCompactionActivity(identity.sessionId, activity => lifecycle.push(activity?.phase ?? 'finished'));
  session.subscribe(raw => {
    const activity = getCompactionActivity(identity.sessionId);
    events.push({ type: raw.type, phase: activity?.phase, origin: activity?.origin });
    if (raw.type === 'compaction_start' || raw.type === 'compaction_end') {
      observeCompactionEvent(identity, raw as { type: 'compaction_start' | 'compaction_end'; aborted?: boolean; errorMessage?: string });
    }
  });
  let calls = 0;
  session.agent.streamFunction = ((model: { api: string; provider: string; id: string }) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: calls * 1000,
      content: [{ type: 'text', text: calls === 1 ? 'fixture answer' : 'fixture compact summary' }], stopReason: 'stop',
      usage: { input: calls === 1 ? 90000 : 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: calls === 1 ? 90001 : 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message } as never);
      stream.push({ type: 'done', reason: 'stop', message } as never); stream.end(message as never); });
    return stream;
  }) as never;
  try {
    await session.prompt('local fixture');
    await session.waitForIdle();
    await vi.waitFor(() => expect(events.some(event => event.type === 'compaction_start')).toBe(true), { timeout: 2000 });
    const start = events.find(event => event.type === 'compaction_start');
    expect(start).toMatchObject({ origin: 'policy-auto', phase: 'preparing' });
    expect(lifecycle.slice(0, 2)).toEqual(['preparing', 'running']);
    expect(events.filter(event => event.type === 'compaction_end')).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally { unsubscribe(); session.dispose(); forgetCompactionActivity(identity.sessionId); }
}, 15_000);

it('real SDK aborts active assistant before its later compaction_start, preserving the trusted preparing origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gren-compaction-abort-'));
  roots.push(root);
  vi.stubGlobal('fetch', () => { throw new Error('External fetch forbidden'); });
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'https://never-called.invalid', apiKey: 'fixture-only',
    models: [{ id: 'local', contextWindow: 100000, maxTokens: 1024 }],
  } } }));
  const runtime = await ModelRuntime.create({ modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  const manager = SessionManager.inMemory(root);
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: 'user', content: 'older context '.repeat(100), timestamp: i * 2 } as never);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'older answer '.repeat(100) }],
      api: 'openai-completions', provider: 'fixture', model: 'local', stopReason: 'stop', timestamp: i * 2 + 1,
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  }
  let handoffScheduled = false;
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false },
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } }),
    resourceLoaderOptions: { noContextFiles: true, noSkills: true, noPromptTemplates: true,
      extensionFactories: [pi => { pi.on('message_update', (_event, ctx) => {
        if (handoffScheduled) return;
        handoffScheduled = true;
        beginCompactionIntent({ sessionId: ctx.sessionManager.getSessionId() }, 'policy-auto');
        // A separate frame is essential: SDK manual compact first aborts the active request,
        // then starts compaction, and the host must recognize the gap by the registered intent.
        setTimeout(() => ctx.compact({ onError: () => {} }), 0);
      }); }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: runtime.getModel('fixture', 'local')!, tools: [] });
  await session.bindExtensions({ mode: 'rpc' });
  const identity = { sessionId: session.sessionId, sessionPath: session.sessionFile ?? undefined };
  const timeline: Array<{ type: string; phase?: string; origin?: string; stopReason?: string }> = [];
  session.subscribe(raw => {
    const intent = getCompactionActivity(identity.sessionId);
    timeline.push({ type: raw.type, phase: intent?.phase, origin: intent?.origin,
      stopReason: raw.type === 'message_end' ? (raw.message as { stopReason?: string }).stopReason : undefined });
    if (raw.type === 'compaction_start' || raw.type === 'compaction_end') {
      observeCompactionEvent(identity, raw as { type: 'compaction_start' | 'compaction_end'; aborted?: boolean; errorMessage?: string });
    }
  });
  let calls = 0;
  session.agent.streamFunction = ((model: { api: string; provider: string; id: string }, _context: unknown, options: { signal?: AbortSignal }) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: calls * 1000, content: [{ type: 'text', text: 'fixture response' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message } as never);
      if (calls > 1) {
        stream.push({ type: 'done', reason: 'stop', message } as never);
        stream.end(message as never);
      } else {
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'fixture response', partial: message } as never);
      }
    });
    if (calls === 1) options.signal?.addEventListener('abort', () => {
      const aborted = { ...message, stopReason: 'aborted', errorMessage: 'Request was aborted' };
      stream.push({ type: 'error', reason: 'aborted', error: aborted } as never);
      stream.end(aborted as never);
    }, { once: true });
    return stream;
  }) as never;
  try {
    await session.prompt('active fixture');
    await vi.waitFor(() => expect(timeline.some(event => event.type === 'compaction_start')).toBe(true), { timeout: 3000 });
    const aborted = timeline.find(event => event.type === 'message_end' && event.stopReason === 'aborted');
    const started = timeline.find(event => event.type === 'compaction_start');
    expect(aborted).toMatchObject({ phase: 'preparing', origin: 'policy-auto' });
    expect(started).toMatchObject({ phase: 'preparing', origin: 'policy-auto' });
    expect(timeline.indexOf(aborted!)).toBeLessThan(timeline.indexOf(started!));
  } finally { session.dispose(); forgetCompactionActivity(identity.sessionId); }
}, 15_000);
