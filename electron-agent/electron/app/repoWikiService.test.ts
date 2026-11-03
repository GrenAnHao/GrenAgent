import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserWindow } from 'electron';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RepoWikiService, isTrustedRepoWikiSender, repoWikiModelCacheKey } from './repoWikiService';

// Real supervisor and wire protocol. Only repository engine/model are deterministic.
const childSource = `
const fs = require('node:fs'), path = require('node:path');
const data = process.env.REPOWIKI_DATA_DIR; fs.mkdirSync(data, { recursive: true });
const file = path.join(data, 'projects.json');
let projects = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
let generation, sequence = 0, runSequence = 0;
const send = m => process.send({v:1,...m});
const respond = (id,result) => send({type:'response',id,ok:true,result});
const progress = (m,status) => send({type:'event',event:{project_id:m.input.project_id,context_id:m.scope.contextId,
  instance_id:'fixture-'+process.pid,sequence:++sequence,time:new Date().toISOString(),run:{id:m.runId||'old-run',status}}});
process.on('message',m=>{
  if(m.type==='cancelContext') {
    if(generation?.scope.contextId===m.contextId) { send({type:'modelCancel',id:'completion'}); generation=undefined; }
    return respond(m.id,{});
  }
  if(m.type==='cancelRequest') return;
  if(m.type==='modelResponse') {
    if(generation) { const active=generation; generation=undefined; progress(active,'completed'); respond(active.id,{run_id:active.runId,status:m.ok?m.text:'model-failed'}); }
    return;
  }
  if(m.type!=='request') return;
  if(m.action==='shutdown') {
    if(generation) send({type:'modelCancel',id:'completion'});
    generation=undefined; return setTimeout(()=>{fs.writeFileSync(path.join(data,'stopped'),''+process.pid);respond(m.id,{});process.disconnect()},30);
  }
  if(m.action==='create') {
    let project=projects.find(p=>p.path===m.input.path&&p.language===(m.input.language||'zh'));
    if(!project){project={id:'project-'+projects.length,name:path.basename(m.input.path),path:m.input.path,language:m.input.language||'zh',watch:false};projects.push(project);fs.writeFileSync(file,JSON.stringify(projects));}
    return respond(m.id,project);
  }
  if(m.action==='project') {
    const project=projects.find(p=>p.id===m.input.project_id);
    if(fs.existsSync(path.join(data,'delay-project'))){fs.writeFileSync(path.join(data,'project-requested'),'1');return setTimeout(()=>respond(m.id,project),120)}
    return respond(m.id,project);
  }
  if(m.action==='watch'){setTimeout(()=>progress(m,'ready'),60);return respond(m.id,projects.find(p=>p.id===m.input.project_id))}
  if(m.action==='generate') {
    m.runId='run-'+(++runSequence);generation=m;fs.writeFileSync(path.join(data,'generation-input.json'),JSON.stringify(m));
    return send({type:'modelRequest',id:'completion',scope:m.scope,input:{systemPrompt:'system',user:'source',maxTokens:123}});
  }
  if(m.action==='run') return respond(m.id,{status:generation?'running':'idle'});
  if(m.action==='cancel') {
    send({type:'modelCancel',id:'completion'});
    if(generation){respond(generation.id,{run_id:generation.runId,status:'cancelled'});progress(generation,'cancelled');}
    generation=undefined;return respond(m.id,{status:'cancelled'});
  }
  if(m.action==='edit'){fs.appendFileSync(path.join(data,'mutations'),'edit\\n');process.exit(7)}
});
fs.writeFileSync(path.join(data,'started'),'1');
setTimeout(()=>send({type:'ready',pid:process.pid}),fs.existsSync(path.join(data,'delay-ready'))?120:0);
`;

