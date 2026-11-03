import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDataStorage } from './storage';
import { ThreadStore } from './threadStore';
import { WikiService } from './wikiEngine/service';
import type { CompleteOptions, KnowledgeCompletionInput } from './wikiEngine/llm';
export type { KnowledgeCompletionInput } from './wikiEngine/llm';
import { TaskViewStore } from './taskViewStore';
import { TaskViewService } from '../app/taskViewService';
import { AuditViewStore } from './auditViewStore';
import { AgentDataDiagnostics } from '../app/agentDataDiagnostics';
import type { AuditQuery, DiagnosticReport, JobMetadata, TaskListInput, TaskRef, TaskRetryOptions, WorkbenchOverview } from './operationsContracts';
import { JobStore, parseJobMetadata, parseRepoWikiJobPayload, type Job } from './jobStore';
import { ServiceTaskRegistry } from '../app/appServer/serviceTaskRegistry';
import { TaskQueue, type QueueTaskInput } from '../app/appServer/taskQueue';
import type { ServiceTask, ServiceTaskHooks } from '../app/appServer/types';
import { isRpcRequest, PROTOCOL_VERSION, RpcError, type AgentDataEndpoint, type RpcResponse } from './protocol';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from './codeRetrievalProtocol';
import { RequestFrameDecoder } from './requestFrames';
import { agentDataTiming } from './methodTiming';
import { PluginStateStore } from '../app/plugin/pluginStateStore';
import { ToolAuditStore } from '../app/toolPermission/auditStore';
import { ToolRuleStore } from '../app/toolPermission/ruleStore';
import { ToolDecisionService } from '../app/toolPermission/toolDecisionService';
import { toolPermissionMethods } from '../app/toolPermission/rpc';

import { createKnowledgeKernelRuntime, type KnowledgeKernelRuntimePorts } from './knowledgeKernel/runtimeBridge';
export type AgentDataMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;

const SYSTEM_METHODS = new Set(['system.hello', 'system.status', 'system.shutdown']);
const JOB_ADMIN_METHODS = new Set(['admin.jobs.get', 'admin.jobs.start', 'admin.jobs.complete', 'admin.jobs.fail', 'admin.jobs.markCancelled']);

export interface AgentDataJobRunner {
  run(jobId: string, workspace: string, expectedModel?: string, payload?: JobMetadata['payload']): Promise<void>;
  cancel(jobId: string): void | Promise<void>;
}

