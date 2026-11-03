/**
 * Real-model end-to-end run of the Repo Wiki knowledge kernel on an actual repository.
 * Opt-in only (costs real tokens):
 *   REPO_WIKI_REAL_E2E=<repo path> pnpm exec vitest run electron/app/repoWikiRealModel.e2e.test.ts
 * Optional: REPO_WIKI_REAL_PROVIDER / REPO_WIKI_REAL_MODEL (default: the configured agentDataModel),
 * REPO_WIKI_REAL_REPORT (JSON report path). Uses the same two real children as the kernel integration test.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
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
import { agentDataOsPort, bounded } from './repoWikiWorkflow.integration.fixture';
import type { RepoWikiKnowledgeSnapshot } from '../../shared/knowledgeKernelContracts';
import { inspectPublishedWiki } from './repoWikiKnowledgeKernel.integration.fixture';
import type { Job } from '../agentData/jobStore';

const source = process.env.REPO_WIKI_REAL_E2E;
const require = createRequire(import.meta.url);
let buildDir: string;
beforeAll(async () => {
  if (!source) return;
  buildDir = await mkdtemp(join(tmpdir(), 'repo-wiki-real-build-'));
  await Promise.all([buildRepoWikiHost(resolve('.'), buildDir), build({ absWorkingDir: resolve('.'), entryPoints: ['scripts/fixtures/repoWikiWorkflowAgentDataHost.ts'], outfile: join(buildDir, 'kernel-agentdata.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' })]);
}, 60000);
afterAll(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

it.skipIf(!source)('generates a full Wiki for a real repository with the real knowledge model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-wiki-real-')), projectPath = join(root, 'repository');
  const lines: string[] = []; const log = (line: string) => { lines.push(`${new Date().toISOString()} ${line}`); if (!/^private |^reverse /.test(line)) console.info(line); };
  // A local clone owned by this user, so the run never touches the source checkout.
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source!, projectPath], { windowsHide: true, stdio: 'pipe' });
  const agentDir = join(homedir(), '.pi', 'agent');
  const userConfig = JSON.parse(readFileSync(join(process.env.APPDATA ?? '', 'electron-agent', 'runtime-settings.json'), 'utf8'));
  const [providerName, modelId] = (process.env.REPO_WIKI_REAL_PROVIDER && process.env.REPO_WIKI_REAL_MODEL ? `${process.env.REPO_WIKI_REAL_PROVIDER}/${process.env.REPO_WIKI_REAL_MODEL}` : userConfig.agentDataModel as string).split(/\/(.*)/s);
  const modelsPath = join(agentDir, 'models.json'), configPath = join(root, 'runtime-config.json'), dataPath = join(root, 'agent-data.db');
  await writeFile(configPath, JSON.stringify({ agentDataModel: `${providerName}/${modelId}`, KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1' }));
  const modelHost = new ModelRuntimeHost({ create: () => ModelRuntime.create({ modelsPath, authPath: join(agentDir, 'auth.json') }), resolveSettings: async () => ({ provider: providerName, modelId }) });
  const model = createAgentDataModelPort(modelHost, () => JSON.parse(readFileSync(configPath, 'utf8')).agentDataModel, () => readFile(modelsPath, 'utf8'));
  const workspace = new WorkspaceService(join(root, 'host-workspaces')); await workspace.ensureWorkspace(projectPath);
  let wiki!: RepoWikiService; const aborts = new Map<string, AbortController>();
  const answers: Array<{ phase: string; itemId: string; text: string }> = [], calls: Array<{ phase: string; itemId: string; tools: unknown[] }> = [];
  const broker = new KnowledgeMessageBroker({ bind: () => model.bindKnowledgeModel(), request: (binding, transcript, options) => model.requestKnowledgeMessage(binding, transcript, options), drainWorkers: epoch => wiki.drainKnowledgeWorker(epoch) });
  let osHost!: ReturnType<typeof agentDataOsPort>;
  const agentData = new AgentDataService({ mode: 'child', listenPath: agentDataPipePath(), createProcess: launchState => {
    osHost = agentDataOsPort({ entry: join(buildDir, 'kernel-agentdata.cjs'), executable: require('electron'), dataPath, configPath, launchState, model, log, knowledgeKernelVersion: 1,
      // Production AgentProcessClient has no per-request bound; a real model turn can exceed 25s.
      requestTimeoutMs: 300_000,
      mainMethod: async (name, params: any) => {
        if (name === 'knowledge.bindEpoch') return broker.bindEpoch(params.epoch);
        if (name === 'knowledge.activateEpoch') { wiki.setKnowledgeEpoch(params.epoch); return broker.activateEpoch(params.epoch); }
        if (name === 'knowledge.bindModel') return broker.bind(params.taskId);
        if (name === 'knowledge.ackUsage') return broker.ackUsage(params.requestId);
        if (name === 'knowledge.abort') { aborts.get(params.requestId)?.abort(); return null; }
        if (name === 'knowledge.message') {
          const controller = new AbortController(); aborts.set(params.input.requestId, controller);
          const started = Date.now();
          try { const message = await broker.request(params.input, controller.signal); log(`model ${params.input.phase}/${params.input.itemId} stop=${message.stopReason} in=${message.usage?.input} cache=${message.usage?.cacheRead} out=${message.usage?.output} ${Date.now() - started}ms${message.errorMessage ? ` error=${message.errorMessage}` : ''}`);
            if (message.stopReason === 'stop') answers.push({ phase: params.input.phase, itemId: params.input.itemId, text: message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') });
            else calls.push({ phase: params.input.phase, itemId: params.input.itemId, tools: message.content.filter((part: any) => part.type === 'toolCall').map((part: any) => ({ name: part.name, args: part.arguments })) });
            return message; }
          finally { aborts.delete(params.input.requestId); }
        }
        if (name === 'knowledge.worker') return wiki.invokeKnowledgeWorker(params.method, params.input);
        if (name === 'knowledge.changed') { const run = params.snapshot?.run; if (run) log(`changed ${run.state} ${run.phase} ${run.currentItem ?? ''} prepared=${run.counts.prepared}/${run.counts.planned} failed=${run.counts.failed}`); wiki.publishKnowledgeSnapshot(params.snapshot); return null; }
        throw new Error(`Unexpected main method ${name}`);
      } }); return osHost.port;
  } });
  const commands = new Map<string, (event: any, args: any) => Promise<any>>();
  const sender = { id: 913, isDestroyed: () => false, send: () => {} };
  wiki = new RepoWikiService({ entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'repo-wiki'), tasks: agentData, knowledge: agentData,
    configurationPollMs: 0, processOptions: { executable: require('electron'), maxRestarts: 0, requestTimeoutMs: 60000, stopTimeoutMs: 2500 },
    registerCommand: (name: string, handler: any) => { commands.set(name, handler); return () => { commands.delete(name); }; }, isTrustedSender: (event: any) => event.sender === sender,
    allowedWorkspaces: () => workspace.readProjectSnapshot(), projectSnapshot: () => workspace.getProjectSnapshot(), resolveModel: createRepoWikiKnowledgeModelResolver(agentData, model.configurationIdentity), onError: (error: unknown) => log(`wiki: ${String(error)}`) } as any);
  const report: Record<string, unknown> = { source, model: `${providerName}/${modelId}`, answers, calls };
  try {
    await bounded(agentData.start(), 'AgentData child startup', 30000);
    let context: RepoWikiHostContext | undefined;
    const call = (name: string, args: Record<string, unknown> = {}) => bounded(commands.get(`repoWiki_${name}`)!({ sender }, { ...(['activate', 'hostProjects'].includes(name) ? {} : { __repoWikiContext: context?.context_id }), ...args }), `repoWiki ${name}`, 120000);
    context = await call('activate', { workspace: projectPath, view_id: 'real-e2e' }); const hydrated = await call('hydrate'); context = { ...context!, project_id: hydrated.project.id };
    const preflight = await call('knowledge', { project_id: context.project_id, target: 'wiki' }) as RepoWikiKnowledgeSnapshot;
    log(`admission ${JSON.stringify(preflight.admission)}`);
    const started = await call('generate', { project_id: context.project_id, target: 'wiki', provider: 'real', confirm_external: true, intent: 'generate', request_id: crypto.randomUUID(), expected_model_identity: preflight.admission.modelIdentity, expected_plan_token: preflight.admission.planToken });
    const taskId = started.task_id as string; report.taskId = taskId;
    const deadline = Date.now() + Number(process.env.REPO_WIKI_REAL_TIMEOUT_MS ?? 45 * 60_000);
    let job: Job;
    for (;;) {
      job = await agentData.requestAdmin<Job>('admin.jobs.get', { id: taskId });
      if (['completed', 'failed', 'blocked', 'cancelled'].includes(job.state)) break;
      if (Date.now() > deadline) throw new Error('Real e2e timed out');
      await new Promise(resolveWait => setTimeout(resolveWait, 3000));
    }
    report.state = job.state; report.metadata = job.metadata?.repoWiki;
    await agentData.stop().catch(() => {});
    const db = new DatabaseSync(dataPath, { readOnly: true });
    try {
      report.items = db.prepare('SELECT phase,item_id,state,attempt,error FROM knowledge_build_items WHERE task_id=?').all(taskId);
      const requests = db.prepare("SELECT phase,item_id,kind,reserved,actual FROM knowledge_execution_requests WHERE task_id=? AND kind<>'time'").all(taskId) as Array<{ kind: string; actual: string | null }>;
      const usage = requests.filter(r => r.kind === 'model' && r.actual).map(r => JSON.parse(r.actual!));
      report.usage = { modelRequests: usage.length, toolCalls: requests.filter(r => r.kind === 'tool').length, budgetTokens: usage.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0), inputTokens: usage.reduce((sum, u) => sum + (u.inputTokens ?? 0), 0), outputTokens: usage.reduce((sum, u) => sum + (u.outputTokens ?? 0), 0) };
    } finally { db.close(); }
    expect(job.state, JSON.stringify(report.metadata)).toBe('completed');
    const publication = await inspectPublishedWiki(projectPath, job.metadata!.repoWiki!.key.language);
    report.published = publication.published; report.requiredItems = publication.requiredItems; report.pageIds = publication.pageIds;
    expect(publication.receipt.taskId).toBe(taskId);
    expect(publication.pageIds.length).toBe(job.metadata!.repoWiki!.counts.published);
    expect(publication.pageIds.length).toBeGreaterThan(0);
  } finally {
    report.log = lines;
    const out = process.env.REPO_WIKI_REAL_REPORT ?? join(tmpdir(), `repo-wiki-real-${Date.now()}.json`);
    await writeFile(out, JSON.stringify(report, null, 2)); console.info(`report ${out}`);
    await agentData.stop().catch(() => {}); await wiki.stop().catch(() => {});
    if (!process.env.REPO_WIKI_REAL_KEEP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 50 * 60_000);
