import { describe, expect, it } from 'vitest';
import { createNativeWikiModelBridge } from './nativeWikiModel';
describe('native model bridge', () => {
  it('replays provider assistant tool calls and uses the shared model slot', async () => {
    let slots = 0;
    const sdk: any = { bindKnowledgeModel: async () => ({ bindingId: 'b', expectedModel: 'p/m', expectedConfiguration: 'c', model: { provider: 'p', id: 'm', api: 'openai-completions', contextWindow: 100000, maxTokens: 8000 } }), requestKnowledgeMessage: async (_b: unknown, context: any) => { expect(context.messages[0].role).toBe('system'); return { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'openai-completions', provider: 'p', model: 'm', stopReason: 'stop', usage: { input: 2, output: 1, totalTokens: 3 }, timestamp: 1 }; } };
    const bridge = createNativeWikiModelBridge({ model: sdk, gate: { admit: async () => 'lease', release: async () => {}, project: async () => {}, publication: async () => {}, dispatched: async () => {}, stage: async () => {}, recover: async () => {}, withSlot: async (_id, work) => { slots++; return work(); } } });
    const model = await bridge.bind('key'); const operation: any = { id: 'op', repositoryRoot: '/repo', branch: 'main', locale: 'zh', targetCommit: 'abc', model };
    await bridge.handle('native.admission', { operation }, new AbortController().signal);
    const response: any = await bridge.handle('native.model', { operation, requestId: 'r', purpose: 'wiki.full.page', systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], maxOutputTokens: 100 }, new AbortController().signal);
    expect(response.text).toBe('ok'); expect(response.usage.totalTokens).toBe(3); expect(slots).toBe(1);
  });
  it('repairs a projection under the target gate without binding or calling a model', async () => {
    let bindings = 0, leases = 0, releases = 0;
    const bridge = createNativeWikiModelBridge({ model: { bindKnowledgeModel: async () => { bindings++; throw new Error('MODEL_UNAVAILABLE'); }, requestKnowledgeMessage: async () => { throw new Error('unexpected'); } },
      gate: { admit: async () => { leases++; return 'lease'; }, release: async () => { releases++; }, project: async () => {}, publication: async () => {}, dispatched: async () => {}, stage: async () => {}, recover: async () => {}, withSlot: async (_id, work) => work() } });
    const result = await bridge.withProjection({ id: 'op' } as never, async () => 'projected');
    expect(result).toBe('projected'); expect([bindings, leases, releases]).toEqual([0, 1, 1]);
  });
  it('refuses recovery until the outstanding provider call has actually settled', async () => {
    let finish!: (value: any) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const model: any = { bindKnowledgeModel: async () => ({ bindingId: 'b', expectedModel: 'p/m', expectedConfiguration: 'c', model: { provider: 'p', id: 'm', api: 'openai-completions', contextWindow: 100000, maxTokens: 8000 } }), requestKnowledgeMessage: async () => { started(); return new Promise(resolve => { finish = resolve; }); } };
    const bridge = createNativeWikiModelBridge({ model, gate: { admit: async () => 'lease', release: async () => {}, project: async () => {}, publication: async () => {}, dispatched: async () => {}, stage: async () => {}, recover: async () => {}, withSlot: async (_id, work) => work() } });
    const binding = await bridge.bind('key'); const operation: any = { id: 'op', repositoryRoot: '/repo', branch: 'main', locale: 'zh', targetCommit: 'abc', model: binding };
    const signal = new AbortController().signal; await bridge.handle('native.admission', { operation }, signal);
    const pending = bridge.handle('native.model', { operation, requestId: 'r', purpose: 'wiki.full.page', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], tools: [], maxOutputTokens: 100 }, signal);
    await ready; await expect(bridge.recover(operation, { previousExecutorExited: true })).rejects.toThrow('OLD_EXECUTOR_NOT_DRAINED');
    finish({ role: 'assistant', content: [], api: 'openai-completions', provider: 'p', model: 'm', stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: 1 });
    await pending; await expect(bridge.recover(operation, { previousExecutorExited: true })).resolves.toBeUndefined();
  });
});
