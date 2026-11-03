import { describe, expect, it, vi } from 'vitest';
import { AgentDataStorage } from '../storage';
import { KnowledgeBuildStore } from './store';
import { create } from './testFixture';
import { createKnowledgeKernelRuntime } from './runtimeBridge';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../../shared/knowledgeKernelContracts';

const model = { bindingId: 'binding', expectedModel: 'test/model', expectedConfiguration: 'config', model: { id: 'model', name: 'model', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } as any;
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function ports(overrides: any = {}): any { return { controllerEpoch: 'epoch', project: {}, bindModel: async () => model, executeStage: async () => ({}), abortStage: async () => {}, withModelSlot: async (work: any) => work(), modelMessage: async () => ({ role: 'assistant', content: [], api: 'openai-completions', provider: 'test', model: 'model', stopReason: 'stop', usage, timestamp: Date.now() }), bindEpoch: async () => [], activateEpoch: async () => {}, ackUsage: async () => {}, ...overrides }; }

describe('knowledge kernel runtime bridge', () => {
  it('waits for bind and reconciliation before accepting requests', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const activated = vi.fn(async () => {});
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ bindEpoch: async () => { await gate; return []; }, activateEpoch: activated }));
    try {
      const request = runtime.request('admin.knowledge.drafts', { taskId: 'missing' });
      await Promise.resolve(); expect(activated).not.toHaveBeenCalled();
      release(); await runtime.ready; await request;
      expect(activated).toHaveBeenCalledWith('epoch');
    } finally { release(); await runtime.close(); storage.close(); }
  });

  it('uses the real Store to reserve, settle and reject a forged scope', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    const ack = vi.fn(async () => {}), provider = vi.fn(ports().modelMessage);
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ ackUsage: ack, modelMessage: provider }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      await (runtime.coordinator as any).options.bindModel(job.id);
      const input: any = { controllerEpoch: 'epoch', requestId: 'model-1', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 2000 } };
      await expect(runtime.request('admin.knowledge.worker', { kind: 'model', input: { ...input, fence: { ...fence, ownerId: 'forged' } } })).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
      await runtime.request('admin.knowledge.worker', { kind: 'model', input });
      expect(store.getExecutionRequest('model-1')).toMatchObject({ state: 'settled', actual: { totalTokens: 30 } });
      expect(ack).toHaveBeenCalledWith('model-1');
      await expect(runtime.request('admin.knowledge.worker', { kind: 'finish', input: { ...input, itemId: 'other', requestId: 'model-1', actual: { totalTokens: 1 } } })).rejects.toThrow();
    } finally { await runtime.close(); storage.close(); }
  });

  it('reconciles old provider usage before activating the new epoch', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const old = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'old' });
    const job = create(old), fence = old.claim('scope', job.id, 'owner', 0);
    old.beginAttempt(job.id, 'generate', 'page', fence, 'input');
    old.reserveExecutionBudget({ requestId: 'old-request', taskId: job.id, phase: 'generate', itemId: 'page', attempt: 1, fence, kind: 'model', reserved: { totalTokens: 1000 } });
    old.markExecutionDispatched('old-request'); old.setState(job.id, fence, 'failed');
    const ack = vi.fn(async () => {}), activate = vi.fn(async () => { expect(old.getExecutionRequest('old-request')).toMatchObject({ state: 'settled', actual: { totalTokens: 30 } }); });
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ bindEpoch: async () => [{ requestId: 'old-request', taskId: job.id, controllerEpoch: 'old', unknown: false, usage }], activateEpoch: activate, ackUsage: ack }));
    try { await runtime.ready; expect(activate).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledWith('old-request'); }
    finally { await runtime.close(); storage.close(); }
  });

  it('settles an aborted provider after its worker lease is released', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    let release!: () => void, dispatched = false, observedAbort = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ modelMessage: async (_input: any, signal: AbortSignal) => { dispatched = true; signal.addEventListener('abort', () => { observedAbort = true; }); await hold; return { stopReason: 'stop', usage }; } }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      await (runtime.coordinator as any).options.bindModel(job.id);
      const input = { controllerEpoch: 'epoch', requestId: 'held', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 100 } };
      const pending = runtime.request('admin.knowledge.worker', { kind: 'model', input });
      await vi.waitFor(() => expect(dispatched).toBe(true));
      store.releaseLease(job.id, fence);
      await runtime.request('admin.knowledge.abort', { requestId: 'held' });
      expect(observedAbort).toBe(true);
      release(); await pending;
      expect(store.getExecutionRequest('held')).toMatchObject({ state: 'settled', actual: { totalTokens: 30 } });
    } finally { release(); await runtime.close(); storage.close(); }
  });

  it('holds stage completion until its canceled provider has actually settled', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    let release!: () => void, dispatched = false, stageFinished = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ modelMessage: async () => { dispatched = true; await hold; return { stopReason: 'stop', usage }; }, executeStage: async () => ({ disposition: 'failed' }) }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      await (runtime.coordinator as any).options.bindModel(job.id);
      const input = { controllerEpoch: 'epoch', requestId: 'pending', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 100 } };
      const modelRun = runtime.request('admin.knowledge.worker', { kind: 'model', input });
      await vi.waitFor(() => expect(dispatched).toBe(true));
      const snapshotId = store.putSourceSnapshot(job.id, fence, { files: { 'a.txt': { hash: 'abc' } } });
      const stage = (runtime.coordinator as any).options.executeStage({ taskId: job.id, fence, phase:'generate', itemId:'page', attempt:1, key: job.metadata!.repoWiki!.key, sourceSnapshotId: snapshotId, input: { manifest: [{ path: 'a.txt', hash: 'abc' }] } }, new AbortController().signal).then(() => { stageFinished = true; });
      await runtime.request('admin.knowledge.abort', { requestId: 'pending' });
      await Promise.resolve(); expect(stageFinished).toBe(false);
      release(); await Promise.all([modelRun, stage]); expect(stageFinished).toBe(true);
    } finally { release(); await runtime.close(); storage.close(); }
  });

  it('rejects source manifests outside the task frozen snapshot before stage dispatch', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    const executeStage = vi.fn(async () => ({}));
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ executeStage }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0);
      const sourceSnapshotId = store.putSourceSnapshot(job.id, fence, { files: { 'src/a.ts': { hash: 'approved' } } });
      const request = { taskId: job.id, fence, key: job.metadata!.repoWiki!.key, sourceSnapshotId, input: { manifest: [{ path: '.env', hash: 'secret' }] } };
      await expect((runtime.coordinator as any).options.executeStage(request, new AbortController().signal)).rejects.toThrow('SOURCE_MANIFEST_MISMATCH');
      expect(executeStage).not.toHaveBeenCalled();
    } finally { await runtime.close(); storage.close(); }
  });

  it('does not dispatch a model request whose cancel arrived first', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    const provider = vi.fn(ports().modelMessage), runtime = createKnowledgeKernelRuntime(storage.db, ports({ modelMessage: provider }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      await (runtime.coordinator as any).options.bindModel(job.id);
      const input = { controllerEpoch: 'epoch', requestId: 'early', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 100 } };
      await runtime.request('admin.knowledge.abort', { requestId: 'early' });
      await expect(runtime.request('admin.knowledge.worker', { kind: 'model', input })).rejects.toThrow('aborted');
      expect(provider).not.toHaveBeenCalled();
    } finally { await runtime.close(); storage.close(); }
  });

  it('caps output and reserves the remaining token budget after acquiring the slot', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    let seen: any;
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ modelMessage: async (input: any) => { seen = input; return { stopReason: 'stop', usage }; } }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      store.reserveExecutionBudget({ requestId: 'prior', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, kind: 'model', reserved: { totalTokens: DEFAULT_KNOWLEDGE_BUDGETS.unit.maxTotalTokens - 2000 } });
      store.finishExecutionBudget('prior', { totalTokens: DEFAULT_KNOWLEDGE_BUDGETS.unit.maxTotalTokens - 2000 });
      await (runtime.coordinator as any).options.bindModel(job.id);
      const input = { controllerEpoch: 'epoch', requestId: 'limited', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript: { messages: [] }, options: { maxTokens: 2000 } };
      await runtime.request('admin.knowledge.worker', { kind: 'model', input });
      expect(seen.options.maxTokens).toBeGreaterThan(0); expect(seen.options.maxTokens).toBeLessThan(2000);
      expect(store.getExecutionRequest('limited')!.reserved.totalTokens).toBe(2000);
    } finally { await runtime.close(); storage.close(); }
  });

  it('estimates transcript tokens from bytes instead of counting each byte as a token', async () => {
    const storage = new AgentDataStorage(':memory:'); storage.migrate();
    const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' });
    const runtime = createKnowledgeKernelRuntime(storage.db, ports({ modelMessage: async () => ({ stopReason: 'stop', usage }) }));
    try {
      await runtime.ready;
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0); store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      // A later tool-loop turn: 60k already used and a ~30 KB transcript. Counting bytes as tokens
      // would overflow this binding's 16k context window and report BUDGET_EXHAUSTED.
      store.reserveExecutionBudget({ requestId: 'used', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, kind: 'model', reserved: { totalTokens: 60000 } });
      store.finishExecutionBudget('used', { totalTokens: 60000 });
      await (runtime.coordinator as any).options.bindModel(job.id);
      const transcript = { messages: [{ role: 'user', content: 'x'.repeat(30000) }] };
      const input = { controllerEpoch: 'epoch', requestId: 'fourth', taskId: job.id, fence, phase: 'generate', itemId: 'page', attempt: 1, bindingId: 'binding', transcript, options: { maxTokens: 2000 } };
      await runtime.request('admin.knowledge.worker', { kind: 'model', input });
      const reserved = store.getExecutionRequest('fourth')!.reserved.totalTokens!;
      expect(reserved).toBeLessThan(Math.ceil(Buffer.byteLength(JSON.stringify(transcript)) / 2));
    } finally { await runtime.close(); storage.close(); }
  });
});

