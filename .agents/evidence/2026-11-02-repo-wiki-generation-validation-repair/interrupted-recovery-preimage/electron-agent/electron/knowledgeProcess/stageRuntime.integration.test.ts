import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../shared/knowledgeKernelContracts';
import { parseStageJson, runKnowledgeStage } from './stageRuntime';
import { createKnowledgeReadTools } from './readTools';
import { KnowledgeMessageBroker } from '../agent/knowledgeModelTurn';
import { dispatchKnowledgeModelRequest } from '../agentData/knowledgeKernel/modelRequests';
import { create, fixture } from '../agentData/knowledgeKernel/testFixture';
import { analyseKnowledgeDelta } from '../agentData/knowledgeKernel/incremental';

describe('knowledge stage Agent', () => {
  it('commits root Glob, ListDir and Grep evidence and invalidates it when a file is added', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-search-scope-'));
    const { storage, store } = fixture();
    try {
      writeFileSync(join(root, 'source.txt'), 'source');
      const hash = createHash('sha256').update('source').digest('hex');
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const job = create(store), fence = store.claim('scope', job.id, 'owner', 0);
      const attempt = store.beginAttempt(job.id, 'generate', 'page', fence, 'input');
      const request: any = { version: 1, taskId: job.id, key: job.metadata!.repoWiki!.key, fence, phase: 'generate', itemId: 'page', attempt, inputHash: 'input', sourceSnapshotId: 'snapshot', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash }], systemPrompt: 'JSON', userPrompt: 'Search root' } };
      let turn = 0;
      const output = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async () => {
        turn++;
        const content = turn === 1 ? [{ type: 'toolCall', id: 'g', name: 'Glob', arguments: { pattern: '*.txt' } }, { type: 'toolCall', id: 'l', name: 'ListDir', arguments: {} }, { type: 'toolCall', id: 's', name: 'Grep', arguments: { pattern: 'source' } }] : [{ type: 'text', text: '{"markdown":"source"}' }];
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: turn === 1 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as any;
      } });
      expect(output.disposition).toBe('prepared');
      expect(() => store.commitItem(output, attempt)).not.toThrow();
      const scopes = output.evidence.filter(item => item.kind !== 'read');
      expect(scopes).toHaveLength(3);
      expect(scopes.every(item => item.path === '.' && item.scope === '.')).toBe(true);
      expect(output.evidence.filter(item => item.kind === 'read')).toMatchObject([{ path: 'source.txt', startLine: 1, endLine: 1 }]);
      const before = { hashes: { 'source.txt': hash }, edges: [] as [string, string][], coverage: 'complete' as const };
      writeFileSync(join(root, 'new.txt'), 'new');
      const after = { ...before, hashes: { ...before.hashes, 'new.txt': createHash('sha256').update('new').digest('hex') } };
      expect(analyseKnowledgeDelta(before, after, [{ id: 'page', sources: [], dependencies: [], scopes: scopes.map(item => item.path) }])).toMatchObject({ kind: 'affected', invalidated: ['page'] });
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('runs a real Agent tool loop and reserves before executing each tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-runtime-'));
    try {
      writeFileSync(join(root, 'source.txt'), 'source');
      const hash = createHash('sha256').update('source').digest('hex');
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const calls: string[] = [];
      const request: any = { version: 1, taskId: 'task', key: {}, fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', sourceSnapshotId: 'snapshot', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash }], systemPrompt: 'Return JSON', userPrompt: 'Read source' } };
      let turn = 0;
      const output = await runKnowledgeStage(request, { reserve: async i => { calls.push(i.kind); }, finish: async () => {}, requestModel: async () => { turn++; const content = turn === 1 ? [{ type: 'toolCall', id: 'call', name: 'Read', arguments: { path: 'source.txt' } }] : [{ type: 'text', text: '{"markdown":"source"}' }]; return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: turn === 1 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as any; } });
      expect(output).toMatchObject({ disposition: 'prepared', payload: { markdown: 'source' }, evidence: [{ path: 'source.txt', hash }] });
      expect(turn).toBe(2); expect(calls).toContain('tool'); expect(calls).toContain('time');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('continues after a partial Read, records only the lines returned, and lets the model read the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-partial-'));
    try {
      const text = 'line\n'.repeat(410); writeFileSync(join(root, 'source.txt'), text);
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash: createHash('sha256').update(text).digest('hex') }], systemPrompt: 'JSON', userPrompt: 'Read' } };
      const seen: string[] = []; let turn = 0;
      const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async (input: any) => {
        turn++;
        const toolText = JSON.stringify(input.transcript).match(/\[truncated: [^\]]*\]/)?.[0]; if (toolText) seen.push(toolText);
        const content = turn === 1 ? [{ type: 'toolCall', id: 'a', name: 'Read', arguments: { path: 'source.txt' } }]
          : turn === 2 ? [{ type: 'toolCall', id: 'b', name: 'Read', arguments: { path: 'source.txt', offset: 401 } }] : [{ type: 'text', text: '{"markdown":"m"}' }];
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: turn < 3 ? 'toolUse' : 'stop', usage, timestamp: Date.now() } as any;
      } });
      expect(result).toMatchObject({ disposition: 'prepared', payload: { markdown: 'm' } });
      expect(seen[0]).toContain('showed lines 1-400 of 411; call Read with offset=401');
      expect(result.evidence.filter(e => e.kind === 'read').map(e => [e.startLine, e.endLine])).toEqual([[1, 400], [401, 411]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts fenced or prose-wrapped JSON and rejects anything that is not an object', () => {
    expect(parseStageJson('```json\n{"summary":"s"}\n```')).toEqual({ summary: 's' });
    expect(parseStageJson('Here is the result:\n{"a":1}\nDone.')).toEqual({ a: 1 });
    expect(() => parseStageJson('```json [1,2] ```')).toThrow('INVALID_MODEL_JSON');
    expect(() => parseStageJson('no json here')).toThrow('INVALID_MODEL_JSON');
  });

  it('asks once more for bare JSON when the answer cannot be parsed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-json-'));
    try {
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'overview', itemId: 'overview', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [], systemPrompt: 'JSON', userPrompt: 'Go' } };
      const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      let turn = 0;
      const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async () => { turn++; return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: turn === 1 ? 'Sure! The overview is below' : '{"summary":"fixed"}' }], stopReason: 'stop', usage, timestamp: Date.now() } as any; } });
      expect(result).toMatchObject({ disposition: 'prepared', payload: { summary: 'fixed' } });
      expect(turn).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records the lines a Grep returned as citable evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-grep-'));
    try {
      const text = 'a\nneedle one\nb\nneedle two\nc\n'; writeFileSync(join(root, 'src.txt'), text);
      const observations: any[] = [];
      const tools = createKnowledgeReadTools({ root }, [{ path: 'src.txt', hash: createHash('sha256').update(text).digest('hex') }], o => observations.push(o));
      await tools.find(tool => tool.name === 'Grep')!.execute('g', { pattern: 'needle' });
      expect(observations.filter(o => o.kind === 'read').map(o => [o.startLine, o.endLine])).toEqual([[2, 2], [4, 4]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a forbidden or missing path to the model instead of failing the stage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-forbidden-'));
    try {
      writeFileSync(join(root, 'source.txt'), 'source');
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'catalogue', itemId: 'c', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash: createHash('sha256').update('source').digest('hex') }], systemPrompt: 'JSON', userPrompt: 'Go' } };
      const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      let turn = 0, seen = '';
      const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async (input: any) => {
        turn++; seen = JSON.stringify(input.transcript);
        const content = turn === 1 ? [{ type: 'toolCall', id: 'x', name: 'Read', arguments: { path: '.agents/secret.md' } }] : [{ type: 'text', text: '{"children":[]}' }];
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: turn === 1 ? 'toolUse' : 'stop', usage, timestamp: Date.now() } as any;
      } });
      expect(result).toMatchObject({ disposition: 'prepared', payload: { children: [] } });
      expect(seen).toContain('FORBIDDEN_PATH');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('tells the model its budget and forces a final answer on the last allowed turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-budget-'));
    try {
      writeFileSync(join(root, 'source.txt'), 'source');
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const budget = { ...DEFAULT_KNOWLEDGE_BUDGETS, unit: { ...DEFAULT_KNOWLEDGE_BUDGETS.unit, maxModelRequests: 4 } };
      const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget, input: { root, manifest: [{ path: 'source.txt', hash: createHash('sha256').update('source').digest('hex') }], systemPrompt: 'JSON', userPrompt: 'Read' } };
      const usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const transcripts: string[] = [];
      // A model that never stops reading on its own, like the overview stage that hit BUDGET_EXHAUSTED.
      const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async (input: any) => {
        const text = JSON.stringify(input.transcript); transcripts.push(text);
        const final = text.includes('This is your final turn');
        const content = final ? [{ type: 'text', text: '{"markdown":"done"}' }] : [{ type: 'toolCall', id: `c${transcripts.length}`, name: 'Read', arguments: { path: 'source.txt' } }];
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: final ? 'stop' : 'toolUse', usage, timestamp: Date.now() } as any;
      } });
      expect(result).toMatchObject({ disposition: 'prepared', payload: { markdown: 'done' } });
      expect(transcripts).toHaveLength(4);
      expect(transcripts[0]).toContain('at most 4 model turns');
      expect(transcripts[2]).toContain('more tool turn(s)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a Read range within the result budget instead of claiming unseen lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-bytes-'));
    try {
      const text = `${'x'.repeat(1000)}\n`.repeat(100); writeFileSync(join(root, 'wide.txt'), text);
      const observations: any[] = [];
      const [read] = createKnowledgeReadTools({ root, maxResultBytes: 32768 }, [{ path: 'wide.txt', hash: createHash('sha256').update(text).digest('hex') }], o => observations.push(o));
      const output = await read.execute('r', { path: 'wide.txt' });
      const shown = (output.content[0] as { text: string }).text;
      const delivered = shown.split('\n[truncated')[0].split('\n').length;
      expect(observations[0]).toMatchObject({ startLine: 1, endLine: delivered, truncated: true });
      expect(shown).toContain(`offset=${delivered + 1}`);
      expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(32768);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('leaves schema checks to the coordinator when a partial Read is followed by a final answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-truncated-'));
    try {
      const text = 'line\n'.repeat(410); writeFileSync(join(root, 'source.txt'), text);
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash: createHash('sha256').update(text).digest('hex') }], systemPrompt: 'JSON', userPrompt: 'Read' } };
      let turn = 0;
      const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async () => { turn++; return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: turn === 1 ? [{ type: 'toolCall', id: 'call', name: 'Read', arguments: { path: 'source.txt' } }] : [{ type: 'text', text: '{}' }], stopReason: turn === 1 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as any; } });
      expect(result).toMatchObject({ disposition: 'prepared', payload: {} });
      expect(result.error).toBeUndefined();
      expect(result.evidence).toMatchObject([{ kind: 'read', startLine: 1, endLine: 400 }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('emits only stable model error codes and confirmed HTTP status, without leaking provider text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-safe-model-error-'));
    const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [], systemPrompt: 'JSON', userPrompt: 'hello' } };
    try {
      for (const [message, code, retriable] of [['HTTP 503 unavailable https://x/?key=secret','MODEL_HTTP_503',true], ['429 Too Many Requests token=secret','MODEL_HTTP_429',true], ['HTTP 401 Unauthorized token=secret','MODEL_HTTP_401',false], ['provider rejected https://x/?key=secret','MODEL_ERROR',false], ['provider https://x/?code=503&key=secret','MODEL_ERROR',true]] as const) {
        const result=await runKnowledgeStage(request,{reserve:async()=>{},finish:async()=>{},requestModel:async()=>({role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'error',errorMessage:message,usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()})});
        expect(result.error).toEqual({code,message:code,retriable});expect(JSON.stringify(result.error)).not.toContain('secret');
      }
      let turn=0;const retryResult=await runKnowledgeStage(request,{reserve:async()=>{},finish:async()=>{},requestModel:async()=>({role:'assistant',api:model.api,provider:model.provider,model:model.id,content:++turn===1?[{type:'text',text:'not json'}]:[],stopReason:turn===1?'stop':'error',errorMessage:turn===1?undefined:'HTTP 503 https://x/?key=secret',usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()})});
      expect(turn).toBe(2);expect(retryResult.error).toEqual({code:'MODEL_HTTP_503',message:'MODEL_HTTP_503',retriable:false});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('marks provider 429 and 5xx errors retriable without retrying budget failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-error-'));
    const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const request: any = { version: 1, taskId: 'task', fence: { controllerEpoch: 'epoch' }, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [], systemPrompt: 'JSON', userPrompt: 'hello' } };
    try {
      for (const message of ['429 Too Many Requests', 'HTTP 503 unavailable']) {
        const result = await runKnowledgeStage(request, { reserve: async () => {}, finish: async () => {}, requestModel: async () => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'error', errorMessage: message, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }) });
        expect(result.error).toMatchObject({ retriable: true });
      }
      const blocked = await runKnowledgeStage(request, { reserve: async () => { throw new Error('BUDGET_EXHAUSTED'); }, finish: async () => {}, requestModel: async () => { throw new Error('unexpected'); } });
      expect(blocked).toMatchObject({ disposition: 'blocked', error: { retriable: false } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs two real provider tool calls through the stage, broker and durable reservations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-loopback-'));
    const { storage, store } = fixture();
    let count = 0;
    const server = createServer((req, res) => {
      req.resume(); req.on('end', () => {
        count++;
        const delta = count <= 2 ? { tool_calls: [{ index: 0, id: `c${count}`, type: 'function', function: { name: 'Read', arguments: '{"path":"source.txt"}' } }] } : { content: '{"markdown":"source"}' };
        const chunk = { id: `r${count}`, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: count <= 2 ? 'tool_calls' : 'stop' }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      writeFileSync(join(root, 'source.txt'), 'source');
      const hash = createHash('sha256').update('source').digest('hex');
      const port = (server.address() as any).port;
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const task = create(store), fence = store.claim('scope', task.id, 'owner', 0); store.beginAttempt(task.id, 'generate', 'page', fence, 'input');
      const binding: any = { bindingId: 'binding', expectedModel: 'test/test', expectedConfiguration: 'config', model };
      const broker = new KnowledgeMessageBroker({ bind: async () => binding, request: async (_binding, transcript, options) => streamSimple(model, transcript, { ...options, apiKey: 'test' }).result() });
      await broker.bindEpoch('epoch'); broker.activateEpoch('epoch'); await broker.bind(task.id);
      const reserve = async (entry: any) => { store.reserveExecutionBudget({ ...entry, taskId: task.id, fence, phase: 'generate', itemId: 'page', attempt: 1 }); };
      const finish = async (id: string, usage: any) => { store.finishExecutionBudget(id, usage); };
      const request: any = { version: 1, taskId: task.id, fence, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', binding, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash }], systemPrompt: 'Return JSON', userPrompt: 'Read source' } };
      const output = await runKnowledgeStage(request, { reserve, finish, markDispatched: async id => store.markExecutionDispatched(id), release: async id => store.releaseExecutionBudget(id), requestModel: async (input, signal) => dispatchKnowledgeModelRequest(input, { tokenReservation: 100, withSlot: async work => work(), reserve, finish, markDispatched: async id => store.markExecutionDispatched(id), release: async id => store.releaseExecutionBudget(id), dispatch: (value, s) => broker.request(value, s), ack: async id => { broker.ackUsage(id); } }, signal) });
      expect(output).toMatchObject({ disposition: 'prepared', payload: { markdown: 'source' } });
      expect(count).toBe(3); expect(store.usage(task.id)).toMatchObject({ modelRequests: 3, toolCalls: 2, totalTokens: 300, unknown: true });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); storage.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
