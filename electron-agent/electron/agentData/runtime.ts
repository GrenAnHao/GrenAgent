import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDataStorage } from './storage';
import { ThreadStore } from './threadStore';
import { MemoryStore } from './memoryStore';
import type { MemoryDraft, MemoryFilter, MemoryListInput, MemoryOwner } from './memoryContracts';
import { WikiService } from './wikiEngine/service';
import { TaskViewStore } from './taskViewStore';
import { TaskViewService } from '../app/taskViewService';
import { AuditViewStore } from './auditViewStore';
import { AgentDataDiagnostics } from '../app/agentDataDiagnostics';
import type { AuditQuery, DiagnosticReport, JobMetadata, TaskListInput, TaskRef, TaskRetryOptions, WorkbenchOverview } from './operationsContracts';
import { JobStore, type Job } from './jobStore';
import { MemoryService, type LayerScheduleOptions, type MemoryTaskQueue } from '../app/memoryService';
import { ServiceTaskRegistry } from '../app/appServer/serviceTaskRegistry';
import { TaskQueue, type QueueTaskInput } from '../app/appServer/taskQueue';
import type { ServiceTask, ServiceTaskHooks } from '../app/appServer/types';
import { isRpcRequest, PROTOCOL_VERSION, RpcError, type AgentDataEndpoint, type RpcResponse } from './protocol';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from './codeRetrievalProtocol';
import { RequestFrameDecoder } from './requestFrames';
import { ToolAuditStore } from '../app/toolPermission/auditStore';
import { ToolRuleStore } from '../app/toolPermission/ruleStore';
import { ToolDecisionService } from '../app/toolPermission/toolDecisionService';
import { toolPermissionMethods } from '../app/toolPermission/rpc';

export type AgentDataMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface AgentDataJobRunner {
  run(jobId: string, workspace: string, expectedModel?: string): Promise<void>;
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
  validateProject?: (workspace: string) => Promise<string>;
  /** Injected model short-call for Wiki ingest; tests pass a stub. */
  completeSimple?: (input: { systemPrompt?: string; user: string }) => Promise<string>;
  /** Resolves whether a session is currently owned by the endpoint workspace. */
  resolveSession?: (workspace: string, sessionId: string) => boolean | Promise<boolean>;
  layerSchedule?: LayerScheduleOptions;
}

export class AgentDataRuntime {
  private server?: Server;
  private storage?: AgentDataStorage;
  private endpoint?: AgentDataEndpoint;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private inFlight = 0;
  private readonly token = randomBytes(32).toString('hex');
  private memory?: MemoryStore;
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
  private memoryService?: MemoryService;
  private taskQueue?: TaskQueue;
  private temporaryWikiRoot?: string;
  private toolPermission?: ToolDecisionService;