let fixtureDir: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { fixtureDir = await mkdtemp(join(tmpdir(), 'repo-wiki-wire-')); await writeFile(join(fixtureDir, 'child.cjs'), childSource); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'repo-wiki-service-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'approved-a'), b = join(root, 'approved-b'); await mkdir(a); await mkdir(b);
  let roots = [a], rootFailure = false, modelKey = 'provider/model:v1', available = true;
  let complete = async (input: any, signal: AbortSignal) => `${input.systemPrompt}/${input.user}/${input.maxTokens}/${signal.aborted}`;
  const commands = new Map<string, (event: any, input: any) => Promise<any>>();
  const frame = { url: 'file:///app/index.html', parent: null }, sent: any[] = [];
  const contents = { id: 1, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: (...args: any[]) => sent.push(args) };
  const window = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
  // This boundary fixture implements exactly the window/frame members read by
  // isTrustedRepoWikiSender; preserve its real identity without mocking Electron's full API.
  const trustedWindow = window as unknown as BrowserWindow;
  const allowedWorkspaces = vi.fn(async () => { if (rootFailure) throw new Error('project registry unavailable'); return roots; });
  const resolveModel = vi.fn(async (_workspace?: string) => ({ cacheKey: modelKey, available, complete: (input: any, signal: AbortSignal) => complete(input, signal) }));
  const service = new RepoWikiService({ entry: join(fixtureDir, 'child.cjs'), dataDir: join(root, 'data'), configurationPollMs: 0,
    processOptions: { maxRestarts: 1, restartDelayMs: 5 }, allowedWorkspaces, projectSnapshot: () => roots,
    registerCommand: (name, handler) => { commands.set(name, handler); return () => { commands.delete(name); }; }, resolveModel,
    isTrustedSender: (e) => isTrustedRepoWikiSender(e, { window: trustedWindow, appUrl: 'file:///app/index.html', windowForSender: () => trustedWindow }) });
  cleanup.push(() => service.stop());
  const raw = (action: string, input: any = {}, sender: any = event) => commands.get('repoWiki_' + action)!(sender, input);
  const activate = (workspace: string | null = a, language?: string) => raw('activate', { workspace, ...(language ? { language } : {}) });
  const hydrate = async (workspace = a, language?: string) => { const context = await activate(workspace, language); const loaded = await raw('hydrate', { __repoWikiContext: context.context_id }); return { ...context, project_id: loaded.project.id, project: loaded.project }; };
  const call = (context: any, action: string, input: any = {}) => raw(action, { ...input, __repoWikiContext: context.context_id });
  return { root, a, b, service, raw, activate, hydrate, call, event, frame, contents, sent, commands, resolveModel, allowedWorkspaces,
    setRoots: (value: string[]) => { roots = value; }, failRoots: () => { rootFailure = true; }, setKey: (value: string) => { modelKey = value; },
    setAvailable: (value: boolean) => { available = value; }, setComplete: (value: typeof complete) => { complete = value; } };
}

