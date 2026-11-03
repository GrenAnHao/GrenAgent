import { describe, expect, it } from 'vitest';
import { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import { createAgentDataModelPort } from './createAgentDataModelPort';

describe('existing AgentData model configuration port', () => {
  it('returns complete assistant messages through a bound model and rejects changed configuration', async () => {
    let version = 'one';
    const message = { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'Read', arguments: { path: 'a' } }], stopReason: 'toolUse', usage: { totalTokens: 5 } };
    const runtime = { getModel: (provider: string, id: string) => ({ provider, id, name: id, api: 'openai-completions', baseUrl: version, reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: {} }), getCompatibilityRequestConfig: () => ({}), streamSimple: (_model: unknown, _context: unknown, options: any) => ({ result: async () => { expect(options.maxRetries).toBe(0); await options.transformHeaders({}); return message; } }) };
    const port = createAgentDataModelPort(new ModelRuntimeHost({ create: async () => runtime as never }), () => 'knowledge/configured');
    const binding = await port.bindKnowledgeModel();
    const admission = await port.bindKnowledgeModel('admission:preview');
    await expect(port.requestKnowledgeMessage(admission, { messages: [] } as never, { maxTokens: 100 })).rejects.toThrow('MODEL_CHANGED');
    expect(binding.model).not.toHaveProperty('baseUrl');
    expect(await port.requestKnowledgeMessage(binding, { messages: [] } as never, { maxTokens: 100 })).toEqual(message);
    version = 'two';
    await expect(port.requestKnowledgeMessage(binding, { messages: [] } as never, { maxTokens: 100 })).rejects.toThrow('MODEL_CHANGED');
  });
  it('includes SDK provider request settings and rechecks them immediately before provider dispatch', async () => {
    let header = 'before';
    let dispatched = 0;
    const runtime = {
      getModel: (provider: string, id: string) => ({ provider, id }),
      getCompatibilityRequestConfig: () => ({ headers: { 'x-version': header } }),
      completeSimple: async (_model: unknown, _context: unknown, options: { transformHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>> }) => {
        header = 'after';
        await options.transformHeaders?.({ 'x-version': header });
        dispatched++;
        return { role: 'assistant', content: [{ type: 'text', text: 'result' }], stopReason: 'stop' };
      },
    };
    const host = new ModelRuntimeHost({ create: async () => runtime as never });
    const port = createAgentDataModelPort(host, () => 'knowledge/configured');
    const expectedConfiguration = await port.configurationIdentity();
    await expect(port.complete({ user: 'queued', expectedModel: 'knowledge/configured', expectedConfiguration }))
      .rejects.toThrow('MODEL_CHANGED');
    expect(dispatched).toBe(0);
    expect(await port.configurationIdentity()).not.toBe(expectedConfiguration);
  });

  it('rejects a queued request when the same model id has a different actual endpoint or headers', async () => {
    let endpoint = 'http://old.invalid';
    const calls: unknown[] = [];
    const runtime = {
      getModel: (provider: string, id: string) => ({ provider, id, baseUrl: endpoint, headers: { version: endpoint } }),
      hasConfiguredAuth: () => true, getAvailableSnapshot: () => [],
      completeSimple: async (...args: unknown[]) => { calls.push(args); return { role: 'assistant', content: [{ type: 'text', text: 'result' }], stopReason: 'stop' }; },
    };
    const host = new ModelRuntimeHost({ create: async () => runtime as never });
    const port = createAgentDataModelPort(host, () => 'knowledge/configured');
    const expectedConfiguration = await port.configurationIdentity();
    expect(expectedConfiguration).toMatch(/^[a-f0-9]{64}$/);
    expect(expectedConfiguration).not.toContain(endpoint);
    endpoint = 'http://new.invalid';
    await expect(port.complete({ user: 'stale configuration', expectedModel: 'knowledge/configured', expectedConfiguration }))
      .rejects.toThrow('MODEL_CHANGED');
    expect(calls).toHaveLength(0);
    const fresh = await port.configurationIdentity();
    expect(fresh).not.toBe(expectedConfiguration);
    await expect(port.complete({ user: 'fresh', expectedModel: 'knowledge/configured', expectedConfiguration: fresh })).resolves.toBe('result');
    expect((calls[0] as unknown[])[0]).toMatchObject({ baseUrl: endpoint, headers: { version: endpoint } });
  });

  it('uses agentDataModel over the application default and forwards the real SDK request options', async () => {
    const calls: unknown[] = [];
    const runtime = {
      getModel: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
      getAvailableSnapshot: () => [],
      completeSimple: async (...args: unknown[]) => {
        calls.push(args);
        return { role: 'assistant', content: [{ type: 'text', text: '{"markdown":"configured"}' }], stopReason: 'stop' };
      },
    };
    const host = new ModelRuntimeHost({
      create: async () => runtime as never,
      resolveSettings: async () => ({ provider: 'application', modelId: 'default' }),
    });
    let setting: string | undefined = 'knowledge/configured';
    const port = createAgentDataModelPort(host, () => setting);
    expect(await port.describe()).toBe('knowledge/configured');
    const abort = new AbortController();
    expect(await port.complete({ user: 'source', systemPrompt: 'strict JSON', maxTokens: 8192, signal: abort.signal }))
      .toBe('{"markdown":"configured"}');
    expect(calls[0]).toEqual([
      { provider: 'knowledge', id: 'configured' },
      { systemPrompt: 'strict JSON', messages: [{ role: 'user', content: 'source', timestamp: expect.any(Number) }] },
      { signal: abort.signal, maxTokens: 8192 },
    ]);
    setting = undefined;
    expect(await port.describe()).toBe('application/default');
    await port.complete({ user: 'next' });
    expect((calls[1] as unknown[])[0]).toEqual({ provider: 'application', id: 'default' });
    setting = 'knowledge/changed';
    await expect(port.complete({ user: 'stale', expectedModel: 'knowledge/configured' }))
      .rejects.toThrow('MODEL_CHANGED');
    expect(calls).toHaveLength(2);
  });
});
