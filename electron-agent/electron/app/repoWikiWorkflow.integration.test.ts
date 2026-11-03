import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { createAgentDataModelPort } from '../agentData/createAgentDataModelPort';
import { agentDataPipePath } from '../agentDataProcess/pipePath';
import { AgentDataService } from './agentDataService';
import { createRepoWikiKnowledgeModelResolver } from './repoWikiKnowledgeModel';
import { RepoWikiService, type RepoWikiHostContext } from './repoWikiService';
import { WorkspaceService } from './workspaceService';
import { agentDataOsPort, bounded, fixtureProvider, pause, until } from './repoWikiWorkflow.integration.fixture';

const require = createRequire(import.meta.url);
const evidenceDir = resolve('..', '.tmp-repowiki-optimization');
let buildDir: string;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'repo-wiki-workflow-build-'));
  await Promise.all([
    buildRepoWikiHost(resolve('.'), buildDir),
    build({ absWorkingDir: resolve('.'), entryPoints: ['scripts/fixtures/repoWikiWorkflowAgentDataHost.ts'],
      outfile: join(buildDir, 'workflow-agentdata-host.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning' }),
  ]);
}, 45_000);
afterAll(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

describe('Repo Wiki production host workflow, across two real OS children', () => {
  it('projects host workspaces and shares the existing Wiki ingest scheduler/model/abort path', async () => {
    await mkdir(evidenceDir, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), 'repo-wiki-workflow-'));
    const logLines: string[] = [];
    const log = (message: string) => { const line = `${new Date().toISOString()} ${message}`; logLines.push(line); console.info(line); };
    const passed: string[] = [];
    const verified = (message: string) => { passed.push(message); log(`PASS ${message}`); };
    const cleanup: Array<() => Promise<unknown>> = [];
    let failure: unknown;
    try {
      log(`workflow fixture root=${root}`);
      const provider = await fixtureProvider(log); cleanup.push(provider.close);
      log(`loopback provider listening at ${provider.baseUrl}`);
      const modelsPath = join(root, 'models.json');
      const modelConfiguration = { providers: { workflow: {
        api: 'openai-completions', baseUrl: provider.baseUrl, apiKey: 'offline-fixture-key',
        headers: {} as Record<string, string>,
        models: ['app-default-a', 'knowledge-b', 'knowledge-c'].map((id) => ({ id, reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 8192 })),
      } } };
      await writeFile(modelsPath, JSON.stringify(modelConfiguration));
      const modelHost = new ModelRuntimeHost({
        create: () => ModelRuntime.create({ modelsPath, authPath: join(root, 'auth.json'), allowModelNetwork: false }),
        resolveSettings: async () => ({ provider: 'workflow', modelId: 'app-default-a' }),
      });
      let agentDataModel = 'workflow/knowledge-b';
      const configPath = join(root, 'runtime-config.json');
      const runtimeConfig = { KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '1', KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '1', KNOWLEDGE_WIKI_INGEST_MODE: 'single-stage' };
      await writeFile(configPath, JSON.stringify({ ...runtimeConfig, agentDataModel }));
      const modelPort = createAgentDataModelPort(modelHost,
        () => JSON.parse(readFileSync(configPath, 'utf8')).agentDataModel,
        () => readFile(modelsPath, 'utf8'));
      expect(await bounded(modelHost.describeModel(), 'offline SDK model initialization', 20_000)).toBe('workflow/app-default-a');
      let osHost!: ReturnType<typeof agentDataOsPort>;
      const agentData = new AgentDataService({ mode: 'child', listenPath: agentDataPipePath(),
        createProcess: (launchState) => {
          osHost = agentDataOsPort({ entry: join(buildDir, 'workflow-agentdata-host.cjs'), executable: require('electron'),
            dataPath: join(root, 'agent-data.db'), configPath, launchState, model: modelPort, log });
          return osHost.port;
        },
      });
      cleanup.push(() => agentData.stop());
      await bounded(agentData.start(), 'AgentDataService.start');
      expect(await agentData.describeKnowledgeModel()).toBe('workflow/knowledge-b');
      expect(osHost.pid).not.toBe(process.pid);
      expect(Number(osHost.nodeVersion.split('.')[0])).toBeGreaterThanOrEqual(22);

      const a = join(root, 'project-a'), b = join(root, 'project-b');
      for (const path of [a, b]) {
        await mkdir(path);
        await writeFile(join(path, 'README.md'), `# ${path === a ? 'A' : 'B'}\nThe registered host repository describes the integration workflow.\n`);
        await writeFile(join(path, 'wiki_plan.json'), JSON.stringify({ include: ['README.md'], exclude: [],
          pages: [{ id: 'overview', title: 'Workflow overview', goal: 'Explain the registered source', patterns: ['README.md'], depends_on: [] }] }));
      }
      const workspace = new WorkspaceService(join(root, 'host-agent'));
      const commands = new Map<string, (event: any, args: any) => Promise<any>>();
      const commandCalls: string[] = [];
      const events: Array<{ name: string; payload: any }> = [];
      const sender = { id: 77, isDestroyed: () => false, send: (name: string, payload: unknown) => events.push({ name, payload }) };
      const event = { sender };
      const wiki = new RepoWikiService({ entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'repo-wiki'),
        configurationPollMs: 0, processOptions: { executable: require('electron'), maxRestarts: 0, requestTimeoutMs: 10_000, stopTimeoutMs: 2000 },
        registerCommand: (name, handler) => { commands.set(name, handler); return () => { commands.delete(name); }; },
        isTrustedSender: (candidate) => candidate.sender === sender, allowedWorkspaces: () => workspace.readProjectSnapshot(),
        projectSnapshot: () => workspace.getProjectSnapshot(),
        isConversationWorkspaceSnapshot: (path) => workspace.isConversationWorkspaceSnapshot(path),
        resolveModel: createRepoWikiKnowledgeModelResolver(agentData, modelPort.configurationIdentity), onError: (error) => log(`service error ${String(error)}`),
      });
      cleanup.push(() => wiki.stop());
      const off = workspace.subscribeProjectsChanged(() => { void wiki.onHostProjectsChanged().catch((error) => log(`projects changed: ${String(error)}`)); });
      cleanup.push(async () => off());
      cleanup.push(async () => { provider.hold(() => false); provider.calls.forEach((item) => item.release()); });
      let context!: RepoWikiHostContext;
      const call = (name: string, input: Record<string, unknown> = {}, token = context?.context_id) => {
        commandCalls.push(name);
        return bounded(commands.get(`repoWiki_${name}`)!(event, { ...(['activate', 'hostProjects'].includes(name) ? {} : { __repoWikiContext: token }), ...input }), `repoWiki_${name}`);
      };
      const activate = async (path: string | null) => { context = await call('activate', { workspace: path }); log(`activate ${path} status=${context.status} project=${context.project_id}`); return context; };
      const enter = async (path: string) => {
        await activate(path);
        const hydrated = await call('hydrate');
        context = { ...context, project_id: hydrated.project.id };
        log(`hydrate ${path} project=${context.project_id} pid=${wiki.pid}`);
        return context;
      };
      const waitRun = async (projectId = context.project_id!) => {
        let run: any;
        await until(async () => { run = await call('run', { project_id: projectId }); return ['completed', 'failed', 'canceled', 'interrupted'].includes(run.status); }, 'Repo Wiki terminal run');
        log(`terminal project=${projectId} ${JSON.stringify(run)}`);
        return run;
      };
      expect(await activate(a)).toMatchObject({ status: 'pending', project_id: null });
      expect(wiki.pid).toBeUndefined();
      await workspace.ensureWorkspace(a); await workspace.ensureWorkspace(b);
      await wiki.onHostProjectsChanged();
      expect(await activate(a)).toMatchObject({ status: 'bound', project_id: null });
      expect(wiki.pid).toBeUndefined();
      const hostProjects = await call('hostProjects');
      expect(hostProjects.state).toBe('ready');
      expect(new Set(hostProjects.projects.map((item: any) => item.path))).toEqual(new Set([a, b]));
      const activeA = await enter(a);
      expect(activeA).toMatchObject({ status: 'bound', project_id: expect.any(String) });
      const projectA = activeA.project_id!;
      const projects = await call('projects');
      expect(projects).toHaveLength(1);
      expect(projects[0].path).toBe(a);
      expect(JSON.parse(await readFile(join(root, 'host-agent', 'opened-projects.json'), 'utf8')).projects).toHaveLength(2);
      expect(await workspace.listAllSessions()).toEqual([]);
      expect(commandCalls).not.toContain('create');
      expect(wiki.pid).not.toBe(process.pid); expect(wiki.pid).not.toBe(osHost.pid);
      const persistentWikiPid = wiki.pid;
      log(`process boundary parent=${process.pid} AgentData=${osHost.pid} RepoWiki=${wiki.pid}`);
      verified('real opened-projects.json metadata binds both host repositories without starting Wiki; hydration creates only the current project, without sessions or renderer create');

      await call('generate', { project_id: projectA, confirm_external: true });
      expect(await waitRun()).toMatchObject({ status: 'completed' });
      const originalPage = await call('page', { project_id: projectA, slug: 'overview' });
      const first = provider.calls.find((item) => item.kind === 'repo')!;
      expect(first.body.model).toBe('knowledge-b');
      expect(first.body.max_tokens ?? first.body.max_completion_tokens).toBe(8192);
      expect(first.body.messages.find((item: any) => item.role === 'system').content).toContain('JSON');
      expect(JSON.parse(first.user).files[0]).toMatchObject({ path: 'README.md', content_with_lines: expect.stringContaining('1: # A') });
      expect(originalPage.sources).toEqual([expect.objectContaining({ path: 'README.md', start_line: 1, end_line: 1, hash: expect.any(String) })]);
      verified('Repo Wiki OS child -> AgentDataService child RPC -> WikiService -> reverse model RPC -> real ModelRuntimeHost/SDK HTTP uses knowledge-b, while app default is app-default-a');

      const legacy = await agentData.requestAdmin<{ wikiId: string }>('wiki.create', { name: 'Existing production Wiki ingest' });
      await agentData.requestAdmin('wiki.rawWrite', { wikiId: legacy.wikiId, filename: 'workflow-source.md', content: '# Workflow\nAn actual legacy ingestion task owns the shared knowledge model slot.\n' });
      provider.hold((item) => item.kind === 'legacy');
      const ingest = agentData.requestAdmin('wiki.ingest', { wikiId: legacy.wikiId });
      const observedIngest = ingest.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      await until(() => provider.calls.some((item) => item.kind === 'legacy' && !item.settled), 'legacy Wiki ingest entering provider');
      expect(provider.calls.find((item) => item.kind === 'legacy')!.body.model).toBe('knowledge-b');
      const repoBeforeQueue = provider.calls.filter((item) => item.kind === 'repo').length;
      const rpcBefore = osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length;
      await call('generate', { project_id: projectA, confirm_external: true, force: true });
      await until(() => osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length > rpcBefore, 'Repo Wiki reaching production knowledge RPC');
      await osHost.port.request('fixture.barrier'); await pause(150);
      expect(provider.calls.filter((item) => item.kind === 'repo')).toHaveLength(repoBeforeQueue);
      await call('cancel', { project_id: projectA });
      expect(await waitRun()).toMatchObject({ status: 'canceled' });
      await osHost.port.request('fixture.barrier');
      expect(provider.calls.filter((item) => item.kind === 'repo')).toHaveLength(repoBeforeQueue);
      provider.hold(() => false); provider.calls.filter((item) => item.kind === 'legacy').forEach((item) => item.release());
      const legacyResult = await bounded(observedIngest, 'legacy Wiki ingestion completion');
      expect(legacyResult.ok, 'error' in legacyResult ? String(legacyResult.error) : JSON.stringify(legacyResult)).toBe(true);
      if ('value' in legacyResult) expect(legacyResult.value).toMatchObject({ kind: 'ok' });
      await pause(100);
      expect(provider.calls.filter((item) => item.kind === 'repo')).toHaveLength(repoBeforeQueue);
      verified('actual legacy wiki.ingest occupies global budget=1; Repo Wiki waits, and canceling the queued generation never reaches the provider');

      provider.hold((item) => item.kind === 'repo');
      await call('generate', { project_id: projectA, confirm_external: true, force: true });
      let running = provider.calls.filter((item) => item.kind === 'repo').at(-1)!;
      await until(() => { running = provider.calls.filter((item) => item.kind === 'repo').at(-1)!; return !running.settled; }, 'running Repo Wiki provider');
      await call('cancel', { project_id: projectA });
      await until(() => running.aborted, 'running abort propagating to actual SDK HTTP request');
      expect(await waitRun()).toMatchObject({ status: 'canceled' });
      expect((await call('page', { project_id: projectA, slug: 'overview' })).markdown).toBe(originalPage.markdown);
      verified('running generation cancel crosses both OS children and reverse main.model.abort; actual provider connection closes, preserving the previous page');

      await call('generate', { project_id: projectA, confirm_external: true, force: true });
      let switched = provider.calls.filter((item) => item.kind === 'repo').at(-1)!;
      await until(() => { switched = provider.calls.filter((item) => item.kind === 'repo').at(-1)!; return !switched.settled; }, 'provider before workspace switch');
      const staleA = context.context_id;
      const activeB = await enter(b);
      expect(wiki.pid).toBe(persistentWikiPid);
      await until(() => switched.aborted, 'workspace transition canceling old model call');
      expect(activeB.project_id).not.toBe(projectA);
      await expect(call('project', { project_id: projectA }, staleA)).rejects.toMatchObject({ status: 409 });
      await expect(call('project', { project_id: projectA })).rejects.toMatchObject({ status: 403 });
      const afterSwitch = events.length;
      provider.hold(() => false);
      await call('generate', { project_id: activeB.project_id, confirm_external: true });
      expect(await waitRun()).toMatchObject({ status: 'completed' });
      const currentEvents = events.slice(afterSwitch).filter((item) => item.name === 'gren:event:repoWiki://progress');
      expect(currentEvents.length).toBeGreaterThan(0);
      expect(currentEvents.every((item) => item.payload.project_id === activeB.project_id && item.payload.context_id === activeB.context_id)).toBe(true);
      expect((await enter(a)).project_id).toBe(projectA);
      expect(wiki.pid).toBe(persistentWikiPid);
      const sameContext = context.context_id;
      expect((await activate(a)).context_id).toBe(sameContext);
      expect(await activate(null)).toMatchObject({ workspace: null, project_id: null, status: 'empty' });
      expect(wiki.pid).toBe(persistentWikiPid);
      expect((await enter(a)).project_id).toBe(projectA);
      expect(await call('projects')).toHaveLength(2);
      expect(commandCalls).not.toContain('create');
      verified('A -> B -> A, repeated entry and empty workspace preserve one RepoWiki OS child and project IDs; switching cancels old generation and rejects stale/cross-project access');

      provider.hold((item) => item.kind === 'repo');
      await call('generate', { project_id: projectA, confirm_external: true, force: true });
      let closing = provider.calls.filter((item) => item.kind === 'repo').at(-1)!;
      await until(() => { closing = provider.calls.filter((item) => item.kind === 'repo').at(-1)!; return !closing.settled; }, 'provider before closing the Wiki panel');
      const closingContext = context.context_id;
      const eventsBeforeClose = events.length;
      expect(await activate(null)).toMatchObject({ status: 'empty', project_id: null });
      await until(() => closing.aborted, 'closing the panel aborting its model lease');
      expect(wiki.pid).toBe(persistentWikiPid);
      await expect(call('health', {}, closingContext)).rejects.toMatchObject({ status: 409 });
      provider.hold(() => false);
      expect((await enter(a)).project_id).toBe(projectA);
      expect(wiki.pid).toBe(persistentWikiPid);
      expect(events.slice(eventsBeforeClose).filter((item) => item.name === 'gren:event:repoWiki://progress' && item.payload.context_id === closingContext)).toEqual([]);
      expect((await call('page', { project_id: projectA, slug: 'overview' })).markdown).toBe(originalPage.markdown);
      verified('closing the Wiki panel cancels its actual SDK connection and retires the context without restarting the child or delivering late old-context progress; reopening retains the previous Markdown');

      provider.hold((item) => item.kind === 'probe' && item.user.includes('blocker'));
      const blocker = agentData.completeKnowledge({ user: 'workflow-probe:blocker', expectedModel: 'workflow/knowledge-b' });
      const observedBlocker = blocker.then((value) => ({ value }), (error) => ({ error }));
      await until(() => provider.calls.some((item) => item.user === 'workflow-probe:blocker'), 'model guard blocker');
      const oldBinding = await createRepoWikiKnowledgeModelResolver(agentData, modelPort.configurationIdentity)(a);
      const guardRpcBefore = osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length;
      const guarded = oldBinding.complete({ systemPrompt: 'Model guard', user: 'workflow-probe:stale-binding', maxTokens: 27 }, new AbortController().signal);
      const observedGuard = guarded.then((value) => ({ value }), (error) => ({ error }));
      await until(() => osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length > guardRpcBefore, 'old model binding reaching the occupied scheduler');
      await osHost.port.request('fixture.barrier');
      agentDataModel = 'workflow/knowledge-c';
      await writeFile(configPath, JSON.stringify({ ...runtimeConfig, agentDataModel }));
      provider.calls.find((item) => item.user === 'workflow-probe:blocker')!.release();
      await bounded(observedBlocker, 'blocker release');
      const guard = await bounded(observedGuard, 'queued model identity protection');
      expect('error' in guard && String(guard.error)).toContain('MODEL_CHANGED');
      expect(provider.calls.some((item) => item.user === 'workflow-probe:stale-binding')).toBe(false);
      await expect(agentData.completeKnowledge({ user: 'workflow-probe:new-model', expectedModel: 'workflow/knowledge-c' })).resolves.toBe('workflow-probe:ok');
      expect(provider.calls.at(-1)!.body.model).toBe('knowledge-c');
      verified('queued old model binding rejects MODEL_CHANGED before provider dispatch; new requests resolve the changed AgentData model');

      const configBlocker = agentData.completeKnowledge({ user: 'workflow-probe:configuration-blocker', expectedModel: 'workflow/knowledge-c' });
      const observedConfigBlocker = configBlocker.then((value) => ({ value }), (error) => ({ error }));
      await until(() => provider.calls.some((item) => item.user === 'workflow-probe:configuration-blocker'), 'configuration guard blocker');
      const resolveKnowledge = createRepoWikiKnowledgeModelResolver(agentData, modelPort.configurationIdentity);
      const configurationBinding = await resolveKnowledge(a);
      const configurationRpcBefore = osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length;
      const configurationGuarded = configurationBinding.complete({ user: 'workflow-probe:stale-configuration', systemPrompt: 'Configuration guard' }, new AbortController().signal);
      const observedConfigurationGuard = configurationGuarded.then((value) => ({ value }), (error) => ({ error }));
      await until(() => osHost.requests.filter((method) => method === 'agentdata.knowledge.complete').length > configurationRpcBefore, 'old configuration reaching the occupied scheduler');
      await osHost.port.request('fixture.barrier');
      modelConfiguration.providers.workflow.headers['x-workflow-version'] = '2';
      await writeFile(modelsPath, JSON.stringify(modelConfiguration));
      await (await modelHost.ensure()).refresh({ allowNetwork: false });
      const refreshedConfigurationBinding = await resolveKnowledge(a);
      expect(refreshedConfigurationBinding.cacheKey).not.toBe(configurationBinding.cacheKey);
      provider.calls.find((item) => item.user === 'workflow-probe:configuration-blocker')!.release();
      await bounded(observedConfigBlocker, 'configuration blocker release');
      const configurationGuard = await bounded(observedConfigurationGuard, 'same-model configuration protection');
      expect('error' in configurationGuard && String(configurationGuard.error)).toContain('MODEL_CHANGED');
      expect(provider.calls.some((item) => item.user === 'workflow-probe:stale-configuration')).toBe(false);
      await expect(refreshedConfigurationBinding.complete({ user: 'workflow-probe:new-configuration', systemPrompt: 'Configuration guard' }, new AbortController().signal)).resolves.toBe('workflow-probe:ok');
      expect(provider.calls.at(-1)!.body.model).toBe('knowledge-c');
      expect(provider.calls.at(-1)!.headers['x-workflow-version']).toBe('2');
      verified('same model ID with changed real SDK headers changes cache identity; queued old configuration rejects MODEL_CHANGED, while the new binding sends the changed header');
      expect(osHost.requests).not.toContain('agentdata.runServiceTask');
      log(`verified production private methods: ${[...new Set(osHost.requests)].join(', ')}`);
    } catch (error) { failure = error; log(`FAIL ${error instanceof Error ? error.stack : String(error)}`); throw error; }
    finally {
      for (const close of cleanup.reverse()) {
        try { await bounded(close(), 'workflow cleanup', 8000); } catch (error) { log(`cleanup: ${String(error)}`); }
      }
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, 'workflow-integration.log'), `${logLines.join('\n')}\n`);
      await writeFile(join(evidenceDir, 'workflow-integration-report.md'), [
        '# Repo Wiki production workflow integration', '', `Result: ${failure ? 'FAIL' : 'PASS'}`, '',
        'Command: `cd electron-agent; npx vitest run electron/app/repoWikiWorkflow.integration.test.ts`', '',
        'Boundaries: real WorkspaceService and opened-projects.json; compiled Repo Wiki Electron-as-Node OS child; AgentDataService child mode and a second actual Electron-as-Node OS child using production createAgentDataHost / assembleAgentData / AgentDataRuntime / WikiService; production createAgentDataModelPort / ModelRuntimeHost / Pi SDK and a loopback HTTP provider. CodeGraph alone is an unrelated deterministic stub. No external provider, paid calls, precreated Wiki project list, mocked scheduler, or dormant TaskQueue path.', '',
        ...passed.map((message) => `- PASS: ${message}`), '',
        ...(failure ? [`Failure: ${String(failure)}`, 'See workflow-integration.log for the actual process trace.'] : ['Every RPC/run wait has a deadline. Only this requested workflow was run; no unrelated UI scenarios.']), '',
      ].join('\n'));
      await rm(root, { recursive: true, force: true });
    }
  }, process.platform === 'win32' ? 150_000 : 90_000);
});
