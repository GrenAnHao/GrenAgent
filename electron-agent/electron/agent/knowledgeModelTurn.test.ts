import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { createServer } from 'node:http';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeStreamFn, KnowledgeMessageBroker } from './knowledgeModelTurn';

const model: any = { id: 'test', name: 'Test', provider: 'test', api: 'openai-completions', baseUrl: 'http://invalid', reasoning: true, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe('knowledge model turn', () => {
  it('drives the official Agent through two tool calls without losing messages', async () => {
    const transcripts: any[] = [];
    const streamFn = createKnowledgeStreamFn(async (_model, context) => {
      transcripts.push(structuredClone(context));
      const n = transcripts.length;
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: n < 3 ? 'toolUse' : 'stop', content: n < 3 ? [{ type: 'thinking', thinking: 'reason', thinkingSignature: `sig-${n}` }, { type: 'toolCall', id: `call-${n}`, name: 'Read', arguments: { path: `file-${n}` } }] : [{ type: 'text', text: 'done' }] } as any;
    });
    const agent = new Agent({ initialState: { model, systemPrompt: 'test', tools: [{ name: 'Read', label: 'Read', description: 'read', parameters: Type.Object({ path: Type.String() }), execute: async (_id, args) => ({ content: [{ type: 'text', text: (args as { path: string }).path }], details: {} }) }] }, streamFn, toolExecution: 'sequential' });
    await agent.prompt('start');
    expect(transcripts).toHaveLength(3);
    expect(transcripts[2].messages.filter((m: any) => m.role === 'toolResult').map((m: any) => m.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(transcripts[2].messages.find((m: any) => m.role === 'assistant').content[0].thinkingSignature).toBe('sig-1');
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'stop', usage });
  });

  it('converts request failures to SDK error events', async () => {
    const stream = createKnowledgeStreamFn(async () => { throw new Error('auth failed'); })(model, { messages: [] } as never);
    const events = []; for await (const event of await stream) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'error', error: { errorMessage: 'auth failed' } });
  });

  it('drains an old provider without waiting for its usage acknowledgement', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const binding: any = { bindingId: 'binding', expectedModel: 'test/test', expectedConfiguration: 'config', model };
    const broker = new KnowledgeMessageBroker({ bind: async () => binding, request: async () => { await pending; return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() } as any; } });
    await broker.bindEpoch('old'); broker.activateEpoch('old');
    await broker.bind('task');
    const request = broker.request({ controllerEpoch: 'old', requestId: 'r1', taskId: 'task', fence: { controllerEpoch: 'old' }, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 100 } } as any);
    const drain = broker.bindEpoch('new');
    release(); await request;
    expect(await drain).toMatchObject([{ requestId: 'r1', usage }]);
    broker.activateEpoch('new');
    expect(broker.ackUsage('r1')).toBe(true);
  });

  it('blocks a new epoch when an old executor does not drain', async () => {
    const broker = new KnowledgeMessageBroker({ bind: async () => ({} as any), request: async () => ({} as any), drainWorkers: async () => new Promise<void>(() => {}), drainTimeoutMs: 10 });
    await broker.bindEpoch('old'); broker.activateEpoch('old');
    await expect(broker.bindEpoch('new')).rejects.toThrow('OLD_EXECUTOR_NOT_DRAINED');
    expect(() => broker.activateEpoch('new')).toThrow('STALE_EPOCH');
    await expect(broker.bind('task')).rejects.toThrow('EPOCH_NOT_ACTIVE');
  });

  it('forwards request abort while waiting for the provider to settle', async () => {
    let release!: () => void, gotAbort = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const binding: any = { bindingId: 'b', expectedModel: 'test/test', expectedConfiguration: 'c', model };
    const broker = new KnowledgeMessageBroker({ bind: async () => binding, request: async (_binding, _context, options) => { options.signal.addEventListener('abort', () => { gotAbort = true; }); await hold; return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() } as any; } });
    await broker.bindEpoch('epoch'); broker.activateEpoch('epoch'); await broker.bind('task');
    const request = broker.request({ controllerEpoch: 'epoch', requestId: 'r', taskId: 'task', fence: { controllerEpoch: 'epoch' }, bindingId: 'b', transcript: { messages: [] }, options: { maxTokens: 100 } } as any);
    expect(broker.abortRequest('r')).toBe(true); expect(gotAbort).toBe(true);
    release(); await request; expect(broker.abortRequest('r')).toBe(false);
  });

  it('does not register an admission binding for execution', async () => {
    const binding: any = { bindingId: 'preview', expectedModel: 'test/test', expectedConfiguration: 'c', model };
    const bind = vi.fn(async () => binding);
    const broker = new KnowledgeMessageBroker({ bind, request: async () => ({} as any) });
    await broker.bindEpoch('epoch'); broker.activateEpoch('epoch');
    await broker.bind('admission:preview');
    expect(bind).toHaveBeenCalledWith('admission:preview');
    await expect(broker.request({ controllerEpoch: 'epoch', requestId: 'r', taskId: 'admission:preview', fence: { controllerEpoch: 'epoch' }, bindingId: 'preview', transcript: { messages: [] }, options: { maxTokens: 100 } } as any)).rejects.toThrow();
  });

  it('round-trips two tool calls through the broker and a loopback provider', async () => {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        const n = bodies.length;
        const delta = n <= 2 ? { tool_calls: [{ index: 0, id: `loop-${n}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: `file-${n}` }) } }] } : { content: 'done' };
        const chunk = { id: `response-${n}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: n <= 2 ? 'tool_calls' : 'stop' }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as any).port;
      const providerModel = { ...model, baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false };
      const binding: any = { bindingId: 'loop-binding', expectedModel: 'test/test', expectedConfiguration: 'c', model: providerModel };
      const broker = new KnowledgeMessageBroker({ bind: async () => binding, request: async (_binding, context, options) => streamSimple(providerModel, context, { ...options, apiKey: 'test', maxRetries: 0 }).result() });
      await broker.bindEpoch('epoch'); broker.activateEpoch('epoch'); await broker.bind('task');
      const streamFn = createKnowledgeStreamFn(async (_model, transcript, options) => broker.request({ controllerEpoch: 'epoch', requestId: `r-${bodies.length}`, taskId: 'task', fence: { controllerEpoch: 'epoch' }, bindingId: binding.bindingId, transcript, options: { maxTokens: 100 } } as any, options?.signal));
      const agent = new Agent({ initialState: { model: providerModel, systemPrompt: 'test', tools: [{ name: 'Read', label: 'Read', description: 'read', parameters: Type.Object({ path: Type.String() }), execute: async (_id, args) => ({ content: [{ type: 'text', text: (args as { path: string }).path }], details: {} }) }] }, streamFn, toolExecution: 'sequential' });
      await agent.prompt('start');
      expect(bodies, JSON.stringify(agent.state.messages)).toHaveLength(3);
      expect(bodies[2].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['loop-1', 'loop-2']);
      expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'stop' });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