  constructor(private readonly options: AgentDataRuntimeOptions) {}

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
    this.memory = new MemoryStore(this.storage.db);
    const fallbackQueue: MemoryTaskQueue = {
        enqueue: async (input) => {
          const now = Date.now();
          this.storage!.db.prepare(`INSERT INTO service_tasks(id,kind,source_project_id,source_session_id,is_system,status,input,output,attempts,error,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.kind, input.sourceProjectId ?? null, input.sourceSessionId ?? null, input.system ? 1 : 0, 'queued', JSON.stringify(input.input), null, 0, null, now, now);
          return { id: input.id, kind: input.kind, sourceProjectId: input.sourceProjectId, sourceSessionId: input.sourceSessionId, status: 'queued', input: input.input, attempts: 0, createdAt: now, updatedAt: now };
        },
        get: (id) => {
          const row = this.storage!.db.prepare('SELECT * FROM service_tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
          if (!row) return undefined;
          return { id: String(row.id), kind: String(row.kind), sourceProjectId: row.source_project_id == null ? undefined : String(row.source_project_id), sourceSessionId: row.source_session_id == null ? undefined : String(row.source_session_id), status: String(row.status) as never, input: JSON.parse(String(row.input)), output: row.output == null ? undefined : JSON.parse(String(row.output)), attempts: Number(row.attempts), error: row.error == null ? undefined : String(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
        },
        findPending: (kind, matches) => {
          const rows = this.storage!.db.prepare("SELECT id FROM service_tasks WHERE kind=? AND status IN ('queued','running') ORDER BY created_at ASC").all(kind);
          return rows.map((row) => fallbackQueue.get!(String(row.id))!).find(matches);
        },
      };
    if (this.options.executeServiceTask) {
      const registry = new ServiceTaskRegistry();
      const queue = new TaskQueue({
        storage: this.storage,
        registry,
        execute: async (task, hooks) => {
          const output = await this.options.executeServiceTask!(task, hooks);
          if (task.kind === 'memory_extract') this.memoryService!.completeExtraction(task.id, output);
          if (task.kind === 'memory_deduplicate') this.memoryService!.completeDedup(task.id, output);
          if (task.kind === 'memory_scene') this.memoryService!.completeScene(task.id, output);
          if (task.kind === 'memory_persona') this.memoryService!.completePersona(task.id, output);
          return output;
        },
        onSettled: (task) => this.memoryService!.taskSettled(task),
      });
      this.taskQueue = queue;
      this.memoryService = new MemoryService({ store: this.memory, queue, validateProject: this.options.validateProject, layerSchedule: this.options.layerSchedule });
      queue.recoverRunning();
      this.memoryService.recoverLayerSchedules();
    } else {
      this.memoryService = new MemoryService({ store: this.memory, queue: fallbackQueue, validateProject: this.options.validateProject, layerSchedule: this.options.layerSchedule });
      this.memoryService.recoverLayerSchedules();
    }
    const wikiRoot = this.options.wikiRootDir ?? (this.options.dataPath === ':memory:'
      ? (this.temporaryWikiRoot = mkdtempSync(join(tmpdir(), 'agent-data-wiki-')))
      : join(dirname(resolve(this.options.dataPath)), 'wiki'));
    this.jobs = new JobStore(this.storage.db);
    this.wiki = new WikiService({
      root: wikiRoot,
      db: this.storage.db,
      complete: async (system, prompt) => {
        if (!this.options.completeSimple) throw new Error('MODEL_UNAVAILABLE: no Wiki model is configured');
        return this.options.completeSimple({ systemPrompt: system, user: prompt });
      },
    });
    this.taskViews = new TaskViewStore(this.storage.db);
    this.taskService = new TaskViewService({ views: this.taskViews, jobs: this.jobs,
      readTarget: (job) => this.readTaskTarget(job), dispatch: (job, metadata, options) => this.retryTask(job, metadata, options),
      canCancel: (job) => Boolean(this.options.jobRunners?.[job.kind]),
    });
    this.auditViews = new AuditViewStore(this.storage.db);
    this.diagnostics = new AgentDataDiagnostics({
      codeProjects: () => this.options.codeRetrieval?.projects() ?? [], codeStatus: (workspace) => this.options.codeRetrieval?.status(workspace) ?? {},
    });
    this.threads = new ThreadStore(this.storage);
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('agent data server address unavailable');
    this.options.stdin?.once('end', () => this.handleStdinEnd());
    this.endpoint = { host: '127.0.0.1', port: address.port, token: this.token };
    return this.endpoint;
  }

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
    return { host: this.endpoint.host, port: this.endpoint.port, token };
  }

  /** Trusted main-process entry. No socket method can select this context. */
  async requestAdmin<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    this.inFlight += 1;
    try {
      const method = this.operationsMethod(name) ?? this.memoryManagementMethod(name) ?? this.wikiMethod(name, 'admin');
      if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown management method: ${name}`);
      return await method(params) as T;
    } catch (error) {
      if (error instanceof RpcError) throw new Error(`${error.code}: ${error.message}`);
      throw error;
    } finally { this.inFlight -= 1; this.finishClose(); }
  }

  private authorized(token: string): boolean { return token === this.token || this.projectTokens.has(token); }

  async resolveDiagnosticPath(id: string): Promise<string> {
    if (!this.diagnostics || this.closed) throw new Error('runtime is not started');
    return this.diagnostics.resolveOpenPath(id);
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
    if (name === 'admin.overview') return (p) => this.workbenchOverview(readString(p.userId));
    return undefined;
  }

