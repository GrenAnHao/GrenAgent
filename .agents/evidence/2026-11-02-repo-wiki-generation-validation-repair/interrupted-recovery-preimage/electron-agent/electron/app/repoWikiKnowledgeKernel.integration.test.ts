import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeBuildStore, hashKnowledgePayload } from '../agentData/knowledgeKernel/store';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../shared/knowledgeKernelContracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import { KnowledgeMessageBroker } from '../agent/knowledgeModelTurn';
import { createAgentDataModelPort } from '../agentData/createAgentDataModelPort';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { agentDataPipePath } from '../agentDataProcess/pipePath';
import { AgentDataService } from './agentDataService';
import { RepoWikiService, type RepoWikiHostContext } from './repoWikiService';
import { WorkspaceService } from './workspaceService';
import { createRepoWikiKnowledgeModelResolver } from './repoWikiKnowledgeModel';
import { agentDataOsPort, bounded, pause, until } from './repoWikiWorkflow.integration.fixture';
import { kernelFixtureProvider, PARALLEL_PAGE_IDS, inspectPublishedWiki } from './repoWikiKnowledgeKernel.integration.fixture';
import type { RepoWikiKnowledgeSnapshot } from '../../shared/knowledgeKernelContracts';
import type { Job } from '../agentData/jobStore';

