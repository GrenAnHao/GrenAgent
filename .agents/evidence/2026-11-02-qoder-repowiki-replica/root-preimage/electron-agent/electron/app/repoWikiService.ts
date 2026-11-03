/** Main-process boundary only. Repository files, scanning and SQLite live in the child. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { isSameAppPage } from '../mainWindowNavigation';
import { RepoWikiProcessClient, type ProcessOptions } from '../../vendor/repo-wiki/packages/process/src/client';
import type { GrenRegistration, SenderEvent } from '../../vendor/repo-wiki/packages/electron/src/index';
import { ACTIONS, ContractError, validateRequest, type Action, type ModelComplete, type ProgressEvent, type Project, type RequestMap, type ResponseMap } from '../../vendor/repo-wiki/packages/contracts/src/index';
import type { HostActivation, HostHydrateResult, HostProjectsSnapshot } from '../../vendor/repo-wiki/packages/contracts/src/host';
import type { Job } from '../agentData/jobStore';
import type { RepoWikiJobPayload } from '../agentData/operationsContracts';
import { knowledgeExecutionKey, type KnowledgeExecutionScope, type ExecutionFence, type RepoWikiKnowledgeSnapshot } from '../../shared/knowledgeKernelContracts';

interface RepoWikiTaskInput { id: string; workspace: string; payload: RepoWikiJobPayload; expectedModel?: string }
interface TaskExecution extends RepoWikiTaskInput {
  contextId: string;
  done: Promise<{ cancelled: boolean }>;
  resolve(value: { cancelled: boolean }): void;
  reject(error: unknown): void;
  client?: RepoWikiProcessClient;
  release?: () => void;
  cancelRequested?: boolean;
  paused?: boolean;
  started?: boolean;
  settled?: boolean;
  latest?: ResponseMap['run'];
  sequence?: number;
  revision: number;
  updates: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export function repoWikiModelCacheKey(provider: string, modelId: string, configurationVersion: string): string {
  return `gren-repowiki:${createHash('sha256').update(JSON.stringify([provider, modelId, configurationVersion])).digest('hex')}`;
}
/** A URL alone is insufficient: webviews and stale/subframes may have the same URL. */
export function isTrustedRepoWikiSender(event: SenderEvent, options: {
  window: Pick<BrowserWindow, 'webContents' | 'isDestroyed'> | undefined;
  appUrl: string; windowForSender: (sender: WebContents) => BrowserWindow | null;
}): boolean {
  const window = options.window;
  if (!window || window.isDestroyed()) return false;
  const sender = event.sender as WebContents;
  if (sender !== window.webContents || sender.isDestroyed() || options.windowForSender(sender) !== window) return false;
  const frame = (event as IpcMainInvokeEvent).senderFrame;
  return !!frame && frame === sender.mainFrame && frame.parent === null
    && isSameAppPage(frame.url, options.appUrl) && isSameAppPage(sender.getURL(), options.appUrl);
}
export interface RepoWikiModelBinding { cacheKey: string; model?: string; available?: boolean; complete: ModelComplete }
export interface RepoWikiServiceOptions extends Omit<GrenRegistration, 'allowedWorkspaces'> {
  entry: string; dataDir: string;
  /** Host registry metadata only; never enumerate/stat every project directory here. */
  allowedWorkspaces(): Promise<string[]>;
  /** Undefined means the host has not read its registry yet. This getter must perform no I/O. */
  projectSnapshot?(): string[] | undefined;
  isConversationWorkspaceSnapshot?(workspace: string): boolean;
  isConversationWorkspace?(workspace: string): Promise<boolean>;
  resolveModel(workspace?: string): Promise<RepoWikiModelBinding>;
  /** Production generation is owned by the AgentData durable job runner. */
  tasks?: { requestAdmin<T>(method: string, params?: Record<string, unknown>): Promise<T> };
  knowledge?: { requestAdmin<T>(method: string, params?: Record<string, unknown>): Promise<T> };
  configurationPollMs?: number;
  processOptions?: Pick<ProcessOptions, 'executable' | 'startupTimeoutMs' | 'requestTimeoutMs' | 'stopTimeoutMs' | 'maxRestarts' | 'restartDelayMs'>;
  onError?: (error: unknown) => void;
}
export type RepoWikiHostContext = HostActivation;
function pathKey(path: string): string {
  const normalized = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
const namespaceKey = (workspace: string, language: string) => JSON.stringify([pathKey(workspace), language]);
const nameOf = (workspace: string) => workspace.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || workspace;
const terminalRun = (status: string) => !['queued', 'pending', 'running', 'cancel_requested'].includes(status);

/** Trusted-window registration, cheap context binding, lazy current-project I/O. */
export class RepoWikiService {
  private client?: RepoWikiProcessClient;
  private clientRootsKey?: string;
  private failedClient?: RepoWikiProcessClient;
  private transition: Promise<unknown> = Promise.resolve();
  private stopping?: Promise<void>;
  private disposed = false;
  private currentInstance?: string;
  private readonly removers: Array<() => void> = [];
  private readonly stoppingClients = new Set<Promise<void>>();
  private readonly recipients = new Map<number, { event: SenderEvent; context: HostActivation }>();
  private context: HostActivation = { workspace: null, language: 'zh', project_id: null, status: 'empty', context_id: randomUUID(), projects_revision: 0 };
  private viewOwner?: string;
  private snapshot: HostProjectsSnapshot = { revision: 0, state: 'pending', projects: [] };
  private rootsKey?: string;
  private roots: string[] = [];
  private readonly projects = new Map<string, Project>();
  private readonly hydration = new Map<string, Promise<HostHydrateResult>>();
  private readonly leases = new Map<string, { contextId: string; projectId: string; runId?: string; release: () => void }>();
  private readonly terminalRuns = new Set<string>();
  private readonly generating = new Map<string, Promise<ResponseMap['generate']>>();
  private readonly poll?: ReturnType<typeof setInterval>;
  private lastWorkspacesNotice?: string;
  private readonly taskExecutions = new Map<string, TaskExecution>();
  private readonly taskTails = new Map<string, Promise<unknown>>();
  private knowledgeEpoch?: string;
  private readonly knowledgeHydrated = new Set<string>();
  private readonly knowledgeStages = new Map<string, { taskId: string; projectId: string; workspace: string; fence: ExecutionFence }>();
  private readonly canceledKnowledgeStages = new Set<string>();
  private readonly knowledgeCandidates = new Map<string, { projectId: string; workspace: string }>();

  constructor(private readonly options: RepoWikiServiceOptions) {
    const register = (name: string, handler: (event: SenderEvent, args: Record<string, unknown>) => Promise<unknown>) => {
      const remove = options.registerCommand(name, handler);
      if (typeof remove === 'function') this.removers.push(remove);
    };
    register('repoWiki_activate', (event, args) => this.activate(event, args));
    register('repoWiki_hostProjects', async (event, args) => {
      this.trusted(event);
      if (!args || Object.keys(args).length) throw new ContractError('Invalid host projects request');
      this.readFastSnapshot();
      this.recipients.set(event.sender.id, { event, context: this.context });
      return this.copySnapshot();
    });
    register('repoWiki_hydrate', (event, args) => {
      const context = this.requestContext(event, args);
      if (Object.keys(args).some((key) => key !== '__repoWikiContext')) throw new ContractError('Invalid host hydrate request');
      return this.hydrate(event, context);
    });
    register('repoWiki_release', async (event, args) => {
      this.trusted(event);
      if (!args || typeof args.__repoWikiContext !== 'string' || Object.keys(args).some((key) => key !== '__repoWikiContext'))
        throw new ContractError('Invalid host release request');
      if (args.__repoWikiContext !== this.context.context_id) return { released: false };
      this.revokeContext();
      this.context = { ...this.context, workspace: null, project_id: null, status: 'empty' };
      this.notifyWorkspaces();
      return { released: true };
    });
    // Hydration binds project -> canonical root. Reading a whole project before
    // every command doubles query work and blocks cheap run/cancel on content I/O.
    for (const action of ACTIONS) register(`repoWiki_${action}`, (event, args) => this.invoke(event, action, args));
    const period = options.configurationPollMs ?? 2000;
    if (period > 0) {
      this.poll = setInterval(() => { void this.refreshConfiguration().catch((error) => options.onError?.(error)); }, period);
      this.poll.unref();
    }
  }
  get pid(): number | undefined { return this.client?.pid; }
  private trusted(event: SenderEvent): void {
    if (this.disposed || event.sender.isDestroyed?.() || !this.options.isTrustedSender(event)) throw new ContractError('Untrusted or disposed RepoWiki bridge', 403);
  }
  private assertCurrent(context: HostActivation): void {
    if (this.disposed) throw new ContractError('RepoWiki service is stopped', 503);
    if (context !== this.context) throw new ContractError('RepoWiki workspace context is stale', 409);
  }
  private requestContext(event: SenderEvent, args: Record<string, unknown>): HostActivation {
    this.trusted(event);
    const context = this.context;
    if (!args || typeof args !== 'object' || args.__repoWikiContext !== context.context_id)
      throw new ContractError('RepoWiki workspace context is stale; activate the current workspace', 409);
    this.recipients.set(event.sender.id, { event, context });
    return context;
  }
  private copySnapshot(): HostProjectsSnapshot { return { ...this.snapshot, projects: this.snapshot.projects.map((project) => ({ ...project })) }; }
  private updateSnapshot(roots: string[]): boolean {
    const sorted = [...new Map(roots.map((root) => [pathKey(root), root])).values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
    const key = JSON.stringify(sorted.map(pathKey));
    const changed = this.snapshot.state !== 'ready' || key !== this.rootsKey;
    this.roots = sorted; this.rootsKey = key;
    if (changed) this.snapshot = { revision: this.snapshot.revision + 1, state: 'ready', projects: sorted.map((path) => ({ key: pathKey(path), path, name: nameOf(path) })) };
    this.context.projects_revision = this.snapshot.revision;
    return changed;
  }
  private readFastSnapshot(): void {
    const roots = this.options.projectSnapshot?.();
    if (roots !== undefined && this.snapshot.state !== 'error') this.updateSnapshot(roots);
  }
  private async refreshRoots(notify = true): Promise<string[]> {
    try {
      const roots = await this.options.allowedWorkspaces();
      if (this.disposed) throw new ContractError('RepoWiki service is stopped', 503);
      if (this.updateSnapshot(roots) && notify) this.notifyWorkspaces();
      return this.roots;
    } catch (error) {
      this.roots = []; this.rootsKey = undefined;
      this.snapshot = { revision: this.snapshot.revision + 1, state: 'error', projects: [], error: 'Host project registry is unavailable' };
      this.revokeContext(); this.retireClient(); this.notifyWorkspaces();
      throw error;
    }
  }
  private notifyWorkspaces(): void {
    const notice = JSON.stringify([this.context.context_id, this.context.project_id, this.snapshot.revision]);
    if (notice === this.lastWorkspacesNotice) return;
    this.lastWorkspacesNotice = notice;
    const payload = { context_id: this.context.context_id, project_id: this.context.project_id, revision: this.snapshot.revision, projects: this.copySnapshot() };
    for (const { event } of this.recipients.values()) this.sendHostEvent(event, 'repoWiki://workspaces', payload);
  }
  private sendHostEvent(event: SenderEvent, name: string, payload: unknown): void {
    try {
      this.trusted(event);
      if (this.options.sendEvent) this.options.sendEvent(event, name, payload as ProgressEvent);
      else event.sender.send(`gren:event:${name}`, payload);
    } catch { this.recipients.delete(event.sender.id); }
  }
  private releaseContextLeases(contextId: string): void {
    for (const [id, lease] of this.leases) if (lease.contextId === contextId) { lease.release(); this.leases.delete(id); }
  }
  private revokeContext(): void {
    const previous = this.context;
    // cancelContext synchronously aborts host model controllers before its first await.
    void this.client?.cancelContext(previous.context_id).catch((error) => this.options.onError?.(error));
    this.releaseContextLeases(previous.context_id);
    for (const key of this.terminalRuns) if (key.startsWith(previous.context_id + '/')) this.terminalRuns.delete(key);
    this.context = { ...previous, project_id: null, context_id: randomUUID(), status: previous.workspace ? 'pending' : 'empty', projects_revision: this.snapshot.revision };
  }
  private async activate(event: SenderEvent, args: Record<string, unknown>): Promise<HostActivation> {
    this.trusted(event);
    if (!args || Object.keys(args).some((key) => !['workspace', 'language', 'retry', 'view_id'].includes(key))
      || (args.workspace !== null && (typeof args.workspace !== 'string' || !args.workspace.trim() || args.workspace.length > 4096))
      || (args.language !== undefined && (typeof args.language !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,19}$/.test(args.language)))
      || (args.view_id !== undefined && (typeof args.view_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(args.view_id)))
      || (args.retry !== undefined && args.retry !== true)) throw new ContractError('Invalid host workspace context');
    // Lexical identity only: no realpath, registry read, model or child startup.
    this.readFastSnapshot();
    const workspace = args.workspace as string | null;
    const sameWorkspace = workspace === null ? this.context.workspace === null
      : this.context.workspace !== null && pathKey(workspace) === pathKey(this.context.workspace);
    const language = typeof args.language === 'string' ? args.language : sameWorkspace ? this.context.language : 'zh';
    // A reply may outlive the view that requested it. New mounted views must
    // never inherit its release token, even when they select the same path.
    const owner = JSON.stringify([event.sender.id, args.view_id ?? null]);
    const changed = !sameWorkspace || language !== this.context.language || owner !== this.viewOwner;
    if (changed || (args.retry === true && this.failedClient)) {
      this.revokeContext();
      if (args.retry === true && this.failedClient) this.retireClient();
      this.context = { workspace, language, project_id: workspace ? this.projects.get(namespaceKey(workspace, language))?.id ?? null : null,
        status: 'pending', context_id: this.context.context_id, projects_revision: this.snapshot.revision };
    }
    this.viewOwner = owner;
    const empty = !workspace || this.options.isConversationWorkspaceSnapshot?.(workspace);
    this.context.status = empty ? 'empty' : this.roots.some((root) => pathKey(root) === pathKey(workspace)) ? 'bound' : 'pending';
    if (empty) this.context.project_id = null;
    this.recipients.set(event.sender.id, { event, context: this.context });
    return { ...this.context };
  }
  private isApproved(context: HostActivation): boolean {
    this.readFastSnapshot();
    return !!context.workspace && this.roots.some((root) => pathKey(root) === pathKey(context.workspace!));
  }
  private async prepare(event: SenderEvent, context: HostActivation): Promise<{ roots: string[]; workspace: string }> {
    this.assertCurrent(context); this.trusted(event);
    if (!context.workspace || context.status === 'empty') throw new ContractError('No active host project is available', 403);
    await this.refreshRoots(false);
    this.assertCurrent(context); this.trusted(event);
    if (!this.isApproved(context)) throw new ContractError('Repository is not an approved host project', 403);
    const registered = this.roots.find((root) => pathKey(root) === pathKey(context.workspace!))!;
    const actual = await realpath(registered).catch(() => { throw new ContractError('Workspace is unavailable', 404); });
    this.assertCurrent(context); this.trusted(event);
    if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
    // ensureWorkspace persisted canonical authority. A later symlink/reparse target
    // must not silently become a newly approved root.
    if (pathKey(actual) !== pathKey(registered)) throw new ContractError('Host workspace canonical path changed; reopen the project', 403);
    context.status = 'bound';
    return { roots: [...this.roots], workspace: actual };
  }
  private hydrate(event: SenderEvent, context: HostActivation): Promise<HostHydrateResult> {
    const existing = this.hydration.get(context.context_id);
    if (existing) return existing;
    const promise = (async () => {
      const prepared = await this.prepare(event, context), client = await this.ensureClient(prepared.roots);
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
      const project = await client.invokeScoped('create', { path: prepared.workspace, language: context.language }, { contextId: context.context_id });
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context) || pathKey(project.path) !== pathKey(prepared.workspace) || project.language !== context.language)
        throw new ContractError('Wiki project does not belong to the current host namespace', 403);
      this.projects.set(namespaceKey(context.workspace!, context.language), project); context.project_id = project.id;
      return { context_id: context.context_id, project };
    })();
    this.hydration.set(context.context_id, promise);
    void promise.finally(() => { if (this.hydration.get(context.context_id) === promise) this.hydration.delete(context.context_id); }).catch(() => {});
    return promise;
  }
  private async invoke(event: SenderEvent, action: Action, args: Record<string, unknown>): Promise<unknown> {
    const context = this.requestContext(event, args);
    const { __repoWikiContext: _token, ...input } = args;
    validateRequest(action, input);
    if (action === 'clone') throw new ContractError('Clone is disabled in embedded mode', 403);
    if (action === 'health') return { status: 'ok', version: '2.0.0', backend: 'host', local_only: true,
      ...(this.pid ? { service_pid: this.pid } : {}), provider: { mode: 'host-knowledge-scheduler', keys_in_renderer: false, preparation: 'on-generation' } };
    if (action === 'projects') {
      this.readFastSnapshot();
      return [...this.projects.values()].filter((project) => this.roots.some((root) => pathKey(root) === pathKey(project.path)));
    }
    if (action === 'create') {
      if (!context.workspace || pathKey(input.path as string) !== pathKey(context.workspace)) throw new ContractError('Repository is not the active host project', 403);
      const prepared = await this.prepare(event, context), client = await this.ensureClient(prepared.roots);
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
      const result = await client.invokeScoped(action, { ...input, path: prepared.workspace } as RequestMap['create'], { contextId: context.context_id });
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context) || pathKey(result.path) !== pathKey(prepared.workspace)) throw new ContractError('Host project approval was revoked', 403);
      this.projects.set(namespaceKey(context.workspace, result.language), result);
      if (result.language === context.language) context.project_id = result.id;
      return result;
    }
    if (!context.project_id || input.project_id !== context.project_id) throw new ContractError('RepoWiki request does not belong to the active host project', 403);
    if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
    if (this.options.knowledge && action === 'scan') {
      await this.options.knowledge.requestAdmin('admin.knowledge.check', { projectId: context.project_id, domain: input.target ?? 'wiki' });
      const prepared = await this.prepare(event, context), client = await this.ensureClient(prepared.roots);
      return client.invokeScoped('changes', input as RequestMap['changes'], { contextId: context.context_id });
    }
    if (this.options.knowledge && ['knowledge', 'action', 'drafts', 'generate', 'run', 'cancel'].includes(action)) {
      await this.prepare(event, context);
      const projectId = context.project_id;
      const domain = input.target === 'cards' ? 'cards' : 'wiki';
      if (action === 'knowledge') return this.options.knowledge.requestAdmin('admin.knowledge.snapshot', { projectId, domain });
      if (action === 'drafts' || action === 'action') {
        const job = await this.options.knowledge.requestAdmin<Job | undefined>('admin.jobs.get', { id: input.task_id });
        if (!job?.metadata?.repoWiki || job.metadata.repoWiki.key.projectId !== projectId || job.metadata.repoWiki.key.language !== context.language
          || pathKey(job.workspace) !== pathKey(context.workspace!)) throw new ContractError('Task is not owned by this project', 403);
        if (action === 'drafts') {
          const drafts = await this.options.knowledge.requestAdmin<{ taskId: string; items: Array<{ id: string; title: string; markdown: string; sources: Array<{ path: string; hash?: string; start?: number; end?: number; start_line?: number; end_line?: number }> }> }>('admin.knowledge.drafts', { taskId: job.id });
          return { ...drafts, items: drafts.items.map(item => ({ ...item, sources: item.sources.map(source => ({ path: source.path,
            start_line: source.start_line ?? source.start!, end_line: source.end_line ?? source.end!, ...(source.hash ? { hash: source.hash } : {}) })) })) };
        }
        return this.options.knowledge.requestAdmin('admin.knowledge.action', { version: 1, taskId: job.id, requestId: input.request_id,
          expectedRevision: input.expected_revision, action: input.action, confirmExternal: input.confirm_external,
          expectedModelIdentity: input.expected_model_identity, expectedPlanToken: input.expected_plan_token });
      }
      const snapshot = await this.options.knowledge.requestAdmin<RepoWikiKnowledgeSnapshot>('admin.knowledge.snapshot', { projectId, domain });
      this.assertCurrent(context); this.trusted(event);
      if (action === 'run') return this.knowledgeRun(snapshot);
      if (action === 'cancel') {
        if (!snapshot.run) return { status: 'idle' };
        const next = await this.options.knowledge.requestAdmin<RepoWikiKnowledgeSnapshot>('admin.knowledge.action', { version: 1, requestId: randomUUID(),
          taskId: snapshot.run.taskId, expectedRevision: snapshot.run.revision, action: 'cancel' });
        return { run_id: snapshot.run.taskId, status: next.run?.state ?? 'cancelled' };
      }
      if (input.provider === 'demo' || input.confirm_external !== true) throw new ContractError('Generation requires external model confirmation', 403);
      if (!input.expected_model_identity || !input.expected_plan_token) throw new ContractError('Refresh the knowledge model and plan before confirmation', 409);
      const next = await this.options.knowledge.requestAdmin<RepoWikiKnowledgeSnapshot>('admin.knowledge.start', { version: 1, requestId: input.request_id ?? randomUUID(),
        projectId, domain, language: context.language, intent: input.intent ?? (input.force ? 'regenerate' : 'generate'), confirmExternal: true,
        expectedModelIdentity: input.expected_model_identity, expectedPlanToken: input.expected_plan_token });
      if (!next.run) throw new ContractError('Knowledge task was not accepted', 503);
      return { run_id: next.run.taskId, task_id: next.run.taskId, status: next.run.state, target: domain };
    }
    if (this.options.tasks && (action === 'run' || action === 'cancel')) {
      const jobs = await this.projectTasks(context, action === 'run' ? input.target as string | undefined : undefined);
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
      if (action === 'run') {
        const job = jobs[0];
        if (job) return this.taskExecutions.get(job.id)?.latest ?? this.jobRun(job);
        // Previously generated content can still have a run snapshot predating AgentData integration.
        const prepared = await this.prepare(event, context), client = await this.ensureClient(prepared.roots);
        return client.invokeScoped('run', input as RequestMap['run'], { contextId: context.context_id });
      }
      const active = jobs.filter((job) => job.state === 'pending' || job.state === 'running');
      await Promise.all(active.map((job) => this.options.tasks!.requestAdmin('admin.jobs.cancel', { id: job.id })));
      return { ...(active[0] ? { run_id: active[0].id } : {}), status: active.length ? 'cancel_requested' : 'idle' };
    }
    if (action === 'cancel' || action === 'run') {
      if (!this.client || this.failedClient === this.client) throw new ContractError('RepoWiki child is unavailable', 503);
      const result = await this.client.invokeScoped(action, input as never, { contextId: context.context_id });
      this.assertCurrent(context); this.trusted(event);
      if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
      if (action === 'cancel') this.releaseContextLeases(context.context_id);
      return result;
    }
    const prepared = await this.prepare(event, context), client = await this.ensureClient(prepared.roots);
    this.assertCurrent(context); this.trusted(event);
    if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
    if (action === 'generate') {
      if (input.provider === 'demo') throw new ContractError('Demo generation is disabled in the host application', 403);
      if (input.confirm_external !== true) throw new ContractError('External generation requires explicit confirmation', 403);
      if (this.options.tasks) {
        const job = await this.options.tasks.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: prepared.workspace,
          metadata: { payload: { projectId: context.project_id, language: context.language, target: input.target ?? 'wiki', force: input.force === true, confirmExternal: true } } });
        return { run_id: job.id, task_id: job.id, status: job.state === 'pending' ? 'queued' : job.state, target: input.target ?? 'wiki' };
      }
      const pending = this.generating.get(context.context_id);
      if (pending) return pending;
      const promise = (async () => {
        const model = await this.options.resolveModel(prepared.workspace);
        this.assertCurrent(context); this.trusted(event);
        if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
        if (model.available === false) throw new ContractError('MODEL_UNAVAILABLE', 503);
        const leaseId = randomUUID(), release = client.registerModelLease(leaseId, { cacheKey: model.cacheKey, complete: model.complete });
        this.leases.set(leaseId, { contextId: context.context_id, projectId: context.project_id!, release });
        try {
          const result = await client.invokeScoped('generate', { ...input, provider: 'real' } as RequestMap['generate'], { contextId: context.context_id, modelLeaseId: leaseId });
          this.assertCurrent(context); this.trusted(event);
          const lease = this.leases.get(leaseId);
          if (lease) {
            lease.runId = result.run_id;
            if (this.terminalRuns.has(`${context.context_id}/${context.project_id}/${result.run_id}`)) { lease.release(); this.leases.delete(leaseId); }
          }
          return result;
        } catch (error) { release(); this.leases.delete(leaseId); throw error; }
      })();
      this.generating.set(context.context_id, promise);
      try { return await promise; } finally { if (this.generating.get(context.context_id) === promise) this.generating.delete(context.context_id); }
    }
    const result = await client.invokeScoped(action, input as never, { contextId: context.context_id });
    this.assertCurrent(context); this.trusted(event);
    if (!this.isApproved(context)) throw new ContractError('Host project approval was revoked', 403);
    return result;
  }
  private async projectTasks(context: HostActivation, target?: string): Promise<Job[]> {
    const jobs = await this.options.tasks!.requestAdmin<Job[]>('admin.jobs.list');
    return jobs.filter((job) => {
      const payload = job.metadata?.payload as Partial<RepoWikiJobPayload> | undefined;
      return job.kind === 'repoWiki.generate' && pathKey(job.workspace) === pathKey(context.workspace!)
        && payload?.projectId === context.project_id && payload.language === context.language && (!target || payload.target === target);
    }).sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  }
  private knowledgeRun(snapshot: RepoWikiKnowledgeSnapshot): ResponseMap['run'] {
    const run = snapshot.run;
    if (!run) return { status: 'idle', knowledge: snapshot };
    return { id: run.taskId, task_id: run.taskId, status: run.state, stage: run.phase,
      progress: run.state === 'completed' ? 100 : run.counts.planned ? Math.min(95, Math.round(90 * run.counts.prepared / run.counts.planned)) : 0,
      page_id: run.currentItem, message: run.error?.message, error: run.error?.code,
      completed_pages: run.counts.prepared, total_pages: run.counts.planned, cancelable: run.capabilities.cancel,
      target: snapshot.key.domain, knowledge: snapshot };
  }
  setKnowledgeEpoch(epoch: string): void { if (this.knowledgeEpoch !== epoch) this.canceledKnowledgeStages.clear(); this.knowledgeEpoch = epoch; }
  async drainKnowledgeWorker(_oldEpoch: string): Promise<void> {
    this.retireClient();
    await Promise.all([...this.stoppingClients]);
  }
  publishKnowledgeSnapshot(snapshot: RepoWikiKnowledgeSnapshot): void {
    if (this.disposed) return;
    const context = this.context;
    if (context.project_id !== snapshot.key.projectId || context.language !== snapshot.key.language || !this.isApproved(context)) return;
    const progress = { project_id: context.project_id!, context_id: context.context_id, time: new Date().toISOString(), run: this.knowledgeRun(snapshot), knowledge: snapshot };
    for (const record of this.recipients.values()) if (record.context === context) this.sendHostEvent(record.event, 'repoWiki://progress', progress);
  }
  private async knowledgeProject(projectId?: string, taskId?: string): Promise<{ projectId: string; workspace: string; language: string }> {
    const registered = projectId ? [...this.projects.values()].find(project => project.id === projectId) : undefined;
    let workspace = registered?.path, language = registered?.language;
    if (!workspace) {
      const jobs = await this.options.knowledge!.requestAdmin<Job[]>('admin.jobs.list');
      const job = jobs.find(job => taskId ? job.id === taskId : job.metadata?.repoWiki?.key.projectId === projectId);
      if (!job?.metadata?.repoWiki) throw new ContractError('Knowledge project is not registered', 403);
      workspace = job.workspace; language = job.metadata.repoWiki.key.language; projectId = job.metadata.repoWiki.key.projectId;
    }
    await this.refreshRoots(false);
    if (!this.roots.some(root => pathKey(root) === pathKey(workspace!))) throw new ContractError('Host project approval was revoked', 403);
    const actual = await realpath(workspace);
    if (pathKey(actual) !== pathKey(workspace)) throw new ContractError('Host workspace canonical path changed', 403);
    return { projectId: projectId!, workspace: actual, language: language! };
  }
  /** Internal AgentData-to-worker port. No renderer command accepts this method or a publish fence. */
  async invokeKnowledgeWorker(method: string, value: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed || !this.options.knowledge) throw new ContractError('Knowledge worker is unavailable', 503);
    if (method === 'stage.abort') { const fence=value.fence as ExecutionFence; if(typeof value.taskId!=='string'||!fence)throw new ContractError('Invalid stage scope',400); this.canceledKnowledgeStages.add(JSON.stringify([value.taskId,fence.ledgerId,fence.controllerEpoch,fence.ownerId,fence.generation])); await this.client?.abortStage(value as unknown as { taskId: string; fence: ExecutionFence }); return; }
    if (method === 'project.abortPrepare') return this.client?.invokeKnowledge(method, value);
    const key = value.key as { projectId?: string } | undefined;
    const candidate = typeof value.candidateId === 'string' ? this.knowledgeCandidates.get(value.candidateId) : undefined;
    const project = await this.knowledgeProject(typeof value.projectId === 'string' ? value.projectId : key?.projectId ?? candidate?.projectId,
      typeof value.taskId === 'string' ? value.taskId : undefined);
    const fence = value.fence as ExecutionFence | undefined;
    if (fence && this.knowledgeEpoch && fence.controllerEpoch !== this.knowledgeEpoch) throw new ContractError('STALE_EPOCH', 409);
    const client = await this.ensureClient([...this.roots]);
    if (!this.knowledgeHydrated.has(project.projectId)) {
      const loaded = await client.invokeScoped('create', { path: project.workspace, language: project.language }, { contextId: `knowledge-${project.projectId}` });
      if (loaded.id !== project.projectId) throw new ContractError('Knowledge project identity changed', 409);
      this.projects.set(namespaceKey(project.workspace, project.language), loaded); this.knowledgeHydrated.add(project.projectId);
    }
    if (fence && this.knowledgeEpoch && fence.controllerEpoch !== this.knowledgeEpoch) throw new ContractError('STALE_EPOCH', 409);
    if (method === 'stage.execute' && fence && this.canceledKnowledgeStages.has(JSON.stringify([value.taskId,fence.ledgerId,fence.controllerEpoch,fence.ownerId,fence.generation]))) throw new Error('aborted');
    const stageKey = method === 'stage.execute' ? knowledgeExecutionKey(value as unknown as KnowledgeExecutionScope) : undefined;
    const stage = stageKey ? { taskId: String(value.taskId), projectId: project.projectId, workspace: project.workspace, fence: value.fence as ExecutionFence } : undefined;
    if (stageKey && stage) { if (this.knowledgeStages.has(stageKey)) throw new ContractError('Duplicate stage execution', 409); this.knowledgeStages.set(stageKey, stage); }
    try {
      const result = await client.invokeKnowledge(method, value);
      if (method === 'project.preparePublication' && result && typeof result === 'object' && 'candidateId' in result)
        this.knowledgeCandidates.set(String(result.candidateId), { projectId: project.projectId, workspace: project.workspace });
      if (method === 'project.commitPublication' && typeof value.candidateId === 'string') this.knowledgeCandidates.delete(value.candidateId);
      return result;
    } finally { if (stageKey && this.knowledgeStages.get(stageKey) === stage) this.knowledgeStages.delete(stageKey); }
  }
  private jobRun(job: Job): ResponseMap['run'] {
    const metadata = job.metadata as Record<string, unknown> | undefined;
    const payload = metadata?.payload as Partial<RepoWikiJobPayload> | undefined;
    return { id: job.id, task_id: job.id, status: job.state === 'pending' ? 'queued' : job.state === 'cancelled' ? 'canceled' : job.state,
      progress: job.progress, stage: typeof metadata?.stage === 'string' ? metadata.stage : job.state === 'pending' ? 'queued' : job.state,
      target: payload?.target, cancelable: ['pending', 'running'].includes(job.state),
      ...(typeof metadata?.processed === 'number' ? { completed_pages: metadata.processed } : {}),
      ...(typeof metadata?.total === 'number' ? { total_pages: metadata.total } : {}),
      message: typeof metadata?.message === 'string' ? metadata.message : job.error,
      ...(job.error ? { error: job.error } : {}), ...(typeof metadata?.currentPage === 'string' ? { current_page: metadata.currentPage } : {}) };
  }
  /** Called only by the trusted AgentData runner; this scope outlives every renderer view. */
  runTask(input: RepoWikiTaskInput): Promise<{ cancelled: boolean }> {
    const existing = this.taskExecutions.get(input.id);
    if (existing) return existing.done;
    if (this.disposed || !this.options.tasks) return Promise.reject(new ContractError('RepoWiki task service is unavailable', 503));
    const payload = input.payload;
    if (!input.id || !payload || payload.confirmExternal !== true || !payload.projectId
      || !['wiki', 'cards'].includes(payload.target) || !/^[A-Za-z][A-Za-z0-9-]{0,19}$/.test(payload.language))
      return Promise.reject(new ContractError('Invalid persistent RepoWiki task', 403));
    let resolve!: TaskExecution['resolve'], reject!: TaskExecution['reject'];
    const done = new Promise<{ cancelled: boolean }>((yes, no) => { resolve = yes; reject = no; });
    const task: TaskExecution = { ...input, contextId: `task-${input.id}`, done, resolve, reject, revision: 0, updates: Promise.resolve() };
    this.taskExecutions.set(input.id, task);
    // The engine has one writer per namespace. Different namespaces may share the model scheduler.
    const key = namespaceKey(input.workspace, payload.language), previous = this.taskTails.get(key) ?? Promise.resolve();
    task.updates = this.options.tasks.requestAdmin('admin.jobs.stage', { id: task.id, stage: '排队等待',
      message: this.taskTails.has(key) ? '等待本项目的上一项生成任务完成' : '正在准备 Repo Wiki 生成任务' }).then(() => {})
      .catch((error) => this.settleTask(task, undefined, error));
    const tail = previous.catch(() => {}).then(async () => { await task.updates; return this.startTask(task); })
      .catch((error) => this.settleTask(task, undefined, error));
    const completed = tail.then(() => done).catch(() => {});
    this.taskTails.set(key, completed);
    void completed.finally(() => { if (this.taskTails.get(key) === completed) this.taskTails.delete(key); });
    void done.finally(() => {
      this.taskExecutions.delete(input.id); clearTimeout(task.timer); task.release?.();
    }).catch(() => {});
    return done;
  }
  private async startTask(task: TaskExecution): Promise<void> {
    if (this.disposed || task.settled) return;
    if (task.cancelRequested) { this.settleTask(task, { cancelled: true }); return; }
    await this.refreshRoots(false);
    if (!this.roots.some((root) => pathKey(root) === pathKey(task.workspace))) throw new ContractError('Host project approval was revoked', 403);
    const actual = await realpath(task.workspace).catch(() => { throw new ContractError('Workspace is unavailable', 404); });
    if (pathKey(actual) !== pathKey(task.workspace)) throw new ContractError('Host workspace canonical path changed; reopen the project', 403);
    if (this.options.isConversationWorkspace && await this.options.isConversationWorkspace(actual)) throw new ContractError('Conversation workspaces cannot run RepoWiki tasks', 403);
    if (this.failedClient) this.retireClient();
    const client = await this.ensureClient([...this.roots]); task.client = client;
    const project = await client.invokeScoped('create', { path: actual, language: task.payload.language }, { contextId: task.contextId });
    if (this.disposed || task.settled) return;
    if (project.id !== task.payload.projectId) throw new ContractError('RepoWiki project identity changed; start a new generation task', 409);
    const model = await this.options.resolveModel(actual);
    if (this.disposed || task.settled) return;
    if (model.available === false) throw new ContractError('MODEL_UNAVAILABLE', 503);
    if (task.expectedModel && model.model !== task.expectedModel) throw new ContractError('MODEL_CHANGED', 409);
    if (task.cancelRequested) { this.settleTask(task, { cancelled: true }); return; }
    const leaseId = randomUUID(); task.release = client.registerModelLease(leaseId, { cacheKey: model.cacheKey, complete: model.complete });
    task.started = true;
    const result = await client.invokeScoped('generate', { project_id: project.id, provider: 'real', target: task.payload.target,
      force: task.payload.force, confirm_external: true, resume_run_id: task.id }, { contextId: task.contextId, modelLeaseId: leaseId });
    if (terminalRun(result.status)) await this.updateTask(task, { id: task.id, status: result.status, target: task.payload.target });
    if (!task.settled) this.pollTask(task);
    if (task.cancelRequested && !task.settled) await this.cancelTask({ id: task.id, ...(task.paused ? { pause: true } : {}) });
  }
  private pollTask(task: TaskExecution): void {
    task.timer = setTimeout(() => {
      if (task.settled || this.disposed) return;
      const revision = task.revision;
      void task.client!.invokeScoped('run', { project_id: task.payload.projectId, target: task.payload.target }, { contextId: task.contextId })
        .then((run) => { if (revision === task.revision) return this.updateTask(task, run); })
        .then(() => { if (!task.settled) this.pollTask(task); })
        .catch((error) => this.settleTask(task, undefined, error));
    }, 2000);
    task.timer.unref();
  }
  async cancelTask(input: { id: string; pause?: boolean }): Promise<void> {
    const task = this.taskExecutions.get(input.id);
    if (!task || task.settled) return;
    task.cancelRequested = true; task.paused = input.pause === true;
    if (!task.started || !task.client) { this.settleTask(task, { cancelled: true }); return; }
    await task.client.invokeScoped('cancel', { project_id: task.payload.projectId, ...(task.paused ? { pause: true } : {}) }, { contextId: task.contextId });
    // The terminal event/poll, rather than the cancellation acknowledgement, settles the runner.
    await task.done;
  }
  private updateTask(task: TaskExecution, run: ResponseMap['run']): Promise<void> {
    if (task.settled || run.id !== task.id) return task.updates;
    task.updates = task.updates.then(async () => {
      if (task.settled) return;
      task.latest = { ...run, task_id: task.id };
      const stages: Record<string, string> = { queued: '排队等待', scanning: '正在扫描', planning: '正在规划', generating: '正在生成',
        validating: '正在校验', committing: '正在发布', completed: '已完成', interrupted: '正在恢复' };
      await this.options.tasks!.requestAdmin('admin.jobs.stage', { id: task.id, stage: stages[run.stage ?? run.status] ?? '正在生成',
        ...(typeof run.progress === 'number' ? { progress: Math.max(0, Math.min(100, Math.round(run.progress))) } : {}),
        ...(typeof run.message === 'string' ? { message: run.message.slice(0, 1000) } : {}),
        ...(typeof run.page_id === 'string' ? { currentPage: run.page_id.slice(0, 500) } : typeof run.current_page === 'string' ? { currentPage: run.current_page.slice(0, 500) } : {}),
        ...(Number.isSafeInteger(run.completed_pages) && Number.isSafeInteger(run.total_pages) && Number(run.completed_pages) >= 0 && Number(run.total_pages) >= Number(run.completed_pages)
          ? { processed: run.completed_pages, total: run.total_pages } : {}) });
      const context = this.context;
      if (context.project_id === task.payload.projectId && context.language === task.payload.language && context.workspace
        && pathKey(context.workspace) === pathKey(task.workspace) && this.isApproved(context)) {
        const event: ProgressEvent = { project_id: context.project_id, context_id: context.context_id, run: task.latest, time: new Date().toISOString() };
        for (const record of this.recipients.values()) if (record.context === context) this.sendHostEvent(record.event, 'repoWiki://progress', event);
      }
      if (run.status === 'completed') this.settleTask(task, { cancelled: false });
      else if (run.status === 'canceled' || run.status === 'cancelled' || (run.status === 'interrupted' && task.paused)) this.settleTask(task, { cancelled: true });
      else if (terminalRun(run.status)) this.settleTask(task, undefined, new Error(String(run.error ?? run.message ?? 'RepoWiki generation failed')));
    });
    // A lost ledger write must fail visibly; never report an unrecorded completion as success.
    void task.updates.catch((error) => this.settleTask(task, undefined, error));
    return task.updates;
  }
  private settleTask(task: TaskExecution, result?: { cancelled: boolean }, error?: unknown): void {
    if (task.settled) return;
    task.settled = true; clearTimeout(task.timer); task.release?.();
    if (error) task.reject(error); else task.resolve(result ?? { cancelled: false });
  }
  private ensureClient(roots: string[]): Promise<RepoWikiProcessClient> {
    const key = JSON.stringify(roots.map(pathKey));
    const next = this.transition.then(async () => {
      if (this.disposed) throw new ContractError('RepoWiki service is stopped', 503);
      if (!roots.length) throw new ContractError('No approved host workspace is available', 403);
      if (this.client && this.clientRootsKey === key) {
        if (this.failedClient === this.client) throw new ContractError('RepoWiki child is unavailable; explicitly retry to recover', 503);
        return this.client;
      }
      if (this.client && this.options.knowledge && this.failedClient !== this.client) {
        await this.client.invokeKnowledge('host.updateRoots', { roots }); this.clientRootsKey = key; return this.client;
      }
      this.retireClient(); await Promise.all(this.stoppingClients);
      if (this.disposed) throw new ContractError('RepoWiki service is stopped', 503);
      const client = new RepoWikiProcessClient({ ...this.options.processOptions, entry: this.options.entry, dataDir: this.options.dataDir,
        env: { REPOWIKI_EMBEDDED: '1' }, allowedRoots: roots });
      this.client = client; this.clientRootsKey = key; this.currentInstance = undefined;
      if (this.options.knowledge) client.setKnowledgeRequestHandler(async (kind, input, signal) => {
        const request = input as { requestId?: string; taskId?: string; fence?: ExecutionFence };
        if (request.fence?.controllerEpoch !== this.knowledgeEpoch) throw new ContractError('STALE_EPOCH', 409);
        const project = await this.knowledgeProject(undefined, request.taskId);
        if (kind === 'model') { const actual = await realpath(project.workspace); if (pathKey(actual) !== pathKey(project.workspace)) throw new ContractError('Host workspace canonical path changed', 403); }
        const abort = () => { if (request.requestId) void this.options.knowledge!.requestAdmin('admin.knowledge.abort', { requestId: request.requestId }).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        try { return await this.options.knowledge!.requestAdmin('admin.knowledge.worker', { kind, input }); }
        finally { signal.removeEventListener('abort', abort); }
      });
      client.onLifecycle((state) => {
        if (this.disposed || this.client !== client) return;
        if (state.status === 'crashed') {
          for (const task of this.taskExecutions.values()) if (task.client === client)
            this.settleTask(task, undefined, new ContractError('RepoWiki worker crashed; generation checkpoint is retained', 503));
          this.currentInstance = undefined; this.revokeContext(); this.notifyWorkspaces();
        }
        else if (state.status === 'failed') { this.failedClient = client; this.notifyWorkspaces(); }
        else if (state.status === 'ready') this.failedClient = undefined;
      });
      client.subscribe((event) => { void this.progress(client, event).catch((error) => this.options.onError?.(error)); });
      try { await client.start(); }
      catch (error) { if (this.client === client) { this.failedClient = client; this.notifyWorkspaces(); } throw error; }
      return client;
    });
    this.transition = next.catch(() => {}); return next;
  }
  private async progress(client: RepoWikiProcessClient, event: ProgressEvent): Promise<void> {
    const task = event.run.id ? this.taskExecutions.get(event.run.id) : undefined;
    if (task && client === task.client && client === this.client && event.context_id === task.contextId && event.project_id === task.payload.projectId) {
      if (event.sequence !== undefined && task.sequence !== undefined && event.sequence <= task.sequence) return;
      task.sequence = event.sequence;
      task.revision += 1;
      await this.updateTask(task, event.run);
      return;
    }
    const context = this.context;
    if (this.disposed || client !== this.client || event.context_id !== context.context_id || event.project_id !== context.project_id) return;
    if (event.instance_id && this.currentInstance && event.instance_id !== this.currentInstance) return;
    if (event.instance_id) this.currentInstance = event.instance_id;
    if (terminalRun(event.run.status) && event.run.id) {
      this.terminalRuns.add(`${context.context_id}/${event.project_id}/${event.run.id}`);
      if (this.terminalRuns.size > 1000) this.terminalRuns.delete(this.terminalRuns.values().next().value!);
    }
    await this.refreshRoots(false);
    if (context !== this.context || client !== this.client || !this.isApproved(context)) return;
    if (terminalRun(event.run.status) && event.run.id) for (const [id, lease] of this.leases) {
      if (lease.contextId === context.context_id && lease.projectId === event.project_id && lease.runId === event.run.id) { lease.release(); this.leases.delete(id); }
    }
    for (const record of this.recipients.values()) if (record.context === context) this.sendHostEvent(record.event, 'repoWiki://progress', event);
  }
  private retireClient(): void {
    const previous = this.client;
    for (const task of this.taskExecutions.values()) if (previous && task.client === previous && !task.settled)
      this.settleTask(task, undefined, new ContractError('RepoWiki worker stopped; generation checkpoint is retained', 503));
    this.client = undefined; this.clientRootsKey = undefined; this.failedClient = undefined; this.currentInstance = undefined;
    this.knowledgeHydrated.clear(); this.knowledgeCandidates.clear();
    for (const lease of this.leases.values()) lease.release();
    this.leases.clear();
    if (!previous) return;
    const stopping = previous.stop(); this.stoppingClients.add(stopping);
    void stopping.finally(() => this.stoppingClients.delete(stopping)).catch((error) => this.options.onError?.(error));
  }
  async onHostProjectsChanged(): Promise<void> {
    if (this.disposed) return;
    const revision = this.snapshot.revision;
    await this.refreshRoots(false);
    const removed = !!this.context.workspace && !this.isApproved(this.context)
      && (this.context.status === 'bound' || this.context.project_id !== null);
    const changedChildRoots = !!this.client && this.clientRootsKey !== this.rootsKey;
    if (this.options.knowledge && changedChildRoots && this.client) {
      await this.client.invokeKnowledge('host.updateRoots', { roots: this.roots }); this.clientRootsKey = this.rootsKey;
      const revoked = new Map<string, { taskId: string; fence: ExecutionFence }>();
      for (const stage of this.knowledgeStages.values()) if (!this.roots.some(root => pathKey(root) === pathKey(stage.workspace))) revoked.set(JSON.stringify([stage.taskId, stage.fence]), { taskId: stage.taskId, fence: stage.fence });
      await Promise.all([...revoked.values()].map(stage => this.client!.abortStage(stage))); 
      if (removed) this.revokeContext();
      if (revision !== this.snapshot.revision || removed) this.notifyWorkspaces();
      return;
    }
    if (removed || changedChildRoots) this.revokeContext();
    if (changedChildRoots) this.retireClient();
    if (revision !== this.snapshot.revision || removed || changedChildRoots) this.notifyWorkspaces();
  }
  async refreshConfiguration(): Promise<void> {
    if (!this.client || this.disposed) return;
    await this.onHostProjectsChanged();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.disposed = true;
    for (const task of this.taskExecutions.values()) this.settleTask(task, undefined, new ContractError('RepoWiki service stopped; generation checkpoint is retained', 503));
    if (this.poll) clearInterval(this.poll);
    for (const remove of this.removers) remove();
    this.recipients.clear(); this.retireClient();
    this.stopping = (async () => { await this.transition; this.retireClient(); await Promise.all(this.stoppingClients); })();
    return this.stopping;
  }
}