  private async readTaskTarget(job: Job): Promise<{ exists: boolean; busy: boolean }> {
    if (!['codegraph.sync'].includes(job.kind) || !this.options.jobRunners?.[job.kind] || !job.workspace) return { exists: false, busy: false };
    try { if (!(await stat(job.workspace)).isDirectory()) return { exists: false, busy: false }; } catch { return { exists: false, busy: false }; }
    return { exists: true, busy: this.jobs!.list().some((other) => other.kind === job.kind && ['pending', 'running'].includes(other.state) && normalizeWorkspace(other.workspace) === normalizeWorkspace(job.workspace)) };
  }

  private async retryTask(previous: Job, metadata: { retryOf: string }, options?: TaskRetryOptions): Promise<Job> {
    const current = this.jobs!.get(previous.id);
    if (!current || !['failed', 'cancelled'].includes(current.state)) throw new Error('TASK_RETRY_UNAVAILABLE');
    const target = await this.readTaskTarget(previous);
    if (!target.exists || target.busy) throw new Error(target.busy ? 'TASK_TARGET_BUSY' : 'TASK_TARGET_NOT_FOUND');
    if (this.closed) throw new Error('runtime is closed');
    const again = await this.readTaskTarget(previous);
    if (!again.exists || again.busy || this.closed) throw new Error('TASK_TARGET_BUSY');
    return this.createUserJob(previous.kind, previous.workspace, { ...metadata }, options?.expectedModel);
  }

  private async workbenchOverview(userId: string): Promise<WorkbenchOverview> {
    const result: WorkbenchOverview = { recentPages: [], recentMemories: [], errors: [] };
    try {
      const libraries = this.wiki!.list();
      result.libraries = { total: libraries.length, pendingSources: 0, pages: 0 };
      for (const library of libraries) {
        result.libraries.pages += library.pageCount ?? 0;
      }
    } catch { result.errors.push({ domain: 'wiki', message: '知识库概览暂不可用' }); }
    try { result.recentMemories = this.memory!.list({ userId, filter: { scope: 'all' }, limit: 5 }).items.map(({ id, content, level, updatedAt, scope, sourceProjectId }) => ({ id, content: content.slice(0, 240), level, updatedAt, scope, ...(sourceProjectId ? { sourceProjectId } : {}) })); }
    catch { result.errors.push({ domain: 'memory', message: '最近记忆暂不可用' }); }
    try {
      const counts = this.storage!.db.prepare("SELECT SUM(active) AS active,SUM(failed) AS failed FROM (SELECT state IN ('pending','running') AS active,state='failed' AS failed FROM agent_jobs UNION ALL SELECT status IN ('pending','queued','running','blocked') AS active,status='failed' AS failed FROM service_tasks)").get()!;
      result.activeTasks = Number(counts.active ?? 0); result.failedTasks = Number(counts.failed ?? 0);
    } catch { result.errors.push({ domain: 'tasks', message: '任务计数暂不可用' }); }
    if (this.diagnosticReport) result.diagnostics = { actionRequired: this.diagnosticReport.items.filter((item) => item.state === 'action_required').length, unchecked: this.diagnosticReport.items.filter((item) => item.state === 'unchecked').length };
    return result;
  }