export interface AgentDataCodeRetrievalProvider {
  projects(): Array<{ workspace: string; indexed: boolean }>;
  status(workspace: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  search(workspace: string, query: string, limit: number): Promise<Record<string, unknown>>;
  call?(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentDataRuntimeOptions {
  dataPath: string;
  wikiRootDir?: string;
  methods?: Record<string, AgentDataMethod>;
  stdin?: NodeJS.ReadableStream;
  /** hooks.onUsage 由执行器在每次模型调用后回报用量，落到 service_tasks 的 token 列。 */
  executeServiceTask?: (task: ServiceTask, hooks?: ServiceTaskHooks) => Promise<unknown>;
  /** 按 job kind 注册的执行器：创建即派发，取消时通知。未注册的 kind 只落库。 */
  jobRunners?: Record<string, AgentDataJobRunner>;
  codeRetrieval?: AgentDataCodeRetrievalProvider;
  /** Injected model short-call for Wiki ingest; tests pass a stub. */
  completeSimple?: (input: { systemPrompt?: string; user: string } & CompleteOptions) => Promise<string>;
  describeModel?: () => Promise<string>;
  /** Resolves whether a session is currently owned by the endpoint workspace. */
  resolveSession?: (workspace: string, sessionId: string) => boolean | Promise<boolean>;
  /**
   * 监听命名管道（Windows `\\.\pipe\…`）或 Unix socket 路径，而不是环回 TCP 的随机端口。
   * 运行在子进程里时由主进程指定：崩溃重拉后路径不变，扩展缓存的端点仍然有效。
   */
  listenPath?: string;
  /** 由宿主生成的 host 令牌（同上，重拉后不变）。不传时自己生成。 */
  hostToken?: string;
  /** 重拉时带回的工作区令牌：规范化后的工作区 → 令牌。 */
  workspaceTokens?: Record<string, string>;
  knowledge?: Omit<KnowledgeKernelRuntimePorts, 'withModelSlot'>;
}

export class AgentDataRuntime {
  private server?: Server;
  private storage?: AgentDataStorage;
  private endpoint?: AgentDataEndpoint;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private inFlight = 0;
  private readonly token: string;
  private wiki?: WikiService;
  private taskViews?: TaskViewStore;
  private taskService?: TaskViewService;
  private auditViews?: AuditViewStore;
  private diagnostics?: AgentDataDiagnostics;
  private diagnosticReport?: DiagnosticReport;
  private readonly projectTokens = new Map<string, string>();
  private readonly workspaceTokens = new Map<string, string>();
  private readonly closeWaiters: Array<() => void> = [];
  private jobs?: JobStore;
  private threads?: ThreadStore;
  private taskQueue?: TaskQueue;
  private readonly knowledgeCalls = new Map<string, AbortController>();
  private temporaryWikiRoot?: string;
  private toolPermission?: ToolDecisionService;
  private knowledgeRuntime?: ReturnType<typeof createKnowledgeKernelRuntime>;
  private knowledgeClosing?: Promise<void>;

  constructor(private readonly options: AgentDataRuntimeOptions) {
    this.token = options.hostToken ?? randomBytes(32).toString('hex');
    for (const [workspace, token] of Object.entries(options.workspaceTokens ?? {})) this.adoptWorkspaceToken(workspace, token);
  }

  async start(): Promise<AgentDataEndpoint> {
    if (this.endpoint) return this.endpoint;
    this.storage = new AgentDataStorage(this.options.dataPath);
    this.storage.migrate();
    this.toolPermission = new ToolDecisionService(
      new ToolRuleStore(this.storage.db),
      new ToolAuditStore(this.storage.db),
    );
    // Old Wiki calls have no live publisher after a process restart. Keep their
    // history but require explicit ingest/retry instead of replaying a model.
    this.storage.db.prepare("UPDATE service_tasks SET status='failed',error='WIKI_TASK_INTERRUPTED: runtime restarted',updated_at=? WHERE kind='wiki_page_generate' AND status IN ('queued','running')").run(Date.now());
    if (this.options.executeServiceTask) {
      this.taskQueue = new TaskQueue({
        storage: this.storage,
        registry: new ServiceTaskRegistry(),
        execute: this.options.executeServiceTask,
      });
      this.taskQueue.recoverRunning();
    }
    const wikiRoot = this.options.wikiRootDir ?? (this.options.dataPath === ':memory:'
      ? (this.temporaryWikiRoot = mkdtempSync(join(tmpdir(), 'agent-data-wiki-')))
      : join(dirname(resolve(this.options.dataPath)), 'wiki'));
    this.jobs = new JobStore(this.storage.db);
    this.settleOrphanJobs();
    this.wiki = new WikiService({
      root: wikiRoot,
      db: this.storage.db,
      describeModel: this.options.describeModel,
      complete: async (system, prompt, _label, options) => {
        if (!this.options.completeSimple) throw new Error('MODEL_UNAVAILABLE: no Wiki model is configured');
        return this.options.completeSimple({ systemPrompt: system, user: prompt, ...options });
      },
    });
    if (this.options.knowledge) {
      this.knowledgeRuntime = createKnowledgeKernelRuntime(this.storage.db, { ...this.options.knowledge,
        withModelSlot: (work, signal) => this.wiki!.withKnowledgeModelSlot(work, signal) });
      void this.knowledgeRuntime.ready.catch(error => console.error('KnowledgeKernel initialization failed', error));
    }
    this.taskViews = new TaskViewStore(this.storage.db);
    this.taskService = new TaskViewService({ views: this.taskViews, jobs: this.jobs,
      readTarget: (job) => this.readTaskTarget(job), dispatch: (job, metadata, options) => this.retryTask(job, metadata, options),
      canCancel: (job) => Boolean(this.options.jobRunners?.[job.kind]),
      describeModel: () => this.describeKnowledgeModel(),
      ...(this.knowledgeRuntime ? {
        readKnowledgeSnapshot: (job: Job) => this.knowledgeRuntime!.coordinator.snapshotForTask(job),
        previewKnowledgeRetry: async (job: Job) => {
          const key = job.metadata!.repoWiki!.key;
          const snapshot = await this.knowledgeRuntime!.coordinator.prepare(key.projectId, key.domain);
          return { model: snapshot.admission.modelDisplayName, modelIdentity: snapshot.admission.modelIdentity, planToken: snapshot.admission.planToken };
        },
        actKnowledgeTask: async (job: Job, options?: { expectedModel?: string; expectedModelIdentity?: string; expectedPlanToken?: string }) => {
          const key = job.metadata!.repoWiki!.key;
          const preview = await this.knowledgeRuntime!.coordinator.prepare(key.projectId, key.domain);
          if (!options || options.expectedModel !== preview.admission.modelDisplayName || options.expectedModelIdentity !== preview.admission.modelIdentity) throw new Error('MODEL_CHANGED');
          if (options.expectedPlanToken !== preview.admission.planToken) throw new Error('PLAN_CHANGED');
          const snapshot = await this.knowledgeRuntime!.coordinator.act({ version: 1, requestId: randomUUID(), taskId: job.id,
            expectedRevision: job.metadata!.repoWiki!.revision, action: 'repair', confirmExternal: true,
            expectedModelIdentity: options.expectedModelIdentity!, expectedPlanToken: options.expectedPlanToken! });
          if (!snapshot.run) throw new Error('TASK_NOT_FOUND');
          return this.jobs!.get(snapshot.run.taskId)!;
        },
      } : {}),
    });
    this.auditViews = new AuditViewStore(this.storage.db);
    this.diagnostics = new AgentDataDiagnostics({
      codeProjects: () => this.options.codeRetrieval?.projects() ?? [], codeStatus: (workspace) => this.options.codeRetrieval?.status(workspace) ?? {},
    });
    this.threads = new ThreadStore(this.storage);
    this.server = createServer((socket) => this.handleSocket(socket));
    const listenPath = this.options.listenPath;
    if (listenPath) {
      await listenWithRetry(this.server, listenPath);
      this.options.stdin?.once('end', () => this.handleStdinEnd());
      this.endpoint = { host: '', port: 0, path: listenPath, token: this.token };
      this.resumeKnowledgeKernel(); this.resumeRepoWikiJobs();
      return this.endpoint;
    }
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('agent data server address unavailable');
    this.options.stdin?.once('end', () => this.handleStdinEnd());
    this.endpoint = { host: '127.0.0.1', port: address.port, token: this.token };
    this.resumeKnowledgeKernel(); this.resumeRepoWikiJobs();
    return this.endpoint;
  }

  /**
   * 执行器（jobRunners）都在本进程里：启动时还是 pending / running 的这类任务，执行它的是上一个进程，已经没有人在跑。
   * 请求过取消的记为已取消，其余记为失败（可重试）。不收尾的话它们永远占着「运行中」：新的同类任务报
   * JOB_ALREADY_RUNNING，取消永远等不到确认，删除和重试也不可用。没有执行器的种类只落库、不归本进程管，不动。
   */
  private settleOrphanJobs(): void {
    for (const job of [...this.jobs!.list('pending'), ...this.jobs!.list('running')]) {
      if (!this.options.jobRunners?.[job.kind]) continue;
      if (job.kind === 'repoWiki.generate') continue;
      if (job.metadata?.cancellationRequested) this.jobs!.cancel(job.id);
      else this.jobs!.fail(job.id, 'JOB_INTERRUPTED: 应用重启时任务仍在运行，已中断');
    }
  }

  /** Repo Wiki checkpoints make an acknowledged request resumable; other job kinds retain their interruption policy. */
  private resumeRepoWikiJobs(): void {
    if (this.knowledgeRuntime) return;
    const runner = this.options.jobRunners?.['repoWiki.generate'];
    if (!runner) return;
    for (const job of [...this.jobs!.list('pending'), ...this.jobs!.list('running')]) {
      if (job.kind !== 'repoWiki.generate') continue;
      if (job.metadata?.cancellationRequested) {
        this.inFlight += 1;
        void Promise.resolve().then(() => runner.cancel(job.id)).then(() => this.jobs!.cancel(job.id))
          .catch((error) => this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error)))
          .finally(() => { this.inFlight -= 1; this.finishClose(); });
      } else if (!parseRepoWikiJobPayload(job.metadata?.payload)) {
        this.jobs!.fail(job.id, 'INVALID_PARAMS: 已保存的 Repo Wiki 生成确认或参数缺失');
      } else {
        this.jobs!.recordStage(job.id, '正在恢复');
        this.dispatchJob(job);
      }
    }
  }
  private resumeKnowledgeKernel(): void {
    if (!this.knowledgeRuntime) return;
    void this.knowledgeRuntime.ready.then(async () => {
      if (this.closed) return;
      for (const job of this.jobs!.list()) if (job.kind === 'repoWiki.generate' && !job.metadata?.repoWiki && ['pending', 'running'].includes(job.state)) {
        if (job.metadata?.cancellationRequested) this.jobs!.cancel(job.id);
        else this.storage!.db.prepare("UPDATE agent_jobs SET state='blocked',error=?,updated_at=? WHERE id=?").run('CONFIRMATION_REQUIRED: 旧任务缺少可验证的模型与阶段身份，请在 Repo Wiki 重新确认生成', Date.now(), job.id);
      }
      await this.knowledgeRuntime!.coordinator.recoverPending();
    }).catch(error => console.error('KnowledgeKernel recovery failed', error));
  }
  async closeKnowledge(): Promise<void> {
    this.knowledgeClosing ??= this.knowledgeRuntime?.close() ?? Promise.resolve();
    await this.knowledgeClosing;
  }
  knowledgeControllerEpoch(): string | undefined { return this.options.knowledge?.controllerEpoch; }

  handleStdinEnd(): void { this.close(); }
  isClosed(): boolean { return this.closed; }
  getEndpoint(): AgentDataEndpoint | undefined { return this.endpoint; }

  agentEndpoint(workspace: string): AgentDataEndpoint {
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    const key = normalizeWorkspace(workspace);
    let token = this.workspaceTokens.get(key);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.workspaceTokens.set(key, token);
      this.projectTokens.set(token, key);
    }
    return { ...this.endpoint, token };
  }