it('drains only the returning execution while a sibling model remains in flight', async () => {
 const storage=new AgentDataStorage(':memory:');storage.migrate();const store=new KnowledgeBuildStore(storage.db,{controllerEpoch:'epoch'});
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let started=false;
 const runtime=createKnowledgeKernelRuntime(storage.db,ports({modelMessage:async()=>{started=true;await held;return {stopReason:'stop',usage};},executeStage:async()=>({disposition:'prepared'})}));
 try {await runtime.ready;const job=create(store),fence=store.claim('scope',job.id,'owner',0);store.beginAttempt(job.id,'generate','a',fence,'a');store.beginAttempt(job.id,'generate','b',fence,'b');await (runtime.coordinator as any).options.bindModel(job.id);
 const modelRun=runtime.request('admin.knowledge.worker',{kind:'model',input:{controllerEpoch:'epoch',requestId:'b-model',taskId:job.id,fence,phase:'generate',itemId:'b',attempt:1,bindingId:'binding',transcript:{messages:[]},options:{maxTokens:100}}});
 await vi.waitFor(()=>expect(started).toBe(true));const sourceSnapshotId=store.putSourceSnapshot(job.id,fence,{files:{}});let finished=false;
 const a=(runtime.coordinator as any).options.executeStage({taskId:job.id,fence,phase:'generate',itemId:'a',attempt:1,key:job.metadata!.repoWiki!.key,sourceSnapshotId,input:{manifest:[]}},new AbortController().signal).then(()=>finished=true);
 await vi.waitFor(()=>expect(finished).toBe(true),{timeout:300});release();await Promise.all([a,modelRun]);
 }finally{release();await runtime.close();storage.close();}
});
