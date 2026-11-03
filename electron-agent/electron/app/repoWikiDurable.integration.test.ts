import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { createAgentDataModelPort } from '../agentData/createAgentDataModelPort';
import { agentDataPipePath } from '../agentDataProcess/pipePath';
import type { TaskView } from '../agentData/operationsContracts';
import type { Job } from '../agentData/jobStore';
import { AgentDataService } from './agentDataService';
import { createRepoWikiKnowledgeModelResolver } from './repoWikiKnowledgeModel';
import { RepoWikiService, type RepoWikiHostContext } from './repoWikiService';
import { WorkspaceService } from './workspaceService';
import { agentDataOsPort, bounded, fixtureProvider, pause, until } from './repoWikiWorkflow.integration.fixture';

const require = createRequire(import.meta.url);
let buildDir: string;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'repo-wiki-durable-build-'));
  await Promise.all([
    buildRepoWikiHost(resolve('.'), buildDir),
    build({ absWorkingDir: resolve('.'), entryPoints: ['scripts/fixtures/repoWikiWorkflowAgentDataHost.ts'],
      outfile: join(buildDir, 'workflow-agentdata-host.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' }),
  ]);
}, 45_000);
afterAll(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

describe('Repo Wiki durable AgentData task workflow across real OS processes', () => {
  it('continues off-page, resumes one task after application restart, and cancels through the task center', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-wiki-durable-'));
    const lines: string[] = [], log = (message: string) => { lines.push(message); console.info(message); };
    const provider = await fixtureProvider(log);
    const apps: Array<{ close(): Promise<void> }> = [];
    const repoCalls = () => provider.calls.filter((call) => call.kind === 'repo');
    const pageId = (call: { user: string }) => JSON.parse(call.user).page_id;
    const summary: Record<string, unknown> = { parentPid: process.pid, passes: [] as string[] };
    const pass = (message: string) => { (summary.passes as string[]).push(message); log(`PASS ${message}`); };
    try {
      const projectPath = join(root, 'repository');
      await mkdir(projectPath);
      await writeFile(join(projectPath, 'README.md'), '# Durable fixture\nA local repository for task lifecycle verification.\n');
      await writeFile(join(projectPath, 'usage.ts'), 'export const task = "persistent";\n');
      await writeFile(join(projectPath, 'wiki_plan.json'), JSON.stringify({ include: ['README.md', 'usage.ts'], exclude: [], pages: [
        { id: 'overview', title: 'Durable overview', goal: 'Describe the repository', patterns: ['README.md'], depends_on: [] },
        { id: 'usage', title: 'Durable usage', goal: 'Describe usage', patterns: ['usage.ts'], depends_on: ['overview'] },
      ] }));
      const modelsPath = join(root, 'models.json'), configPath = join(root, 'runtime-config.json');
      await writeFile(modelsPath, JSON.stringify({ providers: { workflow: {
        api: 'openai-completions', baseUrl: provider.baseUrl, apiKey: 'offline-fixture-key',
        models: [{ id: 'knowledge-b', reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 8192 }],
      } } }));
      await writeFile(configPath, JSON.stringify({ agentDataModel: 'workflow/knowledge-b', KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1' }));
      const modelHost = new ModelRuntimeHost({
        create: () => ModelRuntime.create({ modelsPath, authPath: join(root, 'auth.json'), allowModelNetwork: false }),
        resolveSettings: async () => ({ provider: 'workflow', modelId: 'knowledge-b' }),
      });
      const model = createAgentDataModelPort(modelHost, () => JSON.parse(readFileSync(configPath, 'utf8')).agentDataModel, () => readFile(modelsPath, 'utf8'));
      const workspace = new WorkspaceService(join(root, 'host-workspaces'));
      await workspace.ensureWorkspace(projectPath);
      const dataPath = join(root, 'agent-data.db');
      const openApp = async () => {
        let wiki!: RepoWikiService, resolveWiki!: (service: RepoWikiService) => void;
        const wikiReady = new Promise<RepoWikiService>((resolve) => { resolveWiki = resolve; });
        let osHost!: ReturnType<typeof agentDataOsPort>;
        const agentData = new AgentDataService({ mode: 'child', listenPath: agentDataPipePath(),
          createProcess: (launchState) => {
            osHost = agentDataOsPort({ entry: join(buildDir, 'workflow-agentdata-host.cjs'), executable: require('electron'),
              dataPath, configPath, launchState, model, log,
              mainMethod: async (name, params) => {
                const service = await wikiReady;
                if (name === 'repoWiki.run') return service.runTask(params as unknown as Parameters<RepoWikiService['runTask']>[0]);
                if (name === 'repoWiki.cancel') return service.cancelTask(params as { id: string; pause?: boolean });
                throw new Error(`Unexpected main method ${name}`);
              },
            });
            return osHost.port;
          },
        });
        await bounded(agentData.start(), 'durable AgentData startup');
        const commands = new Map<string, (event: any, args: any) => Promise<any>>();
        const events: Array<{ channel: string; payload: any }> = [];
        const sender = { id: 89, isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) };
        wiki = new RepoWikiService({ entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'repo-wiki'), tasks: agentData,
          configurationPollMs: 0, processOptions: { executable: require('electron'), maxRestarts: 0, requestTimeoutMs: 10_000, stopTimeoutMs: 2000 },
          registerCommand: (name, handler) => { commands.set(name, handler); return () => { commands.delete(name); }; },
          isTrustedSender: (event) => event.sender === sender, allowedWorkspaces: () => workspace.readProjectSnapshot(),
          projectSnapshot: () => workspace.getProjectSnapshot(), resolveModel: createRepoWikiKnowledgeModelResolver(agentData, model.configurationIdentity),
          onError: (error) => log(`wiki error: ${String(error)}`),
        });
        resolveWiki(wiki);
        let context!: RepoWikiHostContext, closed = false;
        const call = (name: string, args: Record<string, unknown> = {}) => bounded(commands.get(`repoWiki_${name}`)!({ sender }, {
          ...(['activate', 'hostProjects'].includes(name) ? {} : { __repoWikiContext: context.context_id }), ...args,
        }), `durable repoWiki_${name}`);
        const enter = async (viewId: string) => {
          context = await call('activate', { workspace: projectPath, view_id: viewId });
          const hydrated = await call('hydrate');
          context = { ...context, project_id: hydrated.project.id };
          return context;
        };
        const job = (id: string) => agentData.requestAdmin<Job>('admin.jobs.get', { id });
        const detail = (id: string) => agentData.requestAdmin<TaskView>('admin.tasks.read', { source: 'user', id });
        const waitState = async (id: string, state: string) => { await until(async () => (await job(id)).state === state, `task ${id} reaches ${state}`); return job(id); };
        const close = async () => { if (closed) return; closed = true; await agentData.stop(); await wiki.stop(); };
        const app = { agentData, wiki, osHost, call, enter, job, detail, waitState, events, close };
        apps.push(app);
        return app;
      };
      let app = await openApp();
      const initial = await app.enter('first-view');
      summary.initialPids = { agentData: app.osHost.pid, repoWiki: app.wiki.pid };
      expect(app.osHost.pid).not.toBe(process.pid);
      expect(app.wiki.pid).not.toBe(process.pid);
      expect(app.osHost.pid).not.toBe(app.wiki.pid);
      provider.hold((call) => call.kind === 'repo' && pageId(call) === 'usage');
      const first = await app.call('generate', { project_id: initial.project_id, confirm_external: true, force: true });
      const firstId = first.task_id ?? first.run_id;
      expect(firstId).toBeTruthy();
      await until(() => repoCalls().some((call) => pageId(call) === 'usage' && !call.settled), 'first task prepares overview and starts usage');
      expect(await app.job(firstId)).toMatchObject({ id: firstId, kind: 'repoWiki.generate', state: 'running' });
      await until(async () => (await app.detail(firstId)).currentPage === 'usage', 'task center records current page');
      expect(await app.detail(firstId)).toMatchObject({ progress: expect.any(Number), currentPage: 'usage', processed: 1, total: 2 });
      const firstUsage = repoCalls().find((call) => pageId(call) === 'usage')!;
      await app.call('release');
      await pause(150);
      expect(firstUsage.aborted).toBe(false);
      expect((await app.job(firstId)).state).toBe('running');
      const reopened = await app.enter('second-view');
      expect(await app.call('run', { project_id: reopened.project_id, target: 'wiki' })).toMatchObject({ id: firstId, status: 'running' });
      const duplicate = await app.call('generate', { project_id: reopened.project_id, confirm_external: true, force: true });
      expect(duplicate.task_id ?? duplicate.run_id).toBe(firstId);
      expect(repoCalls().map(pageId)).toEqual(['overview', 'usage']);
      firstUsage.release();
      await app.waitState(firstId, 'completed');
      pass('generation is recorded in agent_jobs; leaving and reopening the page preserves one running task and completed-page progress');
      const beforeForced = repoCalls().length;
      const next = await app.call('generate', { project_id: reopened.project_id, confirm_external: true, force: true });
      const resumedId = next.task_id ?? next.run_id;
      await until(() => repoCalls().length >= beforeForced + 2 && !repoCalls().at(-1)!.settled, 'second task prepares a checkpoint then blocks usage');
      expect(repoCalls().slice(beforeForced).map(pageId)).toEqual(['overview', 'usage']);
      const oldAgentPid = app.osHost.pid!, oldWikiPid = app.wiki.pid!;
      await bounded(app.close(), 'pause and stop original application', 15_000);
      expect(() => process.kill(oldAgentPid, 0)).toThrow();
      expect(() => process.kill(oldWikiPid, 0)).toThrow();
      const saved = new DatabaseSync(dataPath, { readOnly: true });
      try {
        const row = saved.prepare('SELECT state,metadata,progress FROM agent_jobs WHERE id=?').get(resumedId)!;
        expect(row.state).toBe('running');
        expect(JSON.parse(String(row.metadata)).payload).toMatchObject({ projectId: initial.project_id, target: 'wiki', force: true, confirmExternal: true });
        expect(Number(row.progress)).toBeGreaterThan(0);
      } finally { saved.close(); }
      app = await openApp();
      await until(() => repoCalls().length >= beforeForced + 3, 'automatic startup resumes unfinished task without opening Wiki');
      expect(repoCalls().slice(beforeForced).map(pageId)).toEqual(['overview', 'usage', 'usage']);
      expect((await app.job(resumedId)).state).toBe('running');
      const recovered = await app.enter('after-application-restart');
      expect(await app.call('run', { project_id: recovered.project_id, target: 'wiki' })).toMatchObject({ id: resumedId, status: 'running' });
      const latestUsage = repoCalls().at(-1)!;
      expect(latestUsage.aborted).toBe(false);
      latestUsage.release();
      await app.waitState(resumedId, 'completed');
      expect(repoCalls().slice(beforeForced).map(pageId)).toEqual(['overview', 'usage', 'usage']);
      expect((await app.agentData.requestAdmin<Job[]>('admin.jobs.list')).filter((job) => job.id === resumedId)).toHaveLength(1);
      summary.restartedPids = { agentData: app.osHost.pid, repoWiki: app.wiki.pid };
      summary.resumedTaskId = resumedId;
      pass('application shutdown preserves the request and page checkpoint; startup automatically resumes the same task without repeating its completed model page');
      const pageBeforeCancel = await app.call('page', { project_id: recovered.project_id, slug: 'overview' });
      provider.hold((call) => call.kind === 'repo');
      const callCount = repoCalls().length;
      const canceled = await app.call('generate', { project_id: recovered.project_id, confirm_external: true, force: true });
      const canceledId = canceled.task_id ?? canceled.run_id;
      await until(() => repoCalls().length > callCount && !repoCalls().at(-1)!.settled, 'cancel target enters actual provider');
      const canceledHttp = repoCalls().at(-1)!;
      await app.agentData.requestAdmin('admin.jobs.cancel', { id: canceledId });
      await app.waitState(canceledId, 'cancelled');
      await until(() => canceledHttp.aborted, 'task center cancellation aborts HTTP');
      expect((await app.call('page', { project_id: recovered.project_id, slug: 'overview' })).revision).toBe(pageBeforeCancel.revision);
      pass('task-center cancellation reaches the actual model HTTP connection and preserves committed documentation');
      summary.modelPages = repoCalls().map(pageId);
    } finally {
      for (const app of apps.reverse()) await app.close().catch((error) => log(`cleanup: ${String(error)}`));
      await provider.close();
      await writeFile(join(tmpdir(), `repo-wiki-durable-workflow-${process.pid}.json`), JSON.stringify({ ...summary, lines }, null, 2));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