  /**
   * 采用宿主签发的工作区令牌（子进程模式）。同一工作区已有不同令牌时拒绝：令牌发出去就不能换。
   * 返回规范化后的工作区。
   */
  adoptWorkspaceToken(workspace: string, token: string): string {
    if (typeof token !== 'string' || !/^[0-9a-f]{32,128}$/.test(token)) throw new Error('invalid workspace token');
    const key = normalizeWorkspace(workspace);
    const existing = this.workspaceTokens.get(key);
    if (existing && existing !== token) throw new Error('workspace token already issued');
    const owner = this.projectTokens.get(token);
    if ((owner && owner !== key) || token === this.token) throw new Error('workspace token collides');
    this.workspaceTokens.set(key, token);
    this.projectTokens.set(token, key);
    return key;
  }

  /** Trusted main-process entry. No socket method can select this context. */
  async requestAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    if ((!this.endpoint || this.closed) && !(this.knowledgeClosing && ['admin.knowledge.worker', 'admin.knowledge.abort'].includes(name))) throw new Error('agent data runtime is not started');
    this.inFlight += 1;
    const begun = performance.now();
    let label = 'admin.unknown';
    let syncMs = 0;
    let stop = agentDataTiming.start();
    try {
      const method = this.knowledgeRuntime && name.startsWith('admin.knowledge.')
        ? (params: Record<string, unknown>) => this.knowledgeRuntime!.request(name, params)
        : this.operationsMethod(name) ?? this.wikiMethod(name, 'admin') ?? this.adminMethod(name, true);
      if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown management method: ${name}`);
      label = name;
      const pending = method(params);
      syncMs += stop();
      try { return await pending as T; } finally { stop = agentDataTiming.start(); }
    } catch (error) {
      if (error instanceof RpcError) throw new Error(`${error.code}: ${error.message}`);
      throw error;
    } finally {
      syncMs += stop();
      agentDataTiming.record(label, syncMs, { totalMs: performance.now() - begun, nested: agentDataTiming.nested });
      this.inFlight -= 1; this.finishClose();
    }
  }

  private authorized(token: string): boolean { return token === this.token || this.projectTokens.has(token); }

  async resolveDiagnosticPath(id: string): Promise<string> {
    if (!this.diagnostics || this.closed) throw new Error('runtime is not started');
    return this.diagnostics.resolveOpenPath(id);
  }

  /**
   * 同进程执行器（CodeGraphJobs）回写任务状态的入口，等价于经 socket 调用同名的 admin.jobs.* 方法，不绕 TCP。
   * 只放行任务生命周期的几个方法。
   */
  async requestJobAdmin<T = unknown>(name: string, params: Record<string, unknown>): Promise<T> {
    if (!JOB_ADMIN_METHODS.has(name)) throw new Error(`not a job lifecycle method: ${name}`);
    if (!this.endpoint || this.closed || !this.jobs) throw new Error('agent data runtime is not started');
    const method = this.adminMethod(name);
    if (!method) throw new Error(`not a job lifecycle method: ${name}`);
    return await method(params) as T;
  }

  /** plugin_state 表的读写（子进程模式下主进程的 PluginManager 经 RPC 用它）。 */
  pluginStateStore(): PluginStateStore {
    if (!this.storage || this.closed) throw new Error('agent data runtime is not started');
    return new PluginStateStore(this.storage.db);
  }

  /** 自动同步熔断。写成失败任务，不启动执行器。 */
  recordCodegraphBreaker(event: { workspace: string; message: string }): void {
    if (!this.jobs || this.closed || !event.workspace) return;
    this.jobs.recordBreaker(event.workspace, event.message);
  }

  recordJobStage(id: string, stage: string, processed?: number, total?: number): void {
    if (!this.jobs || this.closed) return;
    this.jobs.recordStage(id, stage, processed === undefined || total === undefined ? undefined : { processed, total });
  }

  private operationsMethod(name: string): AgentDataMethod | undefined {
    if (!this.taskService || !this.auditViews || !this.diagnostics) return undefined;
    if (name === 'admin.tasks.list') return (p) => this.taskService!.list(p as TaskListInput);
    if (name === 'admin.tasks.read') return (p) => this.taskService!.read(readTaskRef(p));
    if (name === 'admin.tasks.previewRetry') return (p) => this.taskService!.previewRetry(readTaskRef(p));
    if (name === 'admin.tasks.retry') return (p) => this.taskService!.retry(readTaskRef(p), { expectedModel: p.expectedModel === undefined ? undefined : readString(p.expectedModel) });
    if (name === 'admin.audit.query') return (p) => this.auditViews!.query(p as AuditQuery);
    if (name === 'admin.audit.export') return (p) => this.auditViews!.export(p as AuditQuery);
    if (name === 'admin.diagnostics.check') return async () => (this.diagnosticReport = await this.diagnostics!.check());
    if (name === 'admin.overview') return () => this.workbenchOverview();
    return undefined;
  }

  private async readTaskTarget(job: Job): Promise<{ exists: boolean; busy: boolean }> {
    if (this.knowledgeRuntime && job.metadata?.repoWiki) {
      try {
        const view = await this.knowledgeRuntime.coordinator.snapshotForTask(job);
        return { exists: view.admission.state !== 'blocked', busy: this.jobs!.list().some(other => other.id !== job.id && other.metadata?.repoWiki
          && ['pending', 'running', 'paused', 'blocked'].includes(other.state) && this.sameJobTarget(other, job)) };
      } catch { return { exists: false, busy: false }; }
    }
    if (!['codegraph.sync', 'repoWiki.generate'].includes(job.kind) || !this.options.jobRunners?.[job.kind] || !job.workspace) return { exists: false, busy: false };
    if (job.kind === 'repoWiki.generate' && !parseRepoWikiJobPayload(job.metadata?.payload)) return { exists: false, busy: false };
    try { if (!(await stat(job.workspace)).isDirectory()) return { exists: false, busy: false }; } catch { return { exists: false, busy: false }; }
    return { exists: true, busy: this.jobs!.list().some((other) => other.kind === job.kind && ['pending', 'running'].includes(other.state) && this.sameJobTarget(other, job)) };
  }

  private async retryTask(previous: Job, metadata: { retryOf: string }, options?: TaskRetryOptions): Promise<Job> {
    const current = this.jobs!.get(previous.id);
    if (!current || !['failed', 'cancelled'].includes(current.state)) throw new Error('TASK_RETRY_UNAVAILABLE');
    const target = await this.readTaskTarget(previous);
    if (!target.exists || target.busy) throw new Error(target.busy ? 'TASK_TARGET_BUSY' : 'TASK_TARGET_NOT_FOUND');
    if (this.closed) throw new Error('runtime is closed');
    const again = await this.readTaskTarget(previous);
    if (!again.exists || again.busy || this.closed) throw new Error('TASK_TARGET_BUSY');
    return this.createUserJob(previous.kind, previous.workspace, { ...previous.metadata, ...metadata, cancellationRequested: false, cancellationError: undefined }, options?.expectedModel);
  }

  private async workbenchOverview(): Promise<WorkbenchOverview> {
    const result: WorkbenchOverview = { recentPages: [], errors: [] };
    try {
      const libraries = this.wiki!.list();
      result.libraries = { total: libraries.length, pendingSources: 0, pages: 0 };
      for (const library of libraries) {
        result.libraries.pages += library.pageCount ?? 0;
      }
    } catch { result.errors.push({ domain: 'wiki', message: '知识库概览暂不可用' }); }
    try {
      const counts = this.storage!.db.prepare("SELECT SUM(active) AS active,SUM(failed) AS failed FROM (SELECT state IN ('pending','running') AS active,state='failed' AS failed FROM agent_jobs UNION ALL SELECT status IN ('pending','queued','running','blocked') AS active,status='failed' AS failed FROM service_tasks)").get()!;
      result.activeTasks = Number(counts.active ?? 0); result.failedTasks = Number(counts.failed ?? 0);
    } catch { result.errors.push({ domain: 'tasks', message: '任务计数暂不可用' }); }
    if (this.diagnosticReport) result.diagnostics = { actionRequired: this.diagnosticReport.items.filter((item) => item.state === 'action_required').length, unchecked: this.diagnosticReport.items.filter((item) => item.state === 'unchecked').length };
    return result;
  }

  /** Main-process service work uses the serialized system-task lane. */
  async runServiceTask(input: Omit<QueueTaskInput, 'system'>): Promise<unknown> {
    if (!this.taskQueue || this.closed) throw new Error('agent data task executor is not available');
    this.inFlight += 1;
    try {
      const task = await this.taskQueue.enqueue({ ...input, system: true });
      if (task.status !== 'completed') throw new Error(task.error ?? `service task ${task.status}`);
      return task.output;
    } finally {
      this.inFlight -= 1; this.finishClose();
    }
  }

  /** Trusted host port only; deliberately absent from socket/admin method tables. */
  async describeKnowledgeModel(): Promise<string> {
    if (this.closed || !this.wiki || !this.options.describeModel) throw new Error('MODEL_UNAVAILABLE');
    return this.options.describeModel();
  }

  async completeKnowledge(input: KnowledgeCompletionInput, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<string> {
    if (this.closed || !this.wiki) throw new Error('agent data runtime is not started');
    const id = options.requestId ?? randomUUID();
    if (this.knowledgeCalls.has(id)) throw new Error('duplicate knowledge request id');
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    this.knowledgeCalls.set(id, controller);
    this.inFlight += 1;
    try { return await this.wiki.completeKnowledge(input, { signal: controller.signal }); }
    finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.knowledgeCalls.delete(id);
      this.inFlight -= 1;
      this.finishClose();
    }
  }

  cancelKnowledge(requestId: string): void { this.knowledgeCalls.get(requestId)?.abort(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.knowledgeRuntime) {
      this.inFlight += 1;
      void this.closeKnowledge().catch(error => console.error('KnowledgeKernel shutdown failed', error))
        .finally(() => { this.inFlight -= 1; this.finishClose(); });
    }
    for (const controller of this.knowledgeCalls.values()) controller.abort();
    if (this.taskQueue) {
      const queuedWiki = this.storage!.db.prepare("SELECT id FROM service_tasks WHERE kind='wiki_page_generate' AND status='queued'").all();
      for (const task of queuedWiki) this.taskQueue.cancel(String(task.id));
    }
    this.taskQueue?.stop();
    if (this.taskQueue && !this.taskQueue.isIdle()) void this.taskQueue.whenIdle().then(() => this.finishClose());
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
      this.projectTokens.clear(); this.workspaceTokens.clear();
    this.endpoint = undefined;
    this.finishClose();
  }

  private finishClose(): void {
    if (!this.closed || this.inFlight !== 0 || (this.taskQueue && !this.taskQueue.isIdle())) return;
    this.storage?.close(); this.storage = undefined;
    this.toolPermission = undefined;
    if (this.temporaryWikiRoot) {
      rmSync(this.temporaryWikiRoot, { recursive: true, force: true });
      this.temporaryWikiRoot = undefined;
    }
    for (const resolve of this.closeWaiters.splice(0)) resolve();
  }

  waitClosed(): Promise<void> { return this.closed && !this.storage ? Promise.resolve() : new Promise((resolve) => this.closeWaiters.push(resolve)); }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new RequestFrameDecoder((token) => this.authorized(token));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { decoder.clear(); this.sockets.delete(socket); });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const request = decoder.accept(line);
          if (request !== undefined) void this.handleLine(socket, request);
        } catch (error) {
          decoder.clear();
          const e = error instanceof RpcError ? error : new RpcError('INVALID_REQUEST', 'invalid RPC frame');
          socket.write(`${JSON.stringify({ id: this.requestId(line), ok: false, error: { code: e.code, message: e.message } })}\n`);
        }
        newline = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer) > 1_048_576) socket.destroy(new Error('RPC frame exceeds 1 MiB'));
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    this.inFlight += 1;
    // 只记同步段（解析 + 调用到返回 + 应答序列化与写出），不含 await 的等待。见 methodTiming.ts。
    const begun = performance.now();
    let label = 'invalid';
    let syncMs = 0;
    let stop = agentDataTiming.start();
    let response: RpcResponse;
    let shutdown = false;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC request');
      if (!this.authorized(value.token)) throw new RpcError('UNAUTHORIZED', 'invalid token');
      // 未解析出处理函数的请求统一记作 rejected：方法名来自 socket，不能让它撑大统计表。
      label = SYSTEM_METHODS.has(value.method) ? value.method : 'rejected';
      if (value.method === 'system.hello') response = { id: value.id, ok: true, result: { version: PROTOCOL_VERSION } };
      else if (value.method === 'system.status') response = { id: value.id, ok: true, result: { state: this.closed ? 'closed' : 'ready', version: PROTOCOL_VERSION } };
      else if (value.method === 'system.shutdown') {
        if (value.token !== this.token) throw new RpcError('FORBIDDEN', 'only the host may stop the runtime');
        response = { id: value.id, ok: true, result: null }; shutdown = true;
      }
      else {
        const workspace = this.projectTokens.get(value.token);
        const projectJobs = workspace ? this.projectJobMethod(value.method, value.params) : undefined;
        if (value.method.startsWith('wiki.') && !workspace) {
          throw new RpcError('FORBIDDEN', 'Wiki management is available only in the application');
        }
        const method = value.method.startsWith('wiki.') ? this.wikiMethod(value.method, 'project')
          : projectJobs ?? this.options.methods?.[value.method] ?? this.adminMethod(value.method) ?? this.toolPermissionMethod(value.method, workspace) ?? this.threadMethod(value.method);
        if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${value.method}`);
        label = value.method;
        const pending = method(value.params);
        syncMs += stop();
        let result: unknown;
        try { result = await pending; } finally { stop = agentDataTiming.start(); }
        response = { id: value.id, ok: true, result };
      }
    } catch (error) {
      const e = wikiRpcError(error);
      response = { id: this.requestId(line), ok: false, error: { code: e.code, message: e.message } };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { if (shutdown) this.close(); });
    syncMs += stop();
    agentDataTiming.record(label, syncMs, { totalMs: performance.now() - begun, nested: agentDataTiming.nested });
    this.inFlight -= 1;
    this.finishClose();
  }

  /** 工具授权 RPC。workspace 由 token 决定，调用方自报的值一律被覆盖。 */
  private toolPermissionMethod(name: string, workspace: string | undefined): AgentDataMethod | undefined {
    if (!this.toolPermission) return undefined;
    return toolPermissionMethods(this.toolPermission, workspace)[name];
  }

  private wikiMethod(name: string, access: 'admin' | 'project'): AgentDataMethod | undefined {
    if (!this.wiki) return undefined;
    const wiki = this.wiki;
    const projectAllowed = new Set([
      'wiki.list', 'wiki.read', 'wiki.search', 'wiki.pageList', 'wiki.pageRead', 'wiki.rawList', 'wiki.rawRead',
    ]);
    if (access === 'project' && !projectAllowed.has(name)) {
      throw new RpcError('FORBIDDEN', 'Wiki management is available only in the application');
    }
    const wikiId = (p: Record<string, unknown>) => readString(p.wikiId);
    if (name === 'wiki.create') return (p) => wiki.create({ name: readString(p.name), ...(p.wikiId === undefined ? {} : { wikiId: readString(p.wikiId) }) });
    if (name === 'wiki.read') return (p) => wiki.read(wikiId(p));
    if (name === 'wiki.list') return () => wiki.list();
    if (name === 'wiki.update') return (p) => wiki.update(wikiId(p), {
      ...(p.name === undefined ? {} : { name: readString(p.name) }),
      ...(p.summary === undefined ? {} : { summary: p.summary === null ? null : readWikiText(p.summary) }),
    });
    if (name === 'wiki.remove') return (p) => { wiki.remove(wikiId(p)); return null; };
    if (name === 'wiki.resetDraft') return (p) => { wiki.resetDraft(wikiId(p)); return null; };
    if (name === 'wiki.ingest') return (p) => wiki.ingest(wikiId(p));
    if (name === 'wiki.rawWrite') return (p) => { wiki.writeRaw(wikiId(p), readString(p.filename), readWikiText(p.content)); return null; };
    if (name === 'wiki.rawRemove') return (p) => { wiki.removeRaw(wikiId(p), readString(p.filename)); return null; };
    if (name === 'wiki.rawList') return (p) => wiki.listRaw(wikiId(p));
    if (name === 'wiki.rawRead') return (p) => wiki.readRaw(wikiId(p), readString(p.filename));
    if (name === 'wiki.writeTemplate') return (p) => {
      wiki.writeTemplate(wikiId(p), readString(p.name), readWikiText(p.content));
      return null;
    };
    if (name === 'wiki.pageWrite') return (p) => wiki.writePage(wikiId(p), readString(p.ref), readWikiText(p.content));
    if (name === 'wiki.pageRemove') return (p) => { wiki.removePage(wikiId(p), readString(p.ref)); return null; };
    if (name === 'wiki.pageList') return (p) => wiki.listPages(wikiId(p));
    if (name === 'wiki.pageRead') return (p) => wiki.readPage(wikiId(p), readString(p.ref));
    if (name === 'wiki.search') return (p) => wiki.search(wikiId(p), readString(p.query), {
      ...(p.limit === undefined ? {} : { limit: wikiLimit(p.limit, 20) }),
      ...(p.hop === undefined ? {} : { hop: Number(p.hop) }),
      ...(p.decay === undefined ? {} : { decay: Number(p.decay) }),
      ...(p.minScore === undefined ? {} : { minScore: Number(p.minScore) }),
    });
    if (name === 'wiki.graph') return (p) => wiki.graph(wikiId(p));
    return undefined;
  }

  /** Generic job commands must not become a second Wiki management entry. */
  private projectJobMethod(name: string, params: Record<string, unknown>): AgentDataMethod | undefined {
    if (name === 'admin.export' || name === 'admin.audit.list') throw new RpcError('FORBIDDEN', 'aggregate management history is available only in the application');
    if (!name.startsWith('admin.jobs.')) return undefined;
    if (name === 'admin.jobs.list') return (p) => this.jobs!.list(p.state === undefined ? undefined : readJobState(p.state));
    return undefined;
  }

  private adminMethod(name: string, trusted = false): AgentDataMethod | undefined {
    if (!this.jobs) return undefined;
    if (name === 'admin.jobs.list') return (params) => this.jobs!.list(params.state === undefined ? undefined : readJobState(params.state));
    if (name === 'codeRetrieval.admin.projects') return () => this.options.codeRetrieval?.projects() ?? [];
    if (name === 'codeRetrieval.admin.status') return (p) => {
      const workspace = typeof p.workspace === 'string' ? p.workspace : '';
      return this.options.codeRetrieval?.status(workspace) ?? { workspace, connected: false, indexed: false, state: 'unavailable' };
    };
    if (name === 'codeRetrieval.search') return (p) => {
      const workspace = readString(p.workspace);
      const query = readString(p.query);
      const limit = typeof p.limit === 'number' ? p.limit : 20;
      return this.options.codeRetrieval?.search(workspace, query, limit)
        ?? { workspace, available: false, results: [], message: 'CodeGraph is not available' };
    };
    if (name === 'codeRetrieval.call') return (p) => {
      const workspace = readString(p.workspace);
      let tool: CodeRetrievalTool;
      let args: Record<string, unknown>;
      try {
        tool = readCodeRetrievalTool(p.tool);
        args = validateCodeRetrievalArgs(workspace, tool, p.args);
      } catch (error) {
        throw new RpcError('INVALID_PARAMS', error instanceof Error ? error.message : String(error));
      }
      if (!this.options.codeRetrieval?.call) throw new RpcError('UNAVAILABLE', 'CodeGraph provider is not available');
      return this.options.codeRetrieval.call(workspace, tool, args);
    };
    if (name === 'admin.jobs.get') return (p) => this.jobs!.get(readString(p.id));
    if (trusted && name === 'admin.jobs.stage') return (p) => {
      const id = readString(p.id);
      if (p.progress !== undefined && (typeof p.progress !== 'number' || !Number.isFinite(p.progress) || p.progress < 0 || p.progress > 100)) throw new RpcError('INVALID_PARAMS', 'progress must be between 0 and 100');
      if ((p.processed === undefined) !== (p.total === undefined)) throw new RpcError('INVALID_PARAMS', 'processed and total must be provided together');
      this.jobs!.recordStage(id, readString(p.stage), p.processed === undefined ? undefined : { processed: Number(p.processed), total: Number(p.total) });
      if (p.progress !== undefined) this.jobs!.progress(id, p.progress as number);
      if (p.message !== undefined || p.currentPage !== undefined) this.jobs!.updateMetadata(id, this.readJobDetailPatch(p));
      return this.jobs!.get(id);
    };
    if (trusted && name === 'admin.jobs.metadata') return (p) => {
      const patch = readRecord(p.patch), detail = this.readJobDetailPatch(patch);
      if (patch.payload !== undefined) {
        const payload = parseRepoWikiJobPayload(patch.payload);
        if (!payload) throw new RpcError('INVALID_PARAMS', 'Repo Wiki payload requires valid parameters and confirmation');
        detail.payload = payload;
      }
      return this.jobs!.updateMetadata(readString(p.id), detail);
    };
    if (name === 'admin.jobs.remove') return (p) => {
      try {
        const id = readString(p.id);
        const task = this.taskViews!.read({ source: 'user', id });
        if (task && !task.capabilities.remove) throw new Error('JOB_ACTIVE');
        return this.jobs!.remove(id);
      }
      catch (error) {
        if (error instanceof Error && error.message === 'JOB_ACTIVE') throw new RpcError('JOB_ACTIVE', '请先取消等待中或运行中的任务');
        throw error;
      }
    };
    if (name === 'admin.jobs.clear') return (p) => {
      if (!Array.isArray(p.ids)) throw new RpcError('INVALID_PARAMS', 'ids must be an array of task IDs');
      return this.jobs!.clear(p.ids.map(readString).filter((id) => this.taskViews!.read({ source: 'user', id })?.capabilities.remove));
    };
    if (name === 'admin.jobs.cancel') return async (p) => {
      const id = readString(p.id);
      const job = this.jobs!.get(id);
      if (job?.metadata?.repoWiki && this.knowledgeRuntime) {
        await this.knowledgeRuntime.coordinator.act({ version: 1, requestId: randomUUID(), taskId: id, action: 'cancel', expectedRevision: job.metadata.repoWiki.revision });
        return this.jobs!.get(id);
      }
      if (!job || !['pending', 'running'].includes(job.state)) return job;
      const runner = job ? this.options.jobRunners?.[job.kind] : undefined;
      if (!runner) return this.jobs!.cancel(id);
      // 有执行器时取消只是"请求"：状态由执行器确认停止后通过 admin.jobs.markCancelled 落定，
      // 避免出现"状态已取消但后台还在写文件"。
      this.jobs!.requestCancellation(id);
      try { await runner.cancel(id); }
      catch (error) {
        this.jobs!.updateMetadata(id, { cancellationRequested: false, cancellationError: '取消请求失败，可再次尝试' });
        throw error;
      }
      return this.jobs!.get(id);
    };
    if (name === 'admin.jobs.markCancelled') return (p) => this.jobs!.cancel(readString(p.id));
    if (name === 'admin.jobs.create') return (p) => {
      const kind = readString(p.kind);
      if (kind === 'repoWiki.generate') {
        if (this.knowledgeRuntime) throw new RpcError('INVALID_PARAMS', 'KNOWLEDGE_START_REQUIRED: use the knowledge coordinator');
        if (!trusted) throw new RpcError('FORBIDDEN', 'Repo Wiki generation is available only through the application');
        const metadata = parseJobMetadata(p.metadata), payload = parseRepoWikiJobPayload(metadata?.payload);
        if (!payload) throw new RpcError('INVALID_PARAMS', 'Repo Wiki payload requires valid parameters and confirmation');
        if (!this.options.jobRunners?.[kind]) throw new RpcError('UNAVAILABLE', 'Repo Wiki runner is not available');
        return this.createUserJob(kind, readString(p.workspace), { ...metadata, payload });
      }
      if (kind === 'memory' || kind.startsWith('memory_') || kind.startsWith('memory.')) throw new RpcError('INVALID_PARAMS', 'Memory tasks are no longer supported');
      if (kind.startsWith('wiki.')) throw new RpcError('INVALID_PARAMS', 'Wiki jobs are no longer created through the job queue');
      const workspace = readString(p.workspace);
      return this.createUserJob(kind, workspace);
    };
    if (name === 'admin.jobs.start') return (p) => this.jobs!.start(readString(p.id));
    if (name === 'admin.jobs.progress') return (p) => this.jobs!.progress(readString(p.id), typeof p.value === 'number' ? p.value : 0);
    if (name === 'admin.jobs.complete') return (p) => this.jobs!.complete(readString(p.id));
    if (name === 'admin.jobs.fail') return (p) => this.jobs!.fail(readString(p.id), readString(p.error));
    if (name === 'admin.config.get') return (p) => this.jobs!.config(readString(p.module));
    if (name === 'admin.config.update') return (p) => {
      if (p.module === 'memory') throw new RpcError('INVALID_PARAMS', 'Memory configuration is no longer supported');
      try { return this.jobs!.updateConfig(readString(p.module), readRecord(p.value), typeof p.version === 'number' ? p.version : -1); }
      catch (error) { if (error instanceof Error && error.message === 'VERSION_CONFLICT') throw new RpcError('VERSION_CONFLICT', 'configuration version is stale'); throw error; }
    };
    if (name === 'admin.audit.list') return () => this.jobs!.audit();
    if (name === 'admin.diagnostics') return () => this.jobs!.diagnostics();
    if (name === 'admin.export') return () => this.jobs!.exportData();
    if (name === 'admin.import') return (p) => { const data = readRecord(p.data); this.jobs!.importData({ configs: data.configs === undefined ? undefined : readRecord(data.configs) as never }); return null; };
    return undefined;
  }

  private createUserJob(kind: string, workspace: string, metadata?: JobMetadata, expectedModel?: string): Job {
    if (this.closed) throw new Error('runtime is closed');
    const runner = this.options.jobRunners?.[kind];
    if (kind === 'repoWiki.generate') {
      const existing = this.jobs!.list().find((job) => job.kind === kind && ['pending', 'running'].includes(job.state) && this.sameJobTarget(job, { kind, workspace, metadata }));
      if (existing) return existing;
    }
    const create = () => {
      if (metadata?.retryOf) {
        const original = this.jobs!.get(metadata.retryOf);
        if (!original || !['failed', 'cancelled'].includes(original.state) || original.kind !== kind || original.workspace !== workspace) throw new Error('TASK_RETRY_UNAVAILABLE');
      }
      if (runner && this.jobs!.list().some((job) => job.kind === kind && ['pending', 'running'].includes(job.state) && this.sameJobTarget(job, { kind, workspace, metadata }))) throw new RpcError('JOB_ALREADY_RUNNING', `${kind} is already running for this workspace`);
      const target = kind === 'codegraph.sync' ? { type: 'project' as const, id: workspace }
        : kind === 'repoWiki.generate' ? { type: 'repoWiki' as const, id: workspace, language: parseRepoWikiJobPayload(metadata?.payload)?.language } : undefined;
      const job = this.jobs!.create({ kind, workspace, ...(target || metadata ? { metadata: { ...metadata, ...(target ? { target, resourceName: kind === 'repoWiki.generate' ? metadata?.resourceName || workspace : workspace } : {}) } } : {}) });
      return job;
    };
    const job = create();
    if (runner) this.dispatchJob(job, expectedModel);
    return job;
  }

  private dispatchJob(job: Job, expectedModel?: string): void {
    const runner = this.options.jobRunners?.[job.kind];
    if (!runner) return;
    this.inFlight += 1;
    void Promise.resolve().then(() => job.kind === 'repoWiki.generate'
      ? runner.run(job.id, job.workspace, expectedModel, job.metadata?.payload)
      : runner.run(job.id, job.workspace, expectedModel)).catch((error) => {
        const current = this.jobs!.get(job.id);
        if (!current || ['cancelled', 'completed', 'failed'].includes(current.state)) return;
        this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error));
      }).finally(() => { this.inFlight -= 1; this.finishClose(); });
  }

  private sameJobTarget(a: Pick<Job, 'kind' | 'workspace' | 'metadata'>, b: Pick<Job, 'kind' | 'workspace' | 'metadata'>): boolean {
    if (normalizeWorkspace(a.workspace) !== normalizeWorkspace(b.workspace)) return false;
    if (a.kind !== 'repoWiki.generate') return true;
    const left = parseRepoWikiJobPayload(a.metadata?.payload), right = parseRepoWikiJobPayload(b.metadata?.payload);
    return !!left && !!right && left.projectId === right.projectId && left.language === right.language && left.target === right.target;
  }

  private readJobDetailPatch(p: Record<string, unknown>): Partial<JobMetadata> {
    const patch: Partial<JobMetadata> = {};
    for (const [key, max] of [['message', 1000], ['currentPage', 500]] as const) if (p[key] !== undefined) {
      if (typeof p[key] !== 'string' || p[key].length > max) throw new RpcError('INVALID_PARAMS', `invalid ${key}`);
      patch[key] = p[key];
    }
    return patch;
  }

  private threadMethod(name: string): AgentDataMethod | undefined {
    if (!this.threads) return undefined;
    if (name === 'thread.create') return (p) => this.threads!.createThread({ id: readString(p.id), projectId: readString(p.projectId), workspace: readString(p.workspace), title: typeof p.title === 'string' ? p.title : undefined });
    if (name === 'thread.list') return () => this.threads!.listThreads();
    if (name === 'thread.read') return (p) => this.threads!.readThread(readString(p.id));
    if (name === 'turn.create') return (p) => this.threads!.createTurn({ id: readString(p.id), threadId: readString(p.threadId), input: readString(p.input), permissionProfile: readString(p.permissionProfile), mode: p.mode === 'non-interactive' ? 'non-interactive' : 'interactive' });
    if (name === 'turn.update') return (p) => this.threads!.updateTurn(readString(p.id), {
      ...(isTurnStatus(p.status) ? { status: p.status } : {}),
      ...(typeof p.startedAt === 'number' ? { startedAt: p.startedAt } : {}),
      ...(typeof p.completedAt === 'number' ? { completedAt: p.completedAt } : {}),
      ...(typeof p.error === 'string' ? { error: p.error } : {}),
    });
    if (name === 'item.upsert') return (p) => this.threads!.upsertItem({ id: readString(p.id), threadId: readString(p.threadId), turnId: readString(p.turnId), type: readItemType(p.type), status: readItemStatus(p.status), payload: p.payload });
    if (name === 'item.list') return (p) => this.threads!.listItems(readString(p.threadId), p.turnId === undefined ? undefined : readString(p.turnId));
    return undefined;
  }

  private requestId(line: string): string {
    try { const value = JSON.parse(line) as { id?: unknown }; return typeof value.id === 'string' ? value.id : randomUUID(); } catch { return randomUUID(); }
  }
}