  /** Main-process service work shares the same serialized system-task lane as memory extraction. */
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.memoryService?.dispose();
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
    let response: RpcResponse;
    let shutdown = false;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC request');
      if (!this.authorized(value.token)) throw new RpcError('UNAUTHORIZED', 'invalid token');
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
          : projectJobs ?? this.options.methods?.[value.method] ?? this.memoryMethod(value.method) ?? this.adminMethod(value.method) ?? this.toolPermissionMethod(value.method, workspace) ?? this.threadMethod(value.method);
        if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${value.method}`);
        response = { id: value.id, ok: true, result: await method(value.params) };
      }
    } catch (error) {
      const e = wikiRpcError(error);
      response = { id: this.requestId(line), ok: false, error: { code: e.code, message: e.message } };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { if (shutdown) this.close(); });
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

  /** Deliberately absent from socket dispatch, including the host socket. */
  private memoryManagementMethod(name: string): AgentDataMethod | undefined {
    if (!this.memoryService || !this.memory) return undefined;
    const service = this.memoryService;
    if (name === 'memory.list') return (p) => service.list(readMemoryList(p));
    if (name === 'memory.read') return (p) => service.read({ userId: readString(p.userId), id: readString(p.id) });
    if (name === 'memory.create') return (p) => service.create({ userId: readString(p.userId), draft: readMemoryDraft(p.draft) });
    if (name === 'memory.update') return (p) => service.update({ userId: readString(p.userId), id: readString(p.id), expectedRevision: readMemoryRevision(p.expectedRevision), draft: readMemoryDraft(p.draft) });
    if (name === 'memory.delete') return (p) => { this.memory!.remove({ userId: readString(p.userId), workspace: '' }, readString(p.id)); return null; };
    if (name === 'memory.conversations.list') return (p) => service.listConversations(readMemoryList(p));
    if (name === 'memory.conversations.read') return (p) => service.readConversation({ userId: readString(p.userId), id: readString(p.id) });
    return undefined;
  }

  private memoryMethod(name: string): AgentDataMethod | undefined {
    if (!this.memory) return undefined;
    if (name === 'memory.upsert') return (params) => this.memory!.upsert(readScope(params), {
      level: readLevel(params.level), content: readString(params.content), source: typeof params.source === 'string' ? params.source : undefined,
    });
    if (name === 'memory.capture') return async (params) => {
      const result = await this.memoryService!.capture({ ...readScope(params), projectId: typeof params.projectId === 'string' ? params.projectId : readString(params.workspace), source: readString(params.source), transcript: readString(params.transcript), fingerprint: readString(params.fingerprint), ...(params.extract === false ? { extract: false } : {}) });
      // Extraction uses the stored delta. A large transcript only needs a receipt, not a second full copy over RPC.
      return Buffer.byteLength(result.delta) > 65_536 ? { ...result, delta: '' } : result;
    };
    if (name === 'memory.captureCommit' || name === 'memory.commitCapture') return (params) => { this.memory!.commitCapture(readScope(params), readString(params.source), readString(params.fingerprint)); return null; };
    if (name === 'memory.completeExtraction') return (params) => this.memoryService!.completeExtraction(readString(params.taskId), params.output);
    if (name === 'memory.search') return (params) => this.memoryService!.search({ ...readQueryScope(params), projectId: typeof params.projectId === 'string' ? params.projectId : (typeof params.workspace === 'string' ? params.workspace : ''), query: readString(params.query), limit: typeof params.limit === 'number' ? params.limit : 20 });
    if (name === 'memory.conversations.search') return (params) => this.memory!.searchConversations(readQueryScope(params), readString(params.query), typeof params.limit === 'number' ? params.limit : 20);
    if (name === 'memory.admin.overview') return (params) => this.memory!.overview(readQueryScope(params));
    if (name === 'memory.delete') return (params) => { this.memory!.remove(readScope(params), readString(params.id)); return null; };
    return undefined;
  }

  private adminMethod(name: string): AgentDataMethod | undefined {
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
    const create = () => {
      if (metadata?.retryOf) {
        const original = this.jobs!.get(metadata.retryOf);
        if (!original || !['failed', 'cancelled'].includes(original.state) || original.kind !== kind || original.workspace !== workspace) throw new Error('TASK_RETRY_UNAVAILABLE');
      }
      if (runner && this.jobs!.list().some((job) => job.kind === kind && ['pending', 'running'].includes(job.state) && normalizeWorkspace(job.workspace) === normalizeWorkspace(workspace))) throw new RpcError('JOB_ALREADY_RUNNING', `${kind} is already running for this workspace`);
      const target = kind === 'codegraph.sync' ? { type: 'project' as const, id: workspace } : undefined;
      const job = this.jobs!.create({ kind, workspace, ...(target || metadata ? { metadata: { ...metadata, ...(target ? { target, resourceName: workspace } : {}) } } : {}) });
      return job;
    };
    const job = create();
    if (runner) {
      this.inFlight += 1;
      void Promise.resolve().then(() => runner.run(job.id, workspace, expectedModel)).catch((error) => {
        const current = this.jobs!.get(job.id);
        if (!current || ['cancelled', 'completed', 'failed'].includes(current.state)) return;
        this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error));
      }).finally(() => { this.inFlight -= 1; this.finishClose(); });
    }
    return job;
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

function readTaskRef(value: Record<string, unknown>): TaskRef {
  if (value.source !== 'user' && value.source !== 'system') throw new RpcError('INVALID_PARAMS', 'task source is required');
  return { source: value.source, id: readString(value.id) };
}
function readMemoryOwner(value: unknown): MemoryOwner {
  const owner = readRecord(value);
  if (owner.scope === 'global') return { scope: 'global' };
  if (owner.scope === 'project') return { scope: 'project', projectId: readString(owner.projectId) };
  throw new RpcError('INVALID_PARAMS', 'an explicit memory owner is required');
}
function readMemoryDraft(value: unknown): MemoryDraft {
  const draft = readRecord(value);
  if (draft.source !== undefined && typeof draft.source !== 'string') throw new RpcError('INVALID_PARAMS', 'memory source must be text');
  return { content: readString(draft.content), level: readLevel(draft.level), owner: readMemoryOwner(draft.owner), source: draft.source as string | undefined };
}
function readMemoryRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RpcError('INVALID_PARAMS', 'expected memory revision is required');
  return Number(value);
}
function readMemoryList(value: Record<string, unknown>): MemoryListInput {
  const record = readRecord(value.filter);
  const filter: MemoryFilter = record.scope === 'all' ? { scope: 'all' } : readMemoryOwner(record);
  if (value.query !== undefined && typeof value.query !== 'string') throw new RpcError('INVALID_PARAMS', 'memory query must be text');
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isFinite(value.limit))) throw new RpcError('INVALID_PARAMS', 'memory limit must be finite');
  return { userId: readString(value.userId), filter, ...(value.query === undefined ? {} : { query: value.query as string }),
    ...(value.level === undefined ? {} : { level: readLevel(value.level) }), ...(value.cursor === undefined ? {} : { cursor: readString(value.cursor) }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  };
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
function readLevel(value: unknown): 0 | 1 | 2 | 3 { if (value === 0 || value === 1 || value === 2 || value === 3) return value; throw new RpcError('INVALID_PARAMS', 'level must be 0..3'); }
function readJobState(value: unknown): import('./jobStore').JobState { if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') return value; throw new RpcError('INVALID_PARAMS', 'invalid job state'); }
function readScope(value: Record<string, unknown>): import('./memoryStore').MemoryScope { return { userId: readString(value.userId), workspace: readString(value.workspace), projectId: value.projectId === undefined ? undefined : readString(value.projectId), sessionId: value.sessionId === undefined ? undefined : readString(value.sessionId), scope: value.scope === 'global' ? 'global' : 'project', includeOtherProjects: value.includeOtherProjects === true }; }
/**
 * 只读查询作用域：workspace 可缺省（全局视图没有"当前项目"）。
 * MemoryStore.search/overview 只用 projectId(scope) 与 includeOtherProjects，不直接读 workspace，
 * 因此缺省时传 '' 是安全的；写入路径仍用 readScope 强制要求 workspace。
 */
function readQueryScope(value: Record<string, unknown>): import('./memoryStore').MemoryScope { return { userId: readString(value.userId), workspace: typeof value.workspace === 'string' && value.workspace.trim() ? value.workspace : '', projectId: value.projectId === undefined ? undefined : readString(value.projectId), sessionId: value.sessionId === undefined ? undefined : readString(value.sessionId), scope: value.scope === 'global' ? 'global' : 'project', includeOtherProjects: value.includeOtherProjects === true }; }
function readRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_PARAMS', 'object parameter is required'); return value as Record<string, unknown>; }
function readStringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new RpcError('INVALID_PARAMS', 'string array is required'); return [...value] as string[]; }
function isTurnStatus(value: unknown): value is import('../app/appServer/types').TurnStatus { return value === 'queued' || value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function readItemType(value: unknown): import('../app/appServer/types').ItemType { if (value === 'user_message' || value === 'assistant_message' || value === 'reasoning' || value === 'tool_call' || value === 'tool_result' || value === 'permission_request' || value === 'error') return value; throw new RpcError('INVALID_PARAMS', 'invalid item type'); }
function readItemStatus(value: unknown): import('../app/appServer/types').ItemStatus { if (value === 'started' || value === 'streaming' || value === 'completed' || value === 'failed') return value; throw new RpcError('INVALID_PARAMS', 'invalid item status'); }