describe('RepoWiki host process service', () => {
  it('shows seven host projects and binds before any registry I/O, model preparation or child', async () => {
    const t = await setup(); t.setRoots(Array.from({ length: 7 }, (_, i) => join(t.root, 'host-' + i)));
    const start = performance.now(), context = await t.activate(join(t.root, 'host-0'));
    expect(context).toMatchObject({ status: 'bound', project_id: null });
    expect((await t.raw('hostProjects')).projects).toHaveLength(7);
    expect(t.service.pid).toBeUndefined(); expect(t.allowedWorkspaces).not.toHaveBeenCalled(); expect(t.resolveModel).not.toHaveBeenCalled();
    console.info('seven-project activation milliseconds:', (performance.now() - start).toFixed(3));
  });
  it('hydrates only the current root and reuses its language namespace without describing a model', async () => {
    const t = await setup(); t.setRoots([t.a, t.b]); const a = await t.hydrate();
    expect(JSON.parse(await readFile(join(t.root, 'data', 'projects.json'), 'utf8'))).toHaveLength(1);
    const again = await t.hydrate(); expect(again.project_id).toBe(a.project_id); expect(t.resolveModel).not.toHaveBeenCalled();
    const en = await t.hydrate(t.a, 'en'); expect(en.project_id).not.toBe(a.project_id);
    expect((await t.activate(t.a)).language).toBe('en');
    await expect(t.call(en, 'project', { project_id: a.project_id })).rejects.toMatchObject({ status: 403 });
    await expect(t.call(en, 'watch', { project_id: en.project_id, enabled: true, unknown: true })).rejects.toMatchObject({ status: 400 });
  });
  it('rejects an unapproved hydrate before starting a process', async () => {
    const t = await setup(), context = await t.activate(t.b);
    expect(context.status).toBe('pending'); await expect(t.call(context, 'hydrate')).rejects.toMatchObject({ status: 403 });
    expect(t.service.pid).toBeUndefined(); expect(t.resolveModel).not.toHaveBeenCalled();
  });
  it('rejects a registered canonical root that has been replaced by a junction', async () => {
    const t = await setup(); await rm(t.a, { recursive: true }); await symlink(t.b, t.a, 'junction');
    const context = await t.activate(); await expect(t.call(context, 'hydrate')).rejects.toMatchObject({ status: 403 });
    expect(t.service.pid).toBeUndefined();
  });
  it('rechecks authoritative snapshot after child startup before writing current-project files', async () => {
    const t = await setup(); await mkdir(join(t.root, 'data')); await writeFile(join(t.root, 'data', 'delay-ready'), '1');
    const hydration = t.hydrate().catch((error) => error);
    await vi.waitFor(async () => expect(await readFile(join(t.root, 'data', 'started'), 'utf8')).toBe('1'));
    t.setRoots([]);
    expect(await hydration).toMatchObject({ status: 403 });
    await expect(readFile(join(t.root, 'data', 'projects.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps one PID through A-B-A, rejects old results/events and restores the same DB identity', async () => {
    const t = await setup(); t.setRoots([t.a, t.b]); const a = await t.hydrate(), pid = t.service.pid;
    await writeFile(join(t.root, 'data', 'delay-project'), '1');
    const read = t.call(a, 'project', { project_id: a.project_id }).catch((error) => error);
    await vi.waitFor(async () => expect(await readFile(join(t.root, 'data', 'project-requested'), 'utf8')).toBe('1'));
    await t.call(a, 'watch', { project_id: a.project_id, enabled: true });
    const b = await t.hydrate(t.b); expect(await read).toMatchObject({ status: 409 });
    const again = await t.hydrate(t.a); expect(t.service.pid).toBe(pid); expect(again.project_id).toBe(a.project_id);
    expect(new Set([a.context_id, b.context_id, again.context_id]).size).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.sent.filter((entry) => entry[0] === 'gren:event:repoWiki://progress')).toHaveLength(0);
    await expect(t.call(a, 'project', { project_id: a.project_id })).rejects.toMatchObject({ status: 409 });
  });
  it('resolves and fixes a model lease only for generation and keeps PID across model changes', async () => {
    const t = await setup(), a = await t.hydrate(), pid = t.service.pid;
    expect(t.resolveModel).not.toHaveBeenCalled();
    await expect(t.call(a, 'generate', { project_id: a.project_id, confirm_external: true })).resolves.toMatchObject({ status: 'system/source/123/false' });
    expect(t.resolveModel).toHaveBeenLastCalledWith(t.a);
    const first = JSON.parse(await readFile(join(t.root, 'data', 'generation-input.json'), 'utf8'));
    expect(first.scope.modelCacheKey).toBe('provider/model:v1'); expect(first.input.provider).toBe('real');
    t.setKey('provider/model:v2'); await t.service.refreshConfiguration();
    await t.call(a, 'generate', { project_id: a.project_id, confirm_external: true });
    const next = JSON.parse(await readFile(join(t.root, 'data', 'generation-input.json'), 'utf8'));
    expect(next.scope.modelCacheKey).toBe('provider/model:v2'); expect(next.scope.modelLeaseId).not.toBe(first.scope.modelLeaseId); expect(t.service.pid).toBe(pid);
  });
  it('cancels in-flight model work on context switch without restarting the process', async () => {
    const t = await setup(); t.setRoots([t.a, t.b]); const a = await t.hydrate(), pid = t.service.pid; let signal: AbortSignal | undefined;
    t.setComplete((_input, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const generation = t.call(a, 'generate', { project_id: a.project_id, confirm_external: true }).catch((error) => error);
    await vi.waitFor(() => expect(signal).toBeDefined()); await t.activate(t.b);
    expect(signal?.aborted).toBe(true); expect(await generation).toMatchObject({ status: 409 }); expect(t.service.pid).toBe(pid);
  });
  it('lets cancel and run bypass model preparation and accepts a fresh retry afterwards', async () => {
    const t = await setup(), a = await t.hydrate(); let signal: AbortSignal | undefined;
    t.setComplete((_input, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const generation = t.call(a, 'generate', { project_id: a.project_id, confirm_external: true }); await vi.waitFor(() => expect(signal).toBeDefined());
    expect((await t.call(a, 'run', { project_id: a.project_id })).status).toBe('running');
    await t.call(a, 'cancel', { project_id: a.project_id }); await generation; expect(signal?.aborted).toBe(true); expect(t.resolveModel).toHaveBeenCalledTimes(1);
    t.setComplete(async () => 'retry'); await expect(t.call(a, 'generate', { project_id: a.project_id, confirm_external: true })).resolves.toMatchObject({ status: 'retry' });
  });
  it('releases only its expected context and leaves a newer workspace untouched', async () => {
    const t = await setup(); t.setRoots([t.a, t.b]); const a = await t.hydrate(), pid = t.service.pid, b = await t.hydrate(t.b);
    expect(await t.call(a, 'release')).toEqual({ released: false });
    expect((await t.call(b, 'project', { project_id: b.project_id })).id).toBe(b.project_id);
    expect(await t.call(b, 'release')).toEqual({ released: true }); expect(t.service.pid).toBe(pid);
    await expect(t.call(b, 'project', { project_id: b.project_id })).rejects.toMatchObject({ status: 409 });
  });
  it('keeps a remounted view alive when the old same-path activation reply and release arrive late', async () => {
    const t = await setup();
    let deliver!: () => void;
    const firstHostReply = await t.raw('activate', { workspace: t.a, view_id: 'old-panel' });
    const delayedReply = new Promise<any>((resolve) => { deliver = () => resolve(firstHostReply); });
    // The old renderer has unmounted before its reply is exposed to it.
    await new Promise((resolve) => setImmediate(resolve));
    const next = await t.raw('activate', { workspace: t.a, view_id: 'new-panel' });
    const project = (await t.call(next, 'hydrate')).project;
    deliver();
    const old = await delayedReply;
    expect(next.context_id).not.toBe(old.context_id);
    expect(await t.call(old, 'release')).toEqual({ released: false });
    expect((await t.call(next, 'project', { project_id: project.id })).id).toBe(project.id);
    expect((await t.raw('activate', { workspace: t.a, view_id: 'new-panel' })).context_id).toBe(next.context_id);
  });
  it('cancels an old view model lease on same-path ownership transfer while preserving child PID', async () => {
    const t = await setup();
    const old = await t.raw('activate', { workspace: t.a, view_id: 'old-panel' });
    const project = (await t.call(old, 'hydrate')).project, pid = t.service.pid;
    let signal: AbortSignal | undefined;
    t.setComplete((_input, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const generation = t.call(old, 'generate', { project_id: project.id, confirm_external: true }).catch((error) => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const next = await t.raw('activate', { workspace: t.a, view_id: 'new-panel' });
    expect(signal?.aborted).toBe(true); expect(await generation).toMatchObject({ status: 409 });
    expect(t.service.pid).toBe(pid);
    const en = await t.raw('activate', { workspace: t.a, view_id: 'new-panel', language: 'en' });
    const refreshed = await t.raw('activate', { workspace: t.a, view_id: 'new-panel' });
    expect(refreshed.context_id).toBe(en.context_id); expect(refreshed.language).toBe('en');
    expect(next.context_id).not.toBe(old.context_id);
  });
  it('does not let a delayed terminal event from another run release the current model lease', async () => {
    const t = await setup(), a = await t.hydrate(); let signal: AbortSignal | undefined;
    t.setComplete((_input, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const generation = t.call(a, 'generate', { project_id: a.project_id, confirm_external: true });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await t.call(a, 'watch', { project_id: a.project_id, enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signal?.aborted).toBe(false);
    await t.call(a, 'cancel', { project_id: a.project_id }); await generation;
  });
  it('rejects foreign windows, subframes, navigation changes and unconfirmed/demo generation', async () => {
    const t = await setup();
    for (const event of [{ sender: { ...t.contents, id: 2 }, senderFrame: t.frame }, { sender: t.contents, senderFrame: { ...t.frame, parent: t.frame } }, { sender: t.contents, senderFrame: { ...t.frame } }])
      await expect(t.raw('activate', { workspace: t.a }, event)).rejects.toMatchObject({ status: 403 });
    expect(t.service.pid).toBeUndefined(); const a = await t.hydrate();
    await expect(t.call(a, 'generate', { project_id: a.project_id, provider: 'demo', confirm_external: true })).rejects.toMatchObject({ status: 403 });
    await expect(t.call(a, 'generate', { project_id: a.project_id })).rejects.toMatchObject({ status: 403 });
    await expect(t.call(a, 'clone', { url: 'https://example.com/repo.git' })).rejects.toMatchObject({ status: 403 });
    t.frame.url = 'https://untrusted.example/'; await expect(t.call(a, 'project', { project_id: a.project_id })).rejects.toMatchObject({ status: 403 });
  });
  it('revokes project access and stops the old child after authoritative root removal or registry failure', async () => {
    const t = await setup(), a = await t.hydrate(); t.setRoots([]); await t.service.onHostProjectsChanged();
    expect(t.service.pid).toBeUndefined(); await expect(t.call(a, 'project', { project_id: a.project_id })).rejects.toMatchObject({ status: 409 });
    t.setRoots([t.a]); await t.hydrate(); t.failRoots(); await expect(t.service.refreshConfiguration()).rejects.toThrow('project registry unavailable');
    expect(t.service.pid).toBeUndefined(); expect((await t.raw('hostProjects')).state).toBe('error');
  });
  it('keeps reading without a configured model and rejects generation before provider work', async () => {
    const t = await setup(); t.setAvailable(false); const a = await t.hydrate();
    expect((await t.call(a, 'project', { project_id: a.project_id })).id).toBe(a.project_id); expect(t.resolveModel).not.toHaveBeenCalled();
    await expect(t.call(a, 'generate', { project_id: a.project_id, confirm_external: true })).rejects.toMatchObject({ status: 503 });
  });
  it('does not replay a crashed mutation and rotates authority on physical child recovery', async () => {
    const t = await setup(), a = await t.hydrate(), pid = t.service.pid;
    await expect(t.call(a, 'edit', { project_id: a.project_id, slug: 'page', markdown: 'changed', expected_revision: 1 })).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(t.service.pid).not.toBe(pid));
    const recovered = await t.hydrate(); expect(recovered.context_id).not.toBe(a.context_id);
    expect(await readFile(join(t.root, 'data', 'mutations'), 'utf8')).toBe('edit\n');
  });
  it('waits for supervisor shutdown and disposes every registered command', async () => {
    const t = await setup(); await t.hydrate(); await t.service.stop();
    expect(await readFile(join(t.root, 'data', 'stopped'), 'utf8')).toMatch(/^\d+$/); expect(t.service.pid).toBeUndefined(); expect(t.commands.size).toBe(0);
  });
  it('uses stable non-secret cache identities that vary with provider/model/configuration', () => {
    const key = repoWikiModelCacheKey('provider', 'model', 'secret-configuration'); expect(key).toMatch(/^gren-repowiki:[a-f0-9]{64}$/); expect(key).not.toContain('secret');
    expect(repoWikiModelCacheKey('provider', 'model', 'other')).not.toBe(key); expect(repoWikiModelCacheKey('other', 'model', 'secret-configuration')).not.toBe(key);
  });
});

it('keeps sibling stage registration when another finishes and aborts on root revocation', async () => {
  let roots = ['approved'];
  const service = new RepoWikiService({ knowledge: {} as any, configurationPollMs: 0, allowedWorkspaces: async () => roots, projectSnapshot: () => roots, registerCommand: () => {}, resolveModel: async () => ({} as any), isTrustedSender: () => true } as any);
  const pending = new Map<string, (value: unknown) => void>();
  const aborted: string[] = []; let releaseAbort!: () => void; const heldAbort = new Promise<void>(resolve => releaseAbort=resolve);
  const client = { invokeKnowledge: async (method: string, value: any) => method === 'host.updateRoots' ? {} : new Promise(resolve => pending.set(value.itemId, resolve)), abortStage: async (value: any) => { aborted.push(value.taskId); await heldAbort; }, stop: async () => {} };
  (service as any).client = client; (service as any).clientRootsKey = JSON.stringify(['approved']);
  (service as any).knowledgeProject = async () => ({ projectId: 'p', workspace: 'approved', language: 'en' });
  (service as any).knowledgeHydrated.add('p');
  (service as any).ensureClient = async () => client;
  const fence = { ledgerId: 'l', controllerEpoch: 'e', ownerId: 'o', generation: 1 };
  const req = { taskId: 'task', fence, phase: 'generate', itemId: 'a', attempt: 1, key: { projectId: 'p' } };
  const a = service.invokeKnowledgeWorker('stage.execute', req);
  const b = service.invokeKnowledgeWorker('stage.execute', { ...req, itemId: 'b' });
  await vi.waitFor(() => expect(pending.size).toBe(2));
  pending.get('a')!({}); await a;
  roots = []; let revoked=false; const revoke=service.onHostProjectsChanged().then(()=>revoked=true);
  await vi.waitFor(()=>expect(aborted).toContain('task')); await Promise.resolve(); expect(revoked).toBe(false); releaseAbort(); await revoke;
  pending.get('b')!({}); await b; await service.stop();
});

it('does not dispatch a stage whose task was aborted while client startup was pending', async () => {
 const service=new RepoWikiService({knowledge:{} as any,configurationPollMs:0,allowedWorkspaces:async()=>['approved'],projectSnapshot:()=>['approved'],registerCommand:()=>{},resolveModel:async()=>({} as any),isTrustedSender:()=>true} as any);
 let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);let calls=0;const client={invokeKnowledge:async()=>{calls++;return {};},abortStage:async()=>{},stop:async()=>{}};
 (service as any).knowledgeProject=async()=>({projectId:'p',workspace:'approved',language:'en'});(service as any).knowledgeHydrated.add('p');(service as any).ensureClient=async()=>{await hold;return client;};
 const fence={ledgerId:'l',controllerEpoch:'e',ownerId:'o',generation:1};const pending=service.invokeKnowledgeWorker('stage.execute',{taskId:'t',fence,phase:'generate',itemId:'a',attempt:1,key:{projectId:'p'}});await Promise.resolve();await service.invokeKnowledgeWorker('stage.abort',{taskId:'t',fence});release();await expect(pending).rejects.toThrow('aborted');expect(calls).toBe(0);await service.stop();
});