/**
 * 崩溃重拉时上一个进程的管道句柄可能还没释放（EADDRINUSE）；短暂重试。
 * POSIX 的 socket 文件不会自己消失：先试连，连不上说明是残留文件，删掉再监听。
 */
async function listenWithRetry(server: Server, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(path, () => { server.off('error', rejectListen); resolveListen(); });
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= 20) throw error;
      if (process.platform !== 'win32' && !(await socketAlive(path))) rmSync(path, { force: true });
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolveAlive) => {
    const probe = createConnection(path);
    probe.once('connect', () => { probe.destroy(); resolveAlive(true); });
    probe.once('error', () => resolveAlive(false));
  });
}

function readTaskRef(value: Record<string, unknown>): TaskRef {
  if (value.source !== 'user' && value.source !== 'system') throw new RpcError('INVALID_PARAMS', 'task source is required');
  return { source: value.source, id: readString(value.id) };
}
function wikiRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z_]+)(?::|$)/.exec(message)?.[1] ?? 'INTERNAL_ERROR';
  return new RpcError(code, message);
}
function readWikiText(value: unknown): string { if (typeof value !== 'string') throw new RpcError('INVALID_PARAMS', 'text parameter is required'); return value; }
function wikiLimit(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.trunc(value))) : fallback; }
function normalizeWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('workspace is required');
  const normalized = resolve(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function readString(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new RpcError('INVALID_PARAMS', 'string parameter is required'); return value; }
function readJobState(value: unknown): import('./jobStore').JobState { if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') return value; throw new RpcError('INVALID_PARAMS', 'invalid job state'); }
function readRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_PARAMS', 'object parameter is required'); return value as Record<string, unknown>; }
function readStringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new RpcError('INVALID_PARAMS', 'string array is required'); return [...value] as string[]; }
function isTurnStatus(value: unknown): value is import('../app/appServer/types').TurnStatus { return value === 'queued' || value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function readItemType(value: unknown): import('../app/appServer/types').ItemType { if (value === 'user_message' || value === 'assistant_message' || value === 'reasoning' || value === 'tool_call' || value === 'tool_result' || value === 'permission_request' || value === 'error') return value; throw new RpcError('INVALID_PARAMS', 'invalid item type'); }
function readItemStatus(value: unknown): import('../app/appServer/types').ItemStatus { if (value === 'started' || value === 'streaming' || value === 'completed' || value === 'failed') return value; throw new RpcError('INVALID_PARAMS', 'invalid item status'); }
