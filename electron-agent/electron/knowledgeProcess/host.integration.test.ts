import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { RepoWikiProcessClient } from '../../vendor/repo-wiki/packages/process/src/client';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../shared/knowledgeKernelContracts';

const require = createRequire(import.meta.url);
describe('private knowledge worker IPC', () => {
  it('rejects reverse requests with a forged epoch before reaching the supervisor handler', async () => {
    const base = await mkdtemp(join(tmpdir(), 'knowledge-forged-'));
    const entry = join(base, 'child.cjs');
    await writeFile(entry, `process.send({v:1,type:'ready',pid:process.pid}); process.on('message',m=>{ if(m.type==='knowledgeInvoke') { global.invocation=m.id; process.send({v:1,type:'knowledgeReverse',id:'reverse',kind:'model',input:{...m.input,fence:{...m.input.fence,controllerEpoch:'forged'}}}); } else if(m.type==='knowledgeReverseResponse') process.send({v:1,type:'knowledgeResponse',id:global.invocation,ok:true,result:m}); });`);
    const client = new RepoWikiProcessClient({ entry, executable: process.execPath, dataDir: base, maxRestarts: 0, stopTimeoutMs: 50 });
    let called = false;
    client.setKnowledgeRequestHandler(async () => { called = true; return {}; });
    try {
      const fence = { ledgerId: 'ledger', controllerEpoch: 'epoch', ownerId: 'owner', generation: 1 };
      const response: any = await client.invokeKnowledge('stage.execute', { taskId: 'task', fence, phase: 'generate', itemId: 'page', attempt: 1 });
      expect(response).toMatchObject({ ok: false, error: 'INVALID_KNOWLEDGE_SCOPE' });
      expect(called).toBe(false);
    } finally { await client.stop(); await rm(base, { recursive: true, force: true }); }
  });

  it('executes an official Agent and a Read through an actual Electron child', async () => {
    const base = await mkdtemp(join(tmpdir(), 'knowledge-child-'));
    const root = join(base, 'project'), out = join(base, 'out'); await mkdir(root); await writeFile(join(root, 'source.txt'), 'source');
    const client = new RepoWikiProcessClient({ entry: join(out, REPO_WIKI_HOST_ENTRY), executable: require('electron'), dataDir: join(base, 'data'), allowedRoots: [root], env: { REPOWIKI_EMBEDDED: '1' }, maxRestarts: 0 });
    try {
      await buildRepoWikiHost(resolve('.'), out);
      const project = await client.invoke('create', { path: root, language: 'en' });
      await client.invokeKnowledge('host.updateRoots', { roots: [] });
      await expect(client.invoke('create', { path: root, language: 'en' })).rejects.toThrow();
      await client.invokeKnowledge('host.updateRoots', { roots: [root, join(base, 'unavailable')] });
      expect((await client.invoke('create', { path: root, language: 'en' })).id).toBe(project.id);
      const metadata: any = await client.invokeKnowledge('project.read', { projectId: project.id, domain: 'wiki' });
      const fence = { ledgerId: 'ledger', controllerEpoch: 'epoch', ownerId: 'owner', generation: 1 };
      const model: any = { id: 'test', name: 'Test', api: 'openai-completions', provider: 'test', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const seen: string[] = []; let turn = 0;
      client.setKnowledgeRequestHandler(async (kind, input: any) => {
        seen.push(kind); expect(input.taskId).toBe('task'); expect(input.fence).toEqual(fence);
        if (kind !== 'model') return {};
        turn++;
        return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: turn === 1 ? [{ type: 'toolCall', id: 'read-1', name: 'Read', arguments: { path: 'source.txt' } }] : turn === 2 ? [{ type: 'toolCall', id: 'grep-1', name: 'Grep', arguments: { pattern: 'source', context: 0 } }] : [{ type: 'text', text: '{"markdown":"source"}' }], stopReason: turn <= 2 ? 'toolUse' : 'stop', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
      });
      const request = { version: 1, taskId: 'task', key: metadata.key, fence, phase: 'generate', itemId: 'page', attempt: 1, inputHash: 'input', sourceSnapshotId: 'snapshot', binding: { bindingId: 'binding', model }, budget: DEFAULT_KNOWLEDGE_BUDGETS, input: { root, manifest: [{ path: 'source.txt', hash: createHash('sha256').update('source').digest('hex') }], systemPrompt: 'JSON', userPrompt: 'Read source' } };
      expect(await client.invokeKnowledge('stage.execute', request)).toMatchObject({ disposition: 'prepared', payload: { markdown: 'source' }, evidence: expect.arrayContaining([expect.objectContaining({ path: 'source.txt' }), expect.objectContaining({ kind: 'search' })]) });
      expect(client.pid).not.toBe(process.pid); expect(seen.filter(x => x === 'model')).toHaveLength(3); expect(seen).toContain('reserve'); expect(seen).toContain('finish');
      let started = false, cancelled = false;
      client.setKnowledgeRequestHandler(async (kind, _input, signal) => {
        if (kind !== 'model') return {};
        started = true; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }, { once: true }));
      });
      const pending = client.invokeKnowledge('stage.execute', { ...request, taskId: 'other' });
      await vi.waitFor(() => expect(started).toBe(true));
      await expect(client.abortStage({ taskId: 'other', fence: { ...fence, controllerEpoch: 'forged' } })).rejects.toThrow('STALE_FENCE');
      await expect(client.abortStage({ taskId: 'other', fence })).resolves.toEqual({ aborted: true });
      expect(cancelled).toBe(true);
      expect(await pending).toMatchObject({ disposition: 'failed' });
      await expect(client.invokeKnowledge('stage.execute', { ...request, input: { ...request.input, userPrompt: 'x'.repeat(4 * 1024 * 1024) } })).rejects.toThrow('FRAME_TOO_LARGE');
    } finally { await client.stop(); await rm(base, { recursive: true, force: true }); }
  }, 45000);
});

it('keeps reverse permissions for two sibling execution tuples when one settles',async()=>{
 const base=await mkdtemp(join(tmpdir(),'knowledge-client-siblings-')),entry=join(base,'child.cjs');
 await writeFile(entry,`process.send({v:1,type:'ready',pid:process.pid});const requests=new Map();process.on('message',m=>{if(m.type==='knowledgeInvoke'&&m.method==='stage.execute'){requests.set(m.input.itemId,m);process.send({v:1,type:'knowledgeReverse',id:'r-'+m.input.itemId,kind:'model',input:m.input});}else if(m.type==='knowledgeReverseResponse'){const id=m.id.slice(2),request=requests.get(id);process.send({v:1,type:'knowledgeResponse',id:request.id,ok:true,result:m});}});`);
 const client=new RepoWikiProcessClient({entry,executable:process.execPath,dataDir:base,maxRestarts:0,stopTimeoutMs:50});let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);client.setKnowledgeRequestHandler(async(_kind,input)=>{if(input.itemId==='b')await hold;return {itemId:input.itemId};});
 try{const fence={ledgerId:'l',controllerEpoch:'e',ownerId:'o',generation:1};const request={taskId:'t',fence,phase:'generate',itemId:'a',attempt:1};const a=client.invokeKnowledge('stage.execute',request);const b=client.invokeKnowledge('stage.execute',{...request,itemId:'b'});expect(await a).toMatchObject({ok:true,result:{itemId:'a'}});release();expect(await b).toMatchObject({ok:true,result:{itemId:'b'}});}finally{release();await client.stop();await rm(base,{recursive:true,force:true});}
});