const require = createRequire(import.meta.url);
let buildDir: string;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'knowledge-kernel-build-'));
  await Promise.all([buildRepoWikiHost(resolve('.'), buildDir), build({ absWorkingDir: resolve('.'), entryPoints: ['scripts/fixtures/repoWikiWorkflowAgentDataHost.ts'], outfile: join(buildDir, 'kernel-agentdata.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' })]);
}, 45000);
afterAll(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

async function workflowFixture(scenario: string, options: { parallel?: boolean; concurrency?: number; validationLinks?: boolean; safeUnknown?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-kernel-e2e-')); const projectPath = join(root, 'repository'); await mkdir(projectPath);
  const lines: string[] = []; const log = (line: string) => { lines.push(line); if (!line.startsWith('private ')) console.info(line); };
  const provider = await kernelFixtureProvider(log, options); const apps: Array<{ close(): Promise<void> }> = [];
  await writeFile(join(projectPath, 'README.md'), '# Kernel fixture\nTwo independent modules.\n');
  await writeFile(join(projectPath, 'api.ts'), 'export const api = "stable";\n'); await writeFile(join(projectPath, 'lib.ts'), 'export const library = "original";\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectPath, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Kernel fixture', '-c', 'user.email=kernel@example.invalid', 'add', '.'], { cwd: projectPath, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Kernel fixture', '-c', 'user.email=kernel@example.invalid', 'commit', '-m', 'fixture'], { cwd: projectPath, windowsHide: true, stdio: 'pipe' });
  const modelsPath = join(root, 'models.json'), configPath = join(root, 'runtime-config.json'), dataPath = join(root, 'agent-data.db');
  const providerName = `kernel-${scenario}`;
  await writeFile(modelsPath, JSON.stringify({ providers: { [providerName]: { api: 'openai-completions', baseUrl: provider.baseUrl, apiKey: 'offline-fixture-key', models: [{ id: 'knowledge', name: 'Loopback knowledge', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 8192 }] } } }));
  await writeFile(configPath, JSON.stringify({ agentDataModel: `${providerName}/knowledge`, KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: String(options.concurrency ?? 1) }));
  const modelHost = new ModelRuntimeHost({ create: () => ModelRuntime.create({ modelsPath, authPath: join(root, 'auth.json'), allowModelNetwork: false }), resolveSettings: async () => ({ provider: providerName, modelId: 'knowledge' }) });
  const model = createAgentDataModelPort(modelHost, () => JSON.parse(readFileSync(configPath, 'utf8')).agentDataModel, () => readFile(modelsPath, 'utf8'));
  const workspace = new WorkspaceService(join(root, 'host-workspaces')); await workspace.ensureWorkspace(projectPath);
  const stages: Array<{ event: 'start' | 'end'; phase: string; itemId: string; at: number }> = [];
  const openApp = async () => {
    let wiki!: RepoWikiService; const aborts = new Map<string, AbortController>();
    const broker = new KnowledgeMessageBroker({ bind: () => model.bindKnowledgeModel(), request: (binding, transcript, options) => model.requestKnowledgeMessage(binding, transcript, options), drainWorkers: epoch => wiki.drainKnowledgeWorker(epoch) });
    let osHost!: ReturnType<typeof agentDataOsPort>;
    const agentData = new AgentDataService({ mode: 'child', listenPath: agentDataPipePath(), createProcess: launchState => {
      osHost = agentDataOsPort({ entry: join(buildDir, 'kernel-agentdata.cjs'), executable: require('electron'), dataPath, configPath, launchState, model, log, knowledgeKernelVersion: 1,
        mainMethod: async (name, params: any) => {
          if (name === 'knowledge.bindEpoch') return broker.bindEpoch(params.epoch);
          if (name === 'knowledge.activateEpoch') { wiki.setKnowledgeEpoch(params.epoch); return broker.activateEpoch(params.epoch); }
          if (name === 'knowledge.bindModel') return broker.bind(params.taskId);
          if (name === 'knowledge.ackUsage') return broker.ackUsage(params.requestId);
          if (name === 'knowledge.abort') { aborts.get(params.requestId)?.abort(); return null; }
          if (name === 'knowledge.message') { const controller = new AbortController(); aborts.set(params.input.requestId, controller); try { return await broker.request(params.input, controller.signal); } finally { aborts.delete(params.input.requestId); } }
          if (name === 'knowledge.worker') {
            if (params.method !== 'stage.execute') return wiki.invokeKnowledgeWorker(params.method, params.input);
            const scope = { phase: String(params.input.phase), itemId: String(params.input.itemId) };
            stages.push({ event: 'start', ...scope, at: Date.now() }); log(`stage start ${scope.phase}/${scope.itemId}`);
            try { return await wiki.invokeKnowledgeWorker(params.method, params.input); }
            finally { stages.push({ event: 'end', ...scope, at: Date.now() }); log(`stage end ${scope.phase}/${scope.itemId}`); }
          }
          if (name === 'knowledge.changed') { wiki.publishKnowledgeSnapshot(params.snapshot); log(`changed task=${params.snapshot?.run?.taskId} state=${params.snapshot?.run?.state} phase=${params.snapshot?.run?.phase} error=${JSON.stringify(params.snapshot?.run?.error)}`); return null; }
          if (name === 'repoWiki.run') return wiki.runTask(params);
          if (name === 'repoWiki.cancel') return wiki.cancelTask(params);
          throw new Error(`Unexpected main method ${name}`);
        } }); return osHost.port;
    } });
    const commands = new Map<string, (event: any, args: any) => Promise<any>>(); const events: unknown[] = [];
    const sender = { id: 912, isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) };
    wiki = new RepoWikiService({ entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'repo-wiki'), tasks: agentData, knowledge: agentData,
      configurationPollMs: 0, processOptions: { executable: require('electron'), maxRestarts: 0, requestTimeoutMs: 15000, stopTimeoutMs: 2500 },
      registerCommand: (name: string, handler: any) => { commands.set(name, handler); return () => { commands.delete(name); }; }, isTrustedSender: (event: any) => event.sender === sender,
      allowedWorkspaces: () => workspace.readProjectSnapshot(), projectSnapshot: () => workspace.getProjectSnapshot(), resolveModel: createRepoWikiKnowledgeModelResolver(agentData, model.configurationIdentity), onError: (error: unknown) => log(`wiki: ${String(error)}`),
    });
    await bounded(agentData.start(), 'kernel AgentData child startup', 20000);
    let context: RepoWikiHostContext | undefined, closed = false, crashed = false;
    const call = (name: string, args: Record<string, unknown> = {}) => bounded(commands.get(`repoWiki_${name}`)!({ sender }, { ...(['activate','hostProjects'].includes(name) ? {} : { __repoWikiContext: context?.context_id }), ...args }), `kernel ${name}`, 25000);
    const enter = async () => { context = await call('activate', { workspace: projectPath, view_id: 'kernel-fixture' }); const hydrated = await call('hydrate'); context = { ...context!, project_id: hydrated.project.id }; log(`real children agentData=${osHost.pid} repoWiki=${wiki.pid} parent=${process.pid}`); return context; };
    const job = (id: string) => agentData.requestAdmin<Job>('admin.jobs.get', { id });
    const waitState = async (id: string, state: string) => { await until(async () => { const current = await job(id); if (current.state === state) return true; if (['completed','failed','blocked','cancelled'].includes(current.state)) throw new Error(`Unexpected task state while waiting for ${state}: ${JSON.stringify(current)}`); return false; }, `${id} ${state}`, 25000); return job(id); };
    const snapshot = (domain: 'wiki' | 'cards' = 'wiki') => call('knowledge', { project_id: context!.project_id, target: domain }) as Promise<RepoWikiKnowledgeSnapshot>;
    const start = async (intent: 'generate' | 'update' | 'regenerate' = 'generate', domain: 'wiki' | 'cards' = 'wiki') => { const preflight = await snapshot(domain); return call('generate', { project_id: context!.project_id, target: domain, provider: 'real', confirm_external: true, force: intent === 'regenerate', intent, request_id: crypto.randomUUID(), expected_model_identity: preflight.admission.modelIdentity, expected_plan_token: preflight.admission.planToken }); };
    const action = async (action: 'pause' | 'resume' | 'cancel' | 'repair') => { const current = await snapshot(); return call('action', { project_id: context!.project_id, task_id: current.run!.taskId, action, expected_revision: current.run!.revision, request_id: crypto.randomUUID(), expected_plan_token: current.admission.planToken, ...(action === 'repair' ? { confirm_external: true, expected_model_identity: current.admission.modelIdentity } : {}) }) as Promise<RepoWikiKnowledgeSnapshot>; };
    const drafts = (taskId: string) => agentData.requestAdmin<{ items: Array<{ id: string }> }>('admin.knowledge.drafts', { taskId });
    const close = async () => { if (closed) return; closed = true; if (crashed) for (const controller of aborts.values()) controller.abort(); try { await bounded(agentData.stop(), 'kernel stop AgentData', 20000); } catch (error) { if (!crashed || !String(error).includes('AgentData fixture exited')) throw error; } finally { await bounded(wiki.stop(), 'kernel stop Repo Wiki', 10000); } };
    const killAgentData = () => { crashed = true; process.kill(osHost.pid!, 'SIGKILL'); };
    const app = { killAgentData, agentData, wiki, osHost, call, enter, job, waitState, snapshot, start, action, drafts, close }; apps.push(app); return app;
  };
  const close = async () => { for (const app of apps.reverse()) await app.close().catch(error => log(`cleanup ${error}`)); await provider.close();
    const buildItems = existsSync(dataPath) ? (() => { const db = new DatabaseSync(dataPath, { readOnly: true }); try { return db.prepare("SELECT task_id,phase,item_id,state,payload,error,evidence,dependencies,input_hash,output_hash,revision,attempt,updated_at FROM knowledge_build_items ORDER BY task_id,revision").all(); } finally { db.close(); } })() : [];
    const acknowledgements = buildItems.filter(item => item.state === 'prepared');
    await writeFile(join(tmpdir(), `knowledge-kernel-integration-${process.pid}-${scenario}.json`), JSON.stringify({ scenario, lines, stages, buildItems, acknowledgements, httpPeak: provider.peak, calls: provider.calls.map(({ phase, itemId, stageItemId, final, aborted, startedAt, endedAt }) => ({ phase, itemId, stageItemId, final, aborted, startedAt, endedAt })) }, null, 2)); await rm(root, { recursive: true, force: true }); };
  const ledger = (taskId: string) => { const db = new DatabaseSync(dataPath, { readOnly: true }); try { return db.prepare('SELECT phase,item_id,state,payload,error,revision,attempt,updated_at FROM knowledge_build_items WHERE task_id=? ORDER BY revision').all(taskId) as Array<{ phase: string; item_id: string; state: string; payload: string | null; error: string | null; revision: number; attempt: number; updated_at: number }>; } finally { db.close(); } };
  return { root, projectPath, dataPath, provider, stages, ledger, openApp, close };
}

function stagePeak(stages: Array<{ event: 'start' | 'end'; phase: string }>, phase: string) {
  let active = 0, peak = 0;
  for (const stage of stages.filter(s => s.phase === phase)) { active += stage.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
  return peak;
}

it('uses two real children and the official tool loop, resumes one task from ACKs, then updates only the dirty module', async () => {
  const f = await workflowFixture('resume-incremental'); try {
    let app = await f.openApp(); const context = await app.enter(); expect(app.osHost.pid).not.toBe(process.pid); expect(app.wiki.pid).not.toBe(process.pid); expect(app.wiki.pid).not.toBe(app.osHost.pid);
    f.provider.hold(call => call.phase === 'generate' && call.itemId === 'library' && call.final);
    const started = await app.start(); const taskId = started.task_id; expect(taskId).toBeTruthy();
    await until(async () => { if (f.provider.calls.some(call => call.phase === 'generate' && call.itemId === 'library' && call.final && !call.settled)) return true; const job = await app.job(taskId); if (['blocked','failed','cancelled'].includes(job.state)) throw new Error(`Kernel stopped before expected provider hold: ${JSON.stringify(job)}`); return false; }, 'library held after api ACK', 25000);
    const heldSnapshot = await app.snapshot(); expect(heldSnapshot.content).toMatchObject({ publishedCount: 0, preparedCount: 1 }); expect(heldSnapshot.run?.currentItem).toContain('Library');
    const acknowledgedCalls = f.provider.calls.filter(call => call.itemId !== 'library' || call.phase !== 'generate').map(call => `${call.phase}/${call.itemId}/${call.final}`);
    await app.call('release'); await pause(100); expect(f.provider.calls.at(-1)!.aborted).toBe(false);
    await app.close(); f.provider.hold(() => false); app = await f.openApp();
    await app.waitState(taskId, 'completed');
    expect(f.provider.calls.filter(call => call.itemId !== 'library' || call.phase !== 'generate').map(call => `${call.phase}/${call.itemId}/${call.final}`).filter(label => !label.startsWith('validate/'))).toEqual(acknowledgedCalls);
    expect((await app.job(taskId)).metadata?.repoWiki?.counts.published).toBe(2);
    const publishedFiles = await readdir(join(f.projectPath, 'docs', 'repo-wiki'), { recursive: true });
    expect(publishedFiles.some(path => path.endsWith('api.md'))).toBe(true); expect(publishedFiles.some(path => path.endsWith('library.md'))).toBe(true);
    await app.enter(); expect((await app.snapshot()).run?.taskId).toBe(taskId);
    const oldLibrary = await app.call('page', { project_id: context.project_id, slug: 'library' });
    const before = f.provider.calls.length; await writeFile(join(f.projectPath, 'lib.ts'), 'export const library = "dirty-new";\n');
    f.provider.hold(call => call.phase === 'generate' && call.itemId === 'library' && call.final);
    const updated = await app.start('update'); await until(() => f.provider.calls.slice(before).some(call => call.phase === 'generate' && call.final && !call.settled), 'incremental library waits while official remains readable', 25000);
    expect(await app.call('page', { project_id: context.project_id, slug: 'library' })).toMatchObject({ markdown: oldLibrary.markdown, revision: oldLibrary.revision, storage_token: oldLibrary.storage_token });
    f.provider.calls.findLast(call => !call.settled)!.release(); await app.waitState(updated.task_id, 'completed');
    expect(f.provider.calls.slice(before).filter(call => call.phase === 'generate' && call.final).map(call => call.itemId)).toEqual(['library']);
    expect((await app.call('page', { project_id: context.project_id, slug: 'api' })).markdown).toContain('Verified api.ts');
  } finally { await f.close(); }
}, 100000);

it('retains official content through partial failure, repairs only failed work, and confirms pause/cancel by aborting HTTP', async () => {
  const f = await workflowFixture('partial-repair-controls'); try {
    let app = await f.openApp(); const context = await app.enter(); const initial = await app.start(); await app.waitState(initial.task_id, 'completed'); const published = await inspectPublishedWiki(f.projectPath, (await app.snapshot()).key.language);
    const apiFile = join(f.projectPath, 'docs', 'repo-wiki', (await app.snapshot()).key.language, 'namespaces', published.receipt.namespace, 'pages', 'api.md');
    await writeFile(apiFile, `${await readFile(apiFile, 'utf8')}\n<!-- authored note: preserve me -->\n`);
    const original = await app.call('page', { project_id: context.project_id, slug: 'api' });
    let failures = 0; f.provider.fail(call => call.phase === 'generate' && call.itemId === 'library' && failures++ < 2);
    const failed = await app.start('regenerate'); await app.waitState(failed.task_id, 'failed'); expect(failures).toBe(2); expect((await app.job(failed.task_id)).metadata?.repoWiki?.outcome).toBe('partial'); expect((await app.snapshot()).content.publishedCount).toBe(2); expect(await app.call('page', { project_id: context.project_id, slug: 'api' })).toMatchObject({ markdown: original.markdown, revision: original.revision, storage_token: original.storage_token });
    f.provider.fail(() => false); const beforeRepair = f.provider.calls.length; const repair = await app.action('repair'); expect(repair.run!.taskId).not.toBe(failed.task_id); await app.waitState(repair.run!.taskId, 'completed');
    expect(f.provider.calls.slice(beforeRepair).filter(call => call.phase === 'generate' && call.final).map(call => call.itemId)).toEqual(['library']);
    expect((await app.call('page', { project_id: context.project_id, slug: 'api' })).markdown).toContain('<!-- authored note: preserve me -->');
    expect(await readFile(apiFile, 'utf8')).toContain('<!-- authored note: preserve me -->');
    f.provider.hold(call => call.phase === 'generate' && call.final); const paused = await app.start('regenerate'); await until(() => f.provider.calls.some(call => call.final && !call.settled), 'manual pause HTTP hold', 25000); const held = f.provider.calls.findLast(call => !call.settled)!;
    await app.action('pause'); await app.waitState(paused.task_id, 'paused'); await until(() => held.aborted, 'manual pause actual HTTP abort'); await app.close(); const pausedCount = f.provider.calls.length; app = await f.openApp(); await pause(400); expect(f.provider.calls).toHaveLength(pausedCount); expect((await app.job(paused.task_id)).state).toBe('paused');
    await app.enter(); await app.action('cancel'); await app.waitState(paused.task_id, 'cancelled');
    const cancelled = await app.start('regenerate'); await until(() => f.provider.calls.some(call => !call.settled), 'explicit cancel HTTP hold', 25000); const cancelledHttp = f.provider.calls.findLast(call => !call.settled)!; await app.action('cancel'); await app.waitState(cancelled.task_id, 'cancelled'); await until(() => cancelledHttp.aborted, 'cancel actual HTTP abort');
  } finally { await f.close(); }
}, 120000);

it('publishes real module/repository Cards and relations under the existing cards ID namespace', async () => {
  const f = await workflowFixture('cards'); try { const app = await f.openApp(); const context = await app.enter(); const started = await app.start('generate', 'cards'); await app.waitState(started.task_id, 'completed'); const snapshot = await app.snapshot('cards'); expect(snapshot.key.domain).toBe('cards'); expect(snapshot.content.publishedCount).toBe(3); expect((await app.snapshot('wiki')).content.publishedCount).toBe(0); const project = await app.call('project', { project_id: context.project_id }); expect(project.cards.map((card: { id: string }) => card.id).sort()).toEqual(['cards/api','cards/library','cards/repository']); expect((await app.call('page', { project_id: context.project_id, slug: 'cards/api' })).markdown).toContain('Verified api.ts'); expect(f.provider.calls.some(call => call.phase === 'relations' && call.final)).toBe(true); } finally { await f.close(); }
}, 60000);


it('v2 keeps three page stages in flight and refills after an ACK without draining its siblings', async () => {
  const f = await workflowFixture('parallel-refill', { parallel: true, concurrency: 2 });
  try {
    const app = await f.openApp(); await app.enter();
    f.provider.hold(call => call.phase === 'generate');
    const started = await app.start();
    expect((await app.job(started.task_id)).metadata?.repoWiki?.executionPolicy?.version).toBe(2);
    await until(async () => { const job = await app.job(started.task_id); if (['failed','blocked','cancelled'].includes(job.state)) throw new Error(JSON.stringify(job.metadata?.repoWiki)); return f.stages.filter(s => s.event === 'start' && s.phase === 'generate').length === 3; }, 'three independent page stages', 25000);
    await until(() => f.provider.active === 2, 'two model HTTP slots');
    const held = (id: string, final: boolean) => f.provider.calls.find(c => c.phase === 'generate' && c.itemId === id && c.final === final && !c.settled);
    await until(() => !!held('a', false) && !!held('b', false), 'A/B first requests');
    held('a', false)!.release();
    await until(() => !!held('c', false), 'C acquires freed HTTP slot'); held('c', false)!.release();
    await until(() => !!held('a', true), 'A final answer'); held('a', true)!.release();
    await until(async () => (await app.drafts(started.task_id)).items.some(i => i.id === 'generate:a'), 'A durable ACK');
    await until(() => f.stages.some(s => s.event === 'start' && s.itemId === 'generate:e'), 'E refills A stage slot');
    expect(held('b', false)?.settled).toBe(false);
    expect(f.stages.some(s => s.event === 'end' && s.itemId === 'generate:c')).toBe(false);
    expect(f.stages.some(s => s.event === 'start' && s.itemId === 'generate:z-after-chain')).toBe(false);
    await until(() => !!held('c', true), 'C final response before B'); held('c', true)!.release();
    await until(async () => (await app.drafts(started.task_id)).items.some(i => i.id === 'generate:c'), 'C out-of-order durable ACK');
    expect((await app.drafts(started.task_id)).items.some(i => i.id === 'generate:b')).toBe(false);
    f.provider.hold(() => false); for (const call of f.provider.calls) if (!call.settled) call.release();
    await app.waitState(started.task_id, 'completed');
    expect(f.provider.peak).toBe(2); expect(f.provider.active).toBe(0); expect(stagePeak(f.stages, 'generate')).toBe(3);
    expect((await app.snapshot()).content.publishedCount).toBe(PARALLEL_PAGE_IDS.length);
    const publication = await inspectPublishedWiki(f.projectPath, (await app.snapshot()).key.language);
    expect(publication.pageIds).toEqual([...PARALLEL_PAGE_IDS].sort());
    expect(publication.receipt.taskId).toBe(started.task_id);
    const language = (await app.snapshot()).key.language;
    const pageFile = join(f.projectPath, 'docs', 'repo-wiki', language, 'namespaces', publication.receipt.namespace, 'pages', 'a.md');
    const markdown = await readFile(pageFile, 'utf8');
    await writeFile(pageFile, ''); await expect(inspectPublishedWiki(f.projectPath, language)).rejects.toThrow(/Empty formal Markdown/);
    await rm(pageFile); await expect(inspectPublishedWiki(f.projectPath, language)).rejects.toThrow();
    await writeFile(pageFile, markdown);
    const acknowledgements = f.ledger(started.task_id).filter(i => i.phase === 'generate');
    expect(acknowledgements.find(i => i.item_id === 'generate:c')!.revision).toBeLessThan(acknowledgements.find(i => i.item_id === 'generate:b')!.revision);
    for (const [child, parent] of [['z-after-a', 'a'], ['z-after-chain', 'z-after-a']]) {
      expect(f.stages.find(s => s.event === 'start' && s.itemId === `generate:${child}`)!.at).toBeGreaterThanOrEqual(acknowledgements.find(i => i.item_id === `generate:${parent}`)!.updated_at);
    }
  } finally { await f.close(); }
}, 100000);


it.each([1, 2])('keeps the shared HTTP limit at %i while three v2 stages are active and drains every sibling on cancel', async concurrency => {
  const f = await workflowFixture(`parallel-global-${concurrency}-cancel`, { parallel: true, concurrency });
  try {
    const app = await f.openApp(); await app.enter(); f.provider.hold(c => c.phase === 'generate');
    const started = await app.start();
    await until(() => f.stages.filter(s => s.event === 'start' && s.phase === 'generate').length === 3, 'three stages with one HTTP slot');
    await until(() => f.provider.active === concurrency, 'held HTTP slots');
    const starts = f.stages.filter(s => s.event === 'start' && s.phase === 'generate');
    await app.action('cancel'); await app.waitState(started.task_id, 'cancelled');
    await until(() => f.provider.active === 0, 'all provider requests drained');
    expect(f.provider.peak).toBe(concurrency); expect(stagePeak(f.stages, 'generate')).toBe(3);
    for (const stage of starts) expect(f.stages.some(s => s.event === 'end' && s.itemId === stage.itemId)).toBe(true);
    expect(f.provider.calls.filter(c => c.phase === 'generate').every(c => c.aborted)).toBe(true);
    const count = f.provider.calls.length; await pause(150); expect(f.provider.calls).toHaveLength(count);
    expect((await app.snapshot()).content.publishedCount).toBe(0);
  } finally { await f.close(); }
}, 60000);

it('recovers a strongly killed AgentData child without dispatching ACKed pages twice', async () => {
  const f = await workflowFixture('parallel-crash-recovery', { parallel: true, concurrency: 2 });
  try {
    let app = await f.openApp(); await app.enter();
    f.provider.hold(c => c.phase === 'generate');
    const started = await app.start();
    const held = (id: string, final: boolean) => f.provider.calls.find(c => c.phase === 'generate' && c.itemId === id && c.final === final && !c.settled);
    await until(() => !!held('a', false) && !!held('b', false), 'A/B HTTP before crash', 25000); held('a', false)!.release();
    await until(() => !!held('c', false), 'C HTTP before crash'); held('c', false)!.release();
    await until(() => !!held('a', true), 'A final before crash'); held('a', true)!.release();
    await until(async () => (await app.drafts(started.task_id)).items.some(i => i.id === 'generate:a'), 'A ACK before forced exit');
    await until(() => f.provider.active === 2, 'both sibling HTTP requests in flight');
    const callsBefore = f.provider.calls.filter(c => c.itemId === 'a' && c.phase === 'generate').length;
    const firstPid = app.osHost.pid!; app.killAgentData();
    await until(() => { try { process.kill(firstPid, 0); return false; } catch { return true; } }, 'actual AgentData OS child exit');
    await app.close(); await until(() => f.provider.active === 0, 'old epoch HTTP drain');
    f.provider.hold(() => false); app = await f.openApp(); expect(app.osHost.pid).not.toBe(firstPid);
    await app.waitState(started.task_id, 'completed'); await app.enter();
    expect(f.provider.calls.filter(c => c.itemId === 'a' && c.phase === 'generate')).toHaveLength(callsBefore);
    expect((await inspectPublishedWiki(f.projectPath, (await app.snapshot()).key.language)).pageIds).toEqual([...PARALLEL_PAGE_IDS].sort());
  } finally { await f.close(); }
}, 100000);

it('continues a frozen v1 task with its old budgets and serial graph after startup', async () => {
  const f = await workflowFixture('legacy-v1-recovery');
  try {
    let app = await f.openApp(); await app.enter(); const preflight = await app.snapshot(); await app.close();
    const db = new DatabaseSync(f.dataPath); let taskId: string;
    const budgets = structuredClone(DEFAULT_KNOWLEDGE_BUDGETS); budgets.unit.maxOutputTokens = 4096;
    try {
      const store = new KnowledgeBuildStore(db, { controllerEpoch: 'legacy-seed' });
      taskId = store.createTask({ workspace: f.projectPath, key: preflight.key, pipelineConfigHash: 'knowledge-kernel-v1', budgets,
        request: { version: 1, requestId: crypto.randomUUID(), projectId: preflight.key.projectId, domain: 'wiki', language: preflight.key.language, intent: 'generate', confirmExternal: true, expectedModelIdentity: preflight.admission.modelIdentity!, expectedPlanToken: preflight.admission.planToken! } }).id;
    } finally { db.close(); }
    app = await f.openApp(); await app.waitState(taskId, 'completed'); await app.enter();
    const metadata = (await app.job(taskId)).metadata!.repoWiki!;
    expect(metadata.executionPolicy).toBeUndefined(); expect(metadata.budgets).toEqual(budgets);
    expect(metadata.pipelineConfigHash).toBe('knowledge-kernel-v1');
    expect(f.ledger(taskId).some(i => i.phase === 'readme')).toBe(false);
    expect(stagePeak(f.stages, 'generate')).toBe(1);
    expect((await inspectPublishedWiki(f.projectPath, metadata.key.language)).pageIds).toEqual(['api', 'library']);
  } finally { await f.close(); }
}, 60000);


it('overlaps three independent catalogue stages and keeps the local completion barrier ahead of pages', async () => {
  const f = await workflowFixture('parallel-catalogue', { parallel: true, concurrency: 2 });
  try {
    const app = await f.openApp(); await app.enter();
    f.provider.hold(c => c.phase === 'catalogue' && c.stageItemId.startsWith('catalogue:item:'));
    const started = await app.start();
    await until(() => f.stages.filter(s => s.event === 'start' && s.phase === 'catalogue' && s.itemId.startsWith('catalogue:item:')).length === 3, 'three catalogue stages in one independent layer');
    await until(() => f.provider.active === 2, 'catalogue uses two global HTTP slots');
    expect(f.stages.some(s => s.phase === 'generate')).toBe(false);
    expect(f.ledger(started.task_id).some(i => i.item_id === 'catalogue:complete' && i.state === 'prepared')).toBe(false);
    f.provider.hold(() => false); for (const call of f.provider.calls) if (!call.settled) call.release();
    await app.waitState(started.task_id, 'completed');
    const completion = f.ledger(started.task_id).find(i => i.item_id === 'catalogue:complete');
    expect(completion?.state).toBe('prepared');
    for (const stage of f.stages.filter(s => s.event === 'start' && s.phase === 'generate')) expect(stage.at).toBeGreaterThanOrEqual(completion!.updated_at);
    expect(f.provider.calls.some(c => c.stageItemId === 'catalogue:complete')).toBe(false);
    expect(f.provider.peak).toBe(2); expect(stagePeak(f.stages, 'catalogue')).toBe(3);
    expect((await inspectPublishedWiki(f.projectPath, (await app.snapshot()).key.language)).pageIds).toEqual([...PARALLEL_PAGE_IDS].sort());
  } finally { await f.close(); }
}, 100000);


async function startValidationVersion(f: Awaited<ReturnType<typeof workflowFixture>>, version: number) {
  let app = await f.openApp(); await app.enter(); let taskId: string;
  if (version === 1) {
    const preflight = await app.snapshot(); await app.close(); const db = new DatabaseSync(f.dataPath);
    try {
      taskId = new KnowledgeBuildStore(db, { controllerEpoch: 'legacy-validation-seed' }).createTask({ workspace: f.projectPath, key: preflight.key, pipelineConfigHash: 'knowledge-kernel-v1',
        request: { version: 1, requestId: crypto.randomUUID(), projectId: preflight.key.projectId, domain: 'wiki', language: preflight.key.language, intent: 'generate', confirmExternal: true, expectedModelIdentity: preflight.admission.modelIdentity!, expectedPlanToken: preflight.admission.planToken! } }).id;
    } finally { db.close(); }
    app = await f.openApp(); await app.enter();
  } else taskId = (await app.start()).task_id;
  return { app, taskId };
}

it('publishes safe unknown navigation as text and retains audit warning',async()=>{
 const f=await workflowFixture('safe-unknown',{validationLinks:true,safeUnknown:true});try{
  const app=await f.openApp();await app.enter();const run=await app.start();await app.waitState(run.task_id,'completed');const language=(await app.snapshot()).key.language;const before=f.provider.calls.length;await writeFile(join(f.projectPath,'lib.ts'),'export const library = \"unrelated change\";\n');const update=await app.start('update');await app.waitState(update.task_id,'completed');expect(f.provider.calls.slice(before).filter(c=>c.phase==='generate')).toEqual([]);await app.close();
  const publication=await inspectPublishedWiki(f.projectPath,language);expect(publication.pageIds).toEqual(['api','library']);const library=publication.pages.find(p=>p.id==='library')!;expect(library.markdown).toContain('Broken Wiki');expect(library.markdown).not.toContain('[Broken Wiki](missing-page.md)');expect(library.markdown).toContain('[not a real link](missing-fenced.md)');expect(library.inputManifest?.navigationWarnings).toEqual([{code:'UNKNOWN_WIKI_LINK',page:'library',target:'missing-page.md'}]);expect(library.sources).toContainEqual({path:'README.md',start_line:1,end_line:1});
 }finally{await f.close();}
},100000);

it.each([1, 2])('persists v%i validation failures and repairs only the bad page through two real children', async version => {
  const f = await workflowFixture(`validation-links-v${version}`, { validationLinks: true });
  try {
    const { app, taskId } = await startValidationVersion(f, version);
    await app.waitState(taskId, 'failed');
    const rows = f.ledger(taskId); const failed = rows.find(i => i.item_id === 'generate:library')!;
    expect(failed.state).toBe('failed'); expect(failed.payload).not.toBeNull();
    expect(failed.error).toContain('INVALID_PAGE_LINK'); expect(failed.error).toContain('missing-page.md');
    expect(rows.some(i => i.state === 'running')).toBe(false);
    expect(rows.find(i => i.item_id === 'generate:api')?.state).toBe('prepared');
    expect((await app.drafts(taskId)).items.map(i => i.id)).toEqual(['generate:api']);
    expect((await app.snapshot()).content).toMatchObject({ preparedCount: 1, publishedCount: 0 });
    const beforeRepair = f.provider.calls.length; f.provider.repairLinks(); const repair = await app.action('repair');
    expect(repair.run!.taskId).not.toBe(taskId); await app.waitState(repair.run!.taskId, 'completed');
    const metadata = (await app.job(repair.run!.taskId)).metadata!.repoWiki!;
    expect(metadata.executionPolicy?.version).toBe(version === 1 ? undefined : 2);
    expect(f.provider.calls.slice(beforeRepair).filter(c => c.phase === 'generate' && c.final).map(c => c.itemId)).toEqual(['library']);
    await app.close();
    const publication = await inspectPublishedWiki(f.projectPath, metadata.key.language);
    expect(publication.pageIds).toEqual(['api', 'library']); expect(publication.receipt.taskId).toBe(repair.run!.taskId);
    const library = publication.pages.find(p => p.id === 'library')!;
    expect(library.markdown).toContain('[Readme](source:README.md#L1-L1)');
    expect(library.markdown).toContain('[API page](api.md#api)');
    expect(library.markdown).toContain('[not a real link](missing-fenced.md)');
    expect(library.markdown).not.toContain('missing-page.md');
    expect(library.sources).toContainEqual({ path: 'README.md', start_line: 1, end_line: 1 });
  } finally { await f.close(); }
}, 100000);


it.each([1, 2])('locally revalidates a persisted v%i candidate from an older validator without new HTTP', async version => {
  const f = await workflowFixture(`candidate-revalidation-v${version}`, { validationLinks: true });
  try {
    const started = await startValidationVersion(f, version); let app = started.app; const taskId = started.taskId;
    await app.waitState(taskId, 'failed');
    const current = await app.snapshot();
    const project = await app.wiki.invokeKnowledgeWorker('project.read', { projectId: current.key.projectId, domain: 'wiki' }) as { scope: string; guardFloor: number };
    await app.close();
    // Historical fixture: the old validator rejected README/code examples, despite valid raw model output.
    // Preserve real evidence/dependencies and the frozen identity; only construct that prior failed candidate.
    const db = new DatabaseSync(f.dataPath);
    try {
      const store = new KnowledgeBuildStore(db, { controllerEpoch: 'previous-validator-fixture' });
      const candidate = store.readFailedCandidate({ taskId, phase: 'generate', itemId: 'generate:library' });
      const payload = structuredClone(candidate.payload) as { markdown: string; sources: unknown[] };
      payload.markdown = payload.markdown.replace('\n[Broken Wiki](../../missing-page.md)', '');
      const fence = store.claim(project.scope, taskId, 'previous-validator-fixture', project.guardFloor, { previousExecutorExited: true });
      const attempt = store.beginAttempt(taskId, 'generate', candidate.itemId, fence, candidate.inputHash, { stageKind: 'page' });
      store.commitItem({ version: 1, taskId, phase: 'generate', itemId: candidate.itemId, inputHash: candidate.inputHash, outputHash: hashKnowledgePayload(payload), payload,
        evidence: candidate.evidence, dependencies: candidate.dependencies, fence, stageAttempt: attempt, sequence: 1, disposition: 'failed',
        error: { code: 'INVALID_PAGE_LINK', message: 'Page library: invalid page link README.md#kernel-fixture', retriable: false } }, attempt);
      store.setState(taskId, fence, 'failed'); store.releaseLease(taskId, fence);
    } finally { db.close(); }
    app = await f.openApp(); await app.enter();
    const beforeRepair = f.provider.calls.length; const repair = await app.action('repair');
    await app.waitState(repair.run!.taskId, 'completed');
    expect(f.provider.calls.slice(beforeRepair)).toEqual([]);
    expect(f.ledger(taskId).find(i => i.item_id === 'generate:library')?.state).toBe('failed');
    expect(f.ledger(repair.run!.taskId).find(i => i.item_id === 'generate:library')?.state).toBe('prepared');
    await app.close();
    const publication = await inspectPublishedWiki(f.projectPath, current.key.language);
    expect(publication.pageIds).toEqual(['api', 'library']); expect(publication.receipt.taskId).toBe(repair.run!.taskId);
    expect(publication.pages.find(p => p.id === 'library')!.markdown).toContain('[Readme](source:README.md#L1-L1)');
    expect(publication.pages.find(p => p.id === 'library')!.markdown).not.toContain('missing-page.md');
    expect(publication.pages.find(p => p.id === 'library')!.sources).toContainEqual({ path: 'README.md', start_line: 1, end_line: 1 });
  } finally { await f.close(); }
}, 100000);


it.each([1, 2])('resumes a persisted v%i failed candidate locally without new HTTP', async version => {
  const f = await workflowFixture(`candidate-resume-v${version}`, { validationLinks: true });
  try {
    const started = await startValidationVersion(f, version); let app = started.app; const taskId = started.taskId;
    await app.waitState(taskId, 'failed');
    const current = await app.snapshot();
    const project = await app.wiki.invokeKnowledgeWorker('project.read', { projectId: current.key.projectId, domain: 'wiki' }) as { scope: string; guardFloor: number };
    await app.close();
    // Historical fixture: the old validator rejected README/code examples, despite valid raw model output.
    // Preserve real evidence/dependencies and the frozen identity; only construct that prior failed candidate.
    const db = new DatabaseSync(f.dataPath);
    try {
      const store = new KnowledgeBuildStore(db, { controllerEpoch: 'previous-validator-fixture' });
      const candidate = store.readFailedCandidate({ taskId, phase: 'generate', itemId: 'generate:library' });
      const payload = structuredClone(candidate.payload) as { markdown: string; sources: unknown[] };
      payload.markdown = payload.markdown.replace('\n[Broken Wiki](../../missing-page.md)', '');
      const fence = store.claim(project.scope, taskId, 'previous-validator-fixture', project.guardFloor, { previousExecutorExited: true });
      const attempt = store.beginAttempt(taskId, 'generate', candidate.itemId, fence, candidate.inputHash, { stageKind: 'page' });
      store.commitItem({ version: 1, taskId, phase: 'generate', itemId: candidate.itemId, inputHash: candidate.inputHash, outputHash: hashKnowledgePayload(payload), payload,
        evidence: candidate.evidence, dependencies: candidate.dependencies, fence, stageAttempt: attempt, sequence: 1, disposition: 'failed',
        error: { code: 'INVALID_PAGE_LINK', message: 'Page library: invalid page link README.md#kernel-fixture', retriable: false } }, attempt);
      store.setState(taskId, fence, 'paused'); store.releaseLease(taskId, fence);
    } finally { db.close(); }
    const priorAttempt=f.ledger(taskId).find(i=>i.item_id==='generate:library')!.attempt;
    app = await f.openApp(); await app.enter();
    const beforeRepair = f.provider.calls.length; const repair = await app.action('resume');
    await app.waitState(taskId, 'completed');
    expect(f.provider.calls.slice(beforeRepair)).toEqual([]);
    expect(f.ledger(taskId).find(i => i.item_id === 'generate:library')).toMatchObject({state:'prepared',attempt:priorAttempt});
    await app.close();
    const publication = await inspectPublishedWiki(f.projectPath, current.key.language);
    expect(publication.pageIds).toEqual(['api', 'library']); expect(publication.receipt.taskId).toBe(taskId);
    expect(publication.pages.find(p => p.id === 'library')!.markdown).toContain('[Readme](source:README.md#L1-L1)');
    expect(publication.pages.find(p => p.id === 'library')!.markdown).not.toContain('missing-page.md');
    expect(publication.pages.find(p => p.id === 'library')!.sources).toContainEqual({ path: 'README.md', start_line: 1, end_line: 1 });
  } finally { await f.close(); }
}, 100000);


it.each([1, 2])('publishes a persisted v%i legacy prepared page after normalization without new HTTP', async version => {
  const f = await workflowFixture(`legacy-prepared-v${version}`, { validationLinks: true });
  try {
    const started = await startValidationVersion(f, version); let app = started.app; const taskId = started.taskId;
    await app.waitState(taskId, 'failed');
    const current = await app.snapshot();
    const project = await app.wiki.invokeKnowledgeWorker('project.read', { projectId: current.key.projectId, domain: 'wiki' }) as { scope: string; guardFloor: number };
    await app.close();
    // Historical fixture: the old validator rejected README/code examples, despite valid raw model output.
    // Preserve real evidence/dependencies and the frozen identity; only construct that prior failed candidate.
    const db = new DatabaseSync(f.dataPath);
    try {
      const store = new KnowledgeBuildStore(db, { controllerEpoch: 'previous-validator-fixture' });
      const candidate = store.readFailedCandidate({ taskId, phase: 'generate', itemId: 'generate:library' });
      const payload = structuredClone(candidate.payload) as { markdown: string; sources: unknown[] };
      payload.markdown = payload.markdown.replace('\n[Broken Wiki](../../missing-page.md)', '\n[Broken Wiki](missing-page.md)');
      const fence = store.claim(project.scope, taskId, 'previous-validator-fixture', project.guardFloor, { previousExecutorExited: true });
      const attempt = store.beginAttempt(taskId, 'generate', candidate.itemId, fence, candidate.inputHash, { stageKind: 'page' });
      store.commitItem({ version: 1, taskId, phase: 'generate', itemId: candidate.itemId, inputHash: candidate.inputHash, outputHash: hashKnowledgePayload(payload), payload,
        evidence: candidate.evidence, dependencies: candidate.dependencies, fence, stageAttempt: attempt, sequence: 1, disposition: 'prepared' }, attempt);
      store.setState(taskId, fence, 'paused'); store.releaseLease(taskId, fence);
    } finally { db.close(); }
    const priorAttempt=f.ledger(taskId).find(i=>i.item_id==='generate:library')!.attempt;
    app = await f.openApp(); await app.enter();
    const beforeRepair = f.provider.calls.length; const repair = await app.action('resume');
    await app.waitState(taskId, 'completed');
    expect(f.provider.calls.slice(beforeRepair)).toEqual([]);
    expect(f.ledger(taskId).find(i => i.item_id === 'generate:library')).toMatchObject({state:'prepared',attempt:priorAttempt});
    await app.close();
    const publication = await inspectPublishedWiki(f.projectPath, current.key.language);
    expect(publication.pageIds).toEqual(['api', 'library']); expect(publication.receipt.taskId).toBe(taskId);
    expect(publication.pages.find(p => p.id === 'library')!.markdown).toContain('[Readme](source:README.md#L1-L1)');
    expect(publication.pages.find(p => p.id === 'library')!.markdown).not.toContain('[Broken Wiki](missing-page.md)');
    expect(publication.pages.find(p => p.id === 'library')!.inputManifest?.navigationWarnings).toEqual([{code:'UNKNOWN_WIKI_LINK',page:'library',target:'missing-page.md'}]);
    expect(publication.pages.find(p => p.id === 'library')!.inputManifest?.outputHash).toBe(JSON.parse(f.ledger(taskId).find(i=>i.item_id==='generate:library')!.payload!).markdown.includes('[Broken Wiki]') ? hashKnowledgePayload(JSON.parse(f.ledger(taskId).find(i=>i.item_id==='generate:library')!.payload!)) : 'unexpected');
    expect(publication.pages.find(p => p.id === 'library')!.sources).toContainEqual({ path: 'README.md', start_line: 1, end_line: 1 });
  } finally { await f.close(); }
}, 100000);
