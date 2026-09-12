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
import { WikiStore } from './wikiStore';
import { WikiFiles, wikiHash } from './wikiFiles';
import { WikiLibraryStore, normalizeWikiWorkspace } from './wikiLibraryStore';
import { WikiSourceStore } from './wikiSourceStore';
import { WikiLibraryService } from '../app/wikiLibraryService';
import { scanWorkspaceMarkdown } from '../app/wikiSyncService';
import { TaskViewStore } from './taskViewStore';
import { TaskViewService } from '../app/taskViewService';
import { AuditViewStore } from './auditViewStore';
import { AgentDataDiagnostics } from '../app/agentDataDiagnostics';
import type { AuditQuery, DiagnosticReport, JobMetadata, TaskListInput, TaskRef, TaskRetryOptions, WorkbenchOverview } from './operationsContracts';
import type { WikiSyncSkipInput } from '../app/wikiSyncService';
import type { WikiDiagnostic, WikiLibrary, WikiLibraryInput, WikiLibraryView, WikiPageInput, WikiRequestContext, WikiSourceInput, WikiSourceRef, WikiTarget, WikiVersion } from './wikiContracts';
import { JobStore, type Job } from './jobStore';
import { MemoryService, type MemoryTaskQueue } from '../app/memoryService';
import { ServiceTaskRegistry } from '../app/appServer/serviceTaskRegistry';
import { TaskQueue, type QueueTaskInput } from '../app/appServer/taskQueue';
import type { ServiceTask } from '../app/appServer/types';
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
  executeServiceTask?: (task: ServiceTask) => Promise<unknown>;
  /** 按 job kind 注册的执行器：创建即派发，取消时通知。未注册的 kind 只落库。 */
  jobRunners?: Record<string, AgentDataJobRunner>;
  codeRetrieval?: AgentDataCodeRetrievalProvider;
  validateProject?: (workspace: string) => Promise<string>;
  wikiModelLabel?: () => Promise<string>;
  /** Resolves whether a session is currently owned by the endpoint workspace. */
  resolveSession?: (workspace: string, sessionId: string) => boolean | Promise<boolean>;
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
  private wiki?: WikiStore;
  private wikiLibraries?: WikiLibraryStore;
  private wikiSources?: WikiSourceStore;
  private wikiService?: WikiLibraryService;
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
        execute: async (task) => {
          const output = await this.options.executeServiceTask!(task);
          if (task.kind === 'memory_extract') this.memoryService!.completeExtraction(task.id, output);
          return output;
        },
        onSettled: (task) => this.memoryService!.taskSettled(task),
      });
      this.taskQueue = queue;
      this.memoryService = new MemoryService({ store: this.memory, queue, validateProject: this.options.validateProject });
      queue.recoverRunning();
    } else {
      this.memoryService = new MemoryService({ store: this.memory, queue: fallbackQueue, validateProject: this.options.validateProject });
    }
    const wikiRoot = this.options.wikiRootDir ?? (this.options.dataPath === ':memory:'
      ? (this.temporaryWikiRoot = mkdtempSync(join(tmpdir(), 'agent-data-wiki-')))
      : join(dirname(resolve(this.options.dataPath)), 'wiki'));
    this.jobs = new JobStore(this.storage.db);
    for (const job of this.jobs.list()) if (job.kind === 'wiki.sync' && (job.state === 'pending' || job.state === 'running')) this.jobs.fail(job.id, 'WIKI_TASK_INTERRUPTED: runtime restarted');
    const wikiFiles = new WikiFiles(wikiRoot);
    this.wikiLibraries = new WikiLibraryStore(this.storage.db, wikiFiles);
    this.wikiSources = new WikiSourceStore(this.storage.db, wikiFiles, this.wikiLibraries);
    this.wiki = new WikiStore(this.storage.db, wikiRoot, { libraries: this.wikiLibraries, sources: this.wikiSources });
    this.wikiService = new WikiLibraryService({
      libraries: this.wikiLibraries, sources: this.wikiSources, pages: this.wiki, jobs: this.jobs,
      runServiceTask: (input) => this.runServiceTask(input),
      modelLabel: this.options.wikiModelLabel ?? (async () => { throw new Error('MODEL_UNAVAILABLE: no Wiki model is configured'); }),
      validateProject: this.options.validateProject ?? (async () => { throw new Error('PROJECT_VALIDATOR_UNAVAILABLE'); }),
      cancelJob: (id) => { const job = this.jobs!.get(id); if (job) this.options.jobRunners?.[job.kind]?.cancel(id); },
    });
    this.wikiService.recover();
    this.taskViews = new TaskViewStore(this.storage.db);
    this.taskService = new TaskViewService({ views: this.taskViews, jobs: this.jobs,
      readTarget: (job) => this.readTaskTarget(job), dispatch: (job, metadata, options) => this.retryTask(job, metadata, options),
      previewWikiRetry: (job) => this.previewWikiRetry(job), canCancel: (job) => job.kind === 'wiki.ingest' || Boolean(this.options.jobRunners?.[job.kind]),
    });
    this.auditViews = new AuditViewStore(this.storage.db);
    this.diagnostics = new AgentDataDiagnostics({ wiki: this.wiki, libraries: this.wikiLibraries,
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
    const key = normalizeWikiWorkspace(workspace);
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
      const method = this.operationsMethod(name) ?? this.memoryManagementMethod(name) ?? this.wikiMethod(name, { kind: 'admin' });
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
    if (job.kind === 'wiki.ingest') {
      const payload = job.metadata?.payload;
      if (!payload || !('kbId' in payload) || job.metadata?.target?.type !== 'wiki' || payload.kbId !== job.metadata.target.id) return { exists: false, busy: false };
      const kb = this.wikiLibraries!.get(payload.kbId);
      const sourceIds = payload.sourceIds.filter((id) => this.wikiSources!.get(payload.kbId, id)?.lifecycle === 'active');
      const pending = kb?.lifecycle === 'active' && sourceIds.length ? this.wikiSources!.pending(kb.kbId, sourceIds) : [];
      return { exists: Boolean(kb?.lifecycle === 'active' && pending.length), busy: !!kb && this.wikiLibraries!.activeTasks({ kind: 'library', kbId: kb.kbId }).length > 0 };
    }
    if (!['wiki.sync', 'codegraph.sync'].includes(job.kind) || !this.options.jobRunners?.[job.kind] || !job.workspace) return { exists: false, busy: false };
    try { if (!(await stat(job.workspace)).isDirectory()) return { exists: false, busy: false }; } catch { return { exists: false, busy: false }; }
    if (job.kind === 'wiki.sync') {
      const kb = this.wikiLibraries!.resolveLegacy(job.workspace);
      const bound = kb?.bindings.some((workspace) => normalizeWikiWorkspace(workspace) === normalizeWikiWorkspace(job.workspace));
      return { exists: Boolean(kb?.lifecycle === 'active' && bound), busy: !!kb && this.wikiLibraries!.activeTasks({ kind: 'library', kbId: kb.kbId }).length > 0 };
    }
    return { exists: true, busy: this.jobs!.list().some((other) => other.kind === job.kind && ['pending', 'running'].includes(other.state) && normalizeWikiWorkspace(other.workspace) === normalizeWikiWorkspace(job.workspace)) };
  }

  private async previewWikiRetry(job: Job): Promise<{ sourceIds?: string[]; targetCount: number; model: string }> {
    if (job.kind === 'wiki.ingest') {
      const payload = job.metadata?.payload;
      if (!payload || !('kbId' in payload)) throw new Error('TASK_RETRY_UNAVAILABLE');
      const sourceIds = payload.sourceIds.filter((id) => this.wikiSources!.get(payload.kbId, id)?.lifecycle === 'active');
      return this.wikiService!.previewIngest(payload.kbId, sourceIds);
    }
    if (!this.options.wikiModelLabel) throw new Error('MODEL_UNAVAILABLE');
    const model = await this.options.wikiModelLabel();
    const files = await scanWorkspaceMarkdown(job.workspace);
    return { targetCount: files.length, model };
  }

  private async retryTask(previous: Job, metadata: { retryOf: string }, options?: TaskRetryOptions): Promise<Job> {
    const current = this.jobs!.get(previous.id);
    if (!current || !['failed', 'cancelled'].includes(current.state)) throw new Error('TASK_RETRY_UNAVAILABLE');
    const target = await this.readTaskTarget(previous);
    if (!target.exists || target.busy) throw new Error(target.busy ? 'TASK_TARGET_BUSY' : 'TASK_TARGET_NOT_FOUND');
    if (this.closed) throw new Error('runtime is closed');
    if (previous.kind === 'wiki.ingest') {
      const payload = previous.metadata!.payload!;
      if (!('kbId' in payload)) throw new Error('TASK_RETRY_UNAVAILABLE');
      const receipt = await this.wikiService!.startIngest(payload.kbId, payload.sourceIds, undefined, options?.expectedModel, metadata.retryOf);
      this.dispatchIngest(receipt.jobId);
      return this.jobs!.get(receipt.jobId)!;
    }
    if (previous.kind === 'wiki.sync') {
      const preview = await this.previewWikiRetry(previous);
      if (preview.model !== options?.expectedModel) throw new Error('MODEL_CHANGED');
    }
    const again = await this.readTaskTarget(previous);
    if (!again.exists || again.busy || this.closed) throw new Error('TASK_TARGET_BUSY');
    return this.createUserJob(previous.kind, previous.workspace, { ...metadata }, options?.expectedModel);
  }

  private dispatchIngest(jobId: string): void {
    this.inFlight += 1;
    queueMicrotask(() => { void this.wikiService!.runIngest(jobId).catch((error) => {
      const job = this.jobs!.get(jobId);
      if (job?.state === 'pending' || job?.state === 'running') this.jobs!.fail(jobId, String(error));
    }).finally(() => { this.inFlight -= 1; this.finishClose(); }); });
  }

  private async workbenchOverview(userId: string): Promise<WorkbenchOverview> {
    const result: WorkbenchOverview = { recentPages: [], recentMemories: [], errors: [] };
    try {
      const libraries = this.wikiLibraries!.list().filter((kb) => kb.lifecycle === 'active');
      result.libraries = { total: libraries.length, pendingSources: 0, pages: 0 };
      for (const library of libraries) {
        result.libraries.pendingSources += this.wikiSources!.pending(library.kbId).length;
        const rows = this.storage!.db.prepare("SELECT page,title,updated_at FROM wiki_documents d WHERE kb_id=? AND NOT EXISTS (SELECT 1 FROM wiki_page_state s WHERE s.kb_id=d.kb_id AND s.page_id=d.page AND s.lifecycle!='active') ORDER BY updated_at DESC,page ASC").all(library.kbId);
        result.libraries.pages += rows.length;
        result.recentPages.push(...rows.slice(0, 5).map((row) => ({ kbId: library.kbId, pageId: String(row.page), title: String(row.title), libraryName: library.name, updatedAt: Number(row.updated_at) })));
      }
      result.recentPages.sort((a, b) => b.updatedAt - a.updatedAt); result.recentPages = result.recentPages.slice(0, 5);
    } catch { result.errors.push({ domain: 'wiki', message: '知识库概览暂不可用' }); }
    try { result.recentMemories = this.memory!.list({ userId, filter: { scope: 'all' }, limit: 5 }).items.map(({ id, content, level, updatedAt }) => ({ id, content: content.slice(0, 240), level, updatedAt })); }
    catch { result.errors.push({ domain: 'memory', message: '最近记忆暂不可用' }); }
    try {
      const counts = this.storage!.db.prepare("SELECT SUM(active) AS active,SUM(failed) AS failed FROM (SELECT state IN ('pending','running') AS active,state='failed' AS failed FROM agent_jobs UNION ALL SELECT status IN ('pending','queued','running','blocked') AS active,status='failed' AS failed FROM service_tasks)").get()!;
      result.activeTasks = Number(counts.active ?? 0); result.failedTasks = Number(counts.failed ?? 0);
    } catch { result.errors.push({ domain: 'tasks', message: '任务计数暂不可用' }); }
    if (this.diagnosticReport) result.diagnostics = { actionRequired: this.diagnosticReport.items.filter((item) => item.state === 'action_required').length, unchecked: this.diagnosticReport.items.filter((item) => item.state === 'unchecked').length };
    return result;
  }

  recordWikiSyncSkip(input: WikiSyncSkipInput): void {
    const job = this.jobs?.get(input.jobId);
    if (!job || job.kind !== 'wiki.sync' || normalizeWikiWorkspace(job.workspace) !== normalizeWikiWorkspace(input.workspace)) throw new Error('FORBIDDEN: Wiki task target does not match');
    const library = this.wikiLibraries!.resolveLegacy(job.workspace);
    if (!library) throw new Error('FORBIDDEN: Wiki task has no legacy library');
    this.storage!.db.prepare('INSERT INTO agent_audit(id,action,detail,created_at) VALUES(?,?,?,?)')
      .run(randomUUID(), 'wiki.sync.skip', JSON.stringify({ jobId: job.id, kbId: library.kbId, resource: { type: 'wiki', id: library.kbId }, resourceName: library.name, page: input.page, reason: input.reason }), Date.now());
  }

  private wikiContext(token: string, params: Record<string, unknown>): WikiRequestContext {
    const workspace = this.projectTokens.get(token);
    if (!workspace) throw new RpcError('FORBIDDEN', 'Wiki socket requests require a project endpoint');
    if (params.workspace !== undefined && normalizeWikiWorkspace(readString(params.workspace)) !== workspace) throw new RpcError('FORBIDDEN', 'workspace does not match endpoint');
    return { kind: 'project', workspace };
  }

  /** Main-process service work shares the same serialized system-task lane as memory extraction. */
  async runServiceTask(input: Omit<QueueTaskInput, 'system'>): Promise<unknown> {
    if (!this.taskQueue || this.closed) throw new Error('agent data task executor is not available');
    const params = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
    const legacy = input.kind === 'wiki_page_generate' && typeof params.workspace === 'string' ? this.ensureLegacyLibrary(params.workspace) : undefined;
    if (legacy) this.wikiLibraries!.recordTask({ taskSource: 'service_task', taskId: input.id, kbId: legacy.kbId, active: true, canCancel: false });
    this.inFlight += 1;
    try {
      const task = await this.taskQueue.enqueue({ ...input, system: true });
      if (task.status !== 'completed') throw new Error(task.error ?? `service task ${task.status}`);
      return task.output;
    } finally {
      if (legacy) this.wikiLibraries!.settleTask('service_task', input.id);
      this.inFlight -= 1; this.finishClose();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.taskQueue) {
      const queuedWiki = this.storage!.db.prepare("SELECT id FROM service_tasks WHERE kind='wiki_page_generate' AND status='queued'").all();
      for (const task of queuedWiki) this.taskQueue.cancel(String(task.id));
    }
    this.taskQueue?.stop();
    if (this.taskQueue && !this.taskQueue.isIdle()) void this.taskQueue.whenIdle().then(() => this.finishClose());
    for (const job of this.jobs?.list() ?? []) if (job.kind === 'wiki.ingest' && (job.state === 'pending' || job.state === 'running')) this.wikiService?.requestCancel(job.id);
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
        const method = value.method.startsWith('wiki.') ? this.wikiMethod(value.method, this.wikiContext(value.token, value.params))
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

  private wikiMethod(name: string, context: WikiRequestContext): AgentDataMethod | undefined {
    if (!this.wiki || !this.wikiLibraries || !this.wikiSources || !this.wikiService) return undefined;
    const libraries = this.wikiLibraries, sources = this.wikiSources, pages = this.wiki, service = this.wikiService;
    const allowed = ['wiki.libraries.list', 'wiki.libraries.read', 'wiki.pages.list', 'wiki.pages.read', 'wiki.pages.search', 'wiki.read', 'wiki.list', 'wiki.search', 'wiki.replace', 'wiki.reindex'];
    if (context.kind === 'project' && !allowed.includes(name)) throw new RpcError('FORBIDDEN', 'Wiki management is available only in the application');
    const library = (p: Record<string, unknown>) => {
      const kbId = readString(p.kbId);
      if (context.kind === 'project') return libraries.assertAccess(context, kbId);
      const value = libraries.get(kbId);
      if (!value || value.lifecycle === 'deleted') throw new RpcError('NOT_FOUND', 'Wiki library was not found');
      return value;
    };
    if (name === 'wiki.libraries.list') return (p) => {
      const query = typeof p.query === 'string' ? p.query.trim().toLocaleLowerCase() : '';
      const project = p.project === undefined ? undefined : normalizeWikiWorkspace(readString(p.project));
      return (context.kind === 'admin' ? libraries.list() : libraries.visibleLibraries(context))
        .filter((kb) => (!query || `${kb.name}\n${kb.description}`.toLocaleLowerCase().includes(query)) && (!project || kb.bindings.some((b) => normalizeWikiWorkspace(b) === project)))
        .map((kb) => this.visibleLibrary(this.libraryView(kb), context));
    };
    if (name === 'wiki.libraries.read') return (p) => this.visibleLibrary(this.libraryView(library(p)), context);
    if (name === 'wiki.libraries.create') return async (p) => this.libraryView(libraries.create(await this.libraryInput(p)));
    if (name === 'wiki.libraries.update') return async (p) => {
      const kb = library(p); const input = await this.libraryInput(p, kb);
      return this.libraryView(libraries.update(kb.kbId, input, readWikiRevision(p.expectedRevision)));
    };
    if (name === 'wiki.libraries.previewIngest') return (p) => service.previewIngest(library(p).kbId, readWikiIds(p.sourceIds), readWikiIds(p.regenerateSourceIds));
    if (name === 'wiki.libraries.ingest') return async (p) => {
      const receipt = await service.startIngest(library(p).kbId, readWikiIds(p.sourceIds), readWikiIds(p.regenerateSourceIds), p.expectedModel === undefined ? undefined : readString(p.expectedModel));
      this.dispatchIngest(receipt.jobId);
      return receipt;
    };
    if (name === 'wiki.libraries.reindex') return (p) => service.reindex(library(p).kbId);
    if (name === 'wiki.sources.list') return (p) => sources.list(library(p).kbId);
    if (name === 'wiki.sources.read') return (p) => {
      const kbId = library(p).kbId, sourceId = readString(p.sourceId); const source = sources.get(kbId, sourceId);
      if (!source) throw new RpcError('NOT_FOUND', 'Wiki source was not found');
      const revision = p.revision === undefined ? source.revision : readWikiRevision(p.revision);
      const content = sources.readSnapshot(kbId, { sourceId, revision });
      return { source, content, version: { revision, contentHash: wikiHash(content) } };
    };
    if (name === 'wiki.sources.previewImport') return (p) => service.previewImport(library(p).kbId, readString(p.projectWorkspace), readString(p.relativePath));
    if (name === 'wiki.sources.create') return (p) => service.addSource(library(p).kbId, readWikiSource(p));
    if (name === 'wiki.sources.update') return (p) => sources.updateText(library(p).kbId, readString(p.sourceId), readWikiText(p.content), readWikiVersion(p.expected));
    if (name === 'wiki.pages.list') return (p) => pages.listByLibrary(library(p).kbId).slice(0, context.kind === 'project' ? wikiLimit(p.limit, 50) : undefined).map(({ path, ...page }) => context.kind === 'admin' ? { ...page, path } : page);
    if (name === 'wiki.pages.read') return (p) => {
      const page = pages.readById(library(p).kbId, readString(p.pageId));
      if (!page || context.kind === 'admin') return page;
      const { path: _path, ...visible } = page; return visible;
    };
    if (name === 'wiki.pages.search') return (p) => {
      const kbIds = p.kbId === undefined ? libraries.visibleLibraries(context).map((kb) => kb.kbId) : [library(p).kbId];
      return pages.searchByLibraries(kbIds, readString(p.query), wikiLimit(p.limit, 20));
    };
    if (name === 'wiki.pages.create') return (p) => pages.createManual(library(p).kbId, readWikiPage(p));
    if (name === 'wiki.pages.update') return (p) => pages.saveManual(library(p).kbId, readString(p.pageId), { ...readWikiPage(p), expected: readWikiVersion(p.expected) });
    if (name === 'wiki.pages.setLocked') return (p) => {
      if (typeof p.locked !== 'boolean') throw new RpcError('INVALID_PARAMS', 'locked must be a boolean');
      return pages.setLocked(library(p).kbId, readString(p.pageId), p.locked, readWikiVersion(p.expected));
    };
    const deletion = /^(wiki\.(libraries|sources|pages))\.(previewDelete|remove)$/.exec(name);
    if (deletion) return (p) => {
      const kbId = library(p).kbId;
      const target: WikiTarget = deletion[2] === 'libraries' ? { kbId, kind: 'library' }
        : deletion[2] === 'sources' ? { kbId, kind: 'source', sourceId: readString(p.sourceId) } : { kbId, kind: 'page', pageId: readString(p.pageId) };
      if (deletion[3] === 'previewDelete') return service.previewDelete(target);
      if (typeof p.cancelActive !== 'boolean') throw new RpcError('INVALID_PARAMS', 'cancelActive must be a boolean');
      return service.remove(target, p.cancelActive);
    };
    if (['wiki.read', 'wiki.list', 'wiki.search', 'wiki.replace', 'wiki.reindex', 'wiki.deleteWorkspace'].includes(name)) return (p) => {
      let kb = this.legacyLibrary(context, p);
      if (!kb && context.kind === 'admin' && name === 'wiki.replace') kb = this.ensureLegacyLibrary(readString(p.workspace));
      if (name === 'wiki.search' && context.kind === 'admin' && p.workspace === undefined) return pages.search({}, readString(p.query), wikiLimit(p.limit, 20));
      if (name === 'wiki.list' && context.kind === 'admin' && p.workspace === undefined) return pages.listPages({}).slice(0, wikiLimit(p.limit, 50));
      if (name === 'wiki.reindex' && context.kind === 'admin' && p.workspace === undefined) return pages.rebuildIndex({});
      if (!kb) {
        if (name === 'wiki.read') return undefined;
        if (name === 'wiki.search' || name === 'wiki.list') return [];
        throw new RpcError('FORBIDDEN', 'the project has no legacy Wiki mapping; use library management');
      }
      const scope = { workspace: kb.legacyWorkspace! };
      if (name === 'wiki.read') {
        const pageId = readString(p.page), page = pages.readPage(scope, pageId), version = pages.readById(kb.kbId, pageId);
        return page && version ? { ...page, revision: version.revision, contentHash: version.contentHash } : undefined;
      }
      if (name === 'wiki.list') return pages.listPages(scope).slice(0, wikiLimit(p.limit, 50));
      if (name === 'wiki.search') return pages.search(scope, readString(p.query), wikiLimit(p.limit, 20));
      if (name === 'wiki.reindex') return service.reindex(kb.kbId);
      if (name === 'wiki.deleteWorkspace') return service.remove({ kind: 'library', kbId: kb.kbId }, true);
      return pages.replaceLegacyProtected(scope, readString(p.page), readString(p.title), readWikiText(p.content), typeof p.sourcePath === 'string' ? p.sourcePath : undefined, typeof p.sourceContent === 'string' ? p.sourceContent : undefined, p.expected === null ? null : p.expected === undefined ? undefined : readWikiVersion(p.expected));
    };
    if (name === 'wiki.admin.overview') return (p) => pages.overview(readWikiQueryScope(p));
    return undefined;
  }

  private legacyLibrary(context: WikiRequestContext, params: Record<string, unknown>): WikiLibrary | undefined {
    const workspace = context.kind === 'project' ? context.workspace : params.workspace === undefined ? undefined : readString(params.workspace);
    if (!workspace) return undefined;
    const library = this.wikiLibraries!.resolveLegacy(workspace);
    if (library && context.kind === 'project') this.wikiLibraries!.assertAccess(context, library.kbId);
    return library;
  }

  private ensureLegacyLibrary(workspace: string): WikiLibrary {
    let library = this.wikiLibraries!.resolveLegacy(workspace);
    if (!library) {
      this.wikiLibraries!.files.manifest(workspace, true);
      this.wikiLibraries!.registerLegacyBuckets();
      library = this.wikiLibraries!.resolveLegacy(workspace);
    }
    if (!library) throw new RpcError('WIKI_UNAVAILABLE', 'legacy Wiki registration failed');
    return this.wikiLibraries!.assertActive(library.kbId);
  }

  private async libraryInput(p: Record<string, unknown>, current?: WikiLibrary): Promise<WikiLibraryInput> {
    const bindings = readWikiIds(p.bindings);
    if (!bindings) throw new RpcError('INVALID_PARAMS', 'bindings must be an array');
    const validated: string[] = [];
    for (const binding of bindings) {
      const old = current?.bindings.find((b) => normalizeWikiWorkspace(b) === normalizeWikiWorkspace(binding));
      if (old) validated.push(old);
      else {
        if (!this.options.validateProject) throw new RpcError('PROJECT_VALIDATOR_UNAVAILABLE', 'project validation is unavailable');
        validated.push(await this.options.validateProject(binding));
      }
    }
    return { name: readString(p.name), description: readWikiText(p.description), bindings: validated };
  }

  private libraryView(kb: WikiLibrary): WikiLibraryView {
    const sourceCounts = this.storage!.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN generation_suppressed=0 AND (status='failed' OR processed_hash IS NULL OR processed_hash!=content_hash) THEN 1 ELSE 0 END) AS pending FROM wiki_sources WHERE kb_id=? AND lifecycle='active'").get(kb.kbId)!;
    const pageCount = Number(this.storage!.db.prepare("SELECT COUNT(*) AS total FROM wiki_documents d WHERE kb_id=? AND NOT EXISTS (SELECT 1 FROM wiki_page_state s WHERE s.kb_id=d.kb_id AND s.page_id=d.page AND s.lifecycle!='active')").get(kb.kbId)!.total);
    const sourceCount = Number(sourceCounts.total), pendingSourceCount = Number(sourceCounts.pending ?? 0);
    const task = this.wikiLibraries!.activeTasks({ kind: 'library', kbId: kb.kbId }).find((t) => t.taskSource === 'agent_job');
    const diagnostics: WikiDiagnostic[] = [...this.wikiLibraries!.diagnostics, ...this.wiki!.diagnostics];
    const diagnostic = diagnostics.find((d) => d.kbId === kb.kbId);
    const deletingTargets: WikiTarget[] = kb.lifecycle === 'deleting' ? [{ kind: 'library', kbId: kb.kbId }] : [];
    for (const row of this.storage!.db.prepare("SELECT source_id FROM wiki_sources WHERE kb_id=? AND lifecycle='deleting'").all(kb.kbId)) deletingTargets.push({ kind: 'source', kbId: kb.kbId, sourceId: String(row.source_id) });
    for (const row of this.storage!.db.prepare("SELECT page_id FROM wiki_page_state WHERE kb_id=? AND lifecycle='deleting'").all(kb.kbId)) deletingTargets.push({ kind: 'page', kbId: kb.kbId, pageId: String(row.page_id) });
    return { ...kb, location: this.wikiLibraries!.files.bucketDir(kb), sourceCount, pageCount, pendingSourceCount,
      availability: pageCount ? 'available' : sourceCount ? 'pending' : 'draft',
      deletingTargets, ...(task ? { activeJobId: task.taskId } : {}), ...(diagnostic ? { lastError: diagnostic.message } : {}),
    };
  }

  private visibleLibrary(kb: WikiLibraryView, context: WikiRequestContext) {
    if (context.kind === 'admin') return kb;
    return { kbId: kb.kbId, name: kb.name, description: kb.description, sourceCount: kb.sourceCount, pageCount: kb.pageCount, pendingSourceCount: kb.pendingSourceCount, availability: kb.availability };
  }

  /** Generic job commands must not become a second Wiki management entry. */
  private projectJobMethod(name: string, params: Record<string, unknown>): AgentDataMethod | undefined {
    if (name === 'admin.export' || name === 'admin.audit.list') throw new RpcError('FORBIDDEN', 'aggregate management history is available only in the application');
    if (!name.startsWith('admin.jobs.')) return undefined;
    if (name === 'admin.jobs.list') return (p) => this.jobs!.list(p.state === undefined ? undefined : readJobState(p.state)).filter((job) => !isWikiJob(job));
    const ids = name === 'admin.jobs.clear' && Array.isArray(params.ids) ? params.ids : [params.id];
    if ((name === 'admin.jobs.create' && typeof params.kind === 'string' && params.kind.startsWith('wiki.'))
      || ids.some((id) => typeof id === 'string' && isWikiJob(this.jobs!.get(id)))) {
      throw new RpcError('FORBIDDEN', 'Wiki jobs are managed only in the application');
    }
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
      if (job?.kind === 'wiki.ingest') { this.wikiService!.requestCancel(id); return this.jobs!.get(id); }
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
      if (kind === 'wiki.ingest') throw new RpcError('INVALID_PARAMS', 'use the explicit Wiki ingest entry');
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
    const kb = kind === 'wiki.sync' && runner ? this.ensureLegacyLibrary(workspace) : undefined;
    const create = () => {
      if (metadata?.retryOf) {
        const original = this.jobs!.get(metadata.retryOf);
        if (!original || !['failed', 'cancelled'].includes(original.state) || original.kind !== kind || original.workspace !== workspace
          || (kb && (this.wikiLibraries!.get(kb.kbId)?.lifecycle !== 'active' || !kb.bindings.some((binding) => normalizeWikiWorkspace(binding) === normalizeWikiWorkspace(workspace))))) throw new Error('TASK_RETRY_UNAVAILABLE');
      }
      if (runner && this.jobs!.list().some((job) => job.kind === kind && ['pending', 'running'].includes(job.state) && normalizeWikiWorkspace(job.workspace) === normalizeWikiWorkspace(workspace))) throw new RpcError('JOB_ALREADY_RUNNING', `${kind} is already running for this workspace`);
      if (kb && this.wikiLibraries!.activeTasks({ kind: 'library', kbId: kb.kbId }).length) throw new RpcError('JOB_ALREADY_RUNNING', 'Wiki library has an active writer');
      const target = kb ? { type: 'wiki' as const, id: kb.kbId } : kind === 'codegraph.sync' ? { type: 'project' as const, id: workspace } : undefined;
      const job = this.jobs!.create({ kind, workspace, ...(target || metadata ? { metadata: { ...metadata, ...(target ? { target, resourceName: kb?.name ?? workspace } : {}) } } : {}) });
      if (kb) this.wikiLibraries!.recordTask({ taskSource: 'agent_job', taskId: job.id, kbId: kb.kbId, active: true, canCancel: true });
      return job;
    };
    const job = this.wikiLibraries!.transaction(create);
    if (runner) {
      this.inFlight += 1;
      void Promise.resolve().then(() => runner.run(job.id, workspace, expectedModel)).catch((error) => {
        const current = this.jobs!.get(job.id);
        if (!current || ['cancelled', 'completed', 'failed'].includes(current.state)) return;
        this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error));
      }).finally(() => { if (kb) this.wikiLibraries!.settleTask('agent_job', job.id); this.inFlight -= 1; this.finishClose(); });
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
function isWikiJob(job: Job | undefined): boolean { return !!job && (job.kind.startsWith('wiki.') || job.metadata?.target?.type === 'wiki'); }
function readWikiText(value: unknown): string { if (typeof value !== 'string') throw new RpcError('INVALID_PARAMS', 'text parameter is required'); return value; }
function readWikiRevision(value: unknown): number { if (!Number.isInteger(value) || Number(value) < 0) throw new RpcError('INVALID_PARAMS', 'expected revision is required'); return Number(value); }
function readWikiVersion(value: unknown): WikiVersion {
  const version = readRecord(value);
  return { revision: readWikiRevision(version.revision), contentHash: readString(version.contentHash) };
}
function readWikiIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RpcError('INVALID_PARAMS', 'IDs must be an array');
  return [...new Set(value.map(readString))];
}
function readWikiPage(value: Record<string, unknown>): WikiPageInput {
  if (!Array.isArray(value.sourceRefs)) throw new RpcError('INVALID_PARAMS', 'sourceRefs must be an array');
  const refs = new Map<string, WikiSourceRef>();
  for (const item of value.sourceRefs) {
    const ref = readRecord(item), revision = readWikiRevision(ref.revision), sourceId = readString(ref.sourceId);
    if (revision < 1) throw new RpcError('INVALID_PARAMS', 'sourceRefs revision must be positive');
    refs.set(JSON.stringify([sourceId, revision]), { sourceId, revision });
  }
  return { title: readString(value.title), content: readWikiText(value.content), sourceRefs: [...refs.values()] };
}
function readWikiSource(value: Record<string, unknown>): WikiSourceInput {
  if (value.kind === 'manual' || value.kind === 'upload') return { kind: value.kind, name: readString(value.name), content: readWikiText(value.content) };
  if (value.kind === 'project') return { kind: value.kind, projectWorkspace: readString(value.projectWorkspace), relativePath: readString(value.relativePath), expectedContentHash: readString(value.expectedContentHash) };
  throw new RpcError('INVALID_PARAMS', 'invalid Wiki source kind');
}
function wikiLimit(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.trunc(value))) : fallback; }
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
function readWikiQueryScope(value: Record<string, unknown>): import('./wikiStore').WikiScope {
  return typeof value.workspace === 'string' && value.workspace.trim() ? { workspace: value.workspace } : {};
}
function readRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_PARAMS', 'object parameter is required'); return value as Record<string, unknown>; }
function readStringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new RpcError('INVALID_PARAMS', 'string array is required'); return [...value] as string[]; }
function isTurnStatus(value: unknown): value is import('../app/appServer/types').TurnStatus { return value === 'queued' || value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function readItemType(value: unknown): import('../app/appServer/types').ItemType { if (value === 'user_message' || value === 'assistant_message' || value === 'reasoning' || value === 'tool_call' || value === 'tool_result' || value === 'permission_request' || value === 'error') return value; throw new RpcError('INVALID_PARAMS', 'invalid item type'); }
function readItemStatus(value: unknown): import('../app/appServer/types').ItemStatus { if (value === 'started' || value === 'streaming' || value === 'completed' || value === 'failed') return value; throw new RpcError('INVALID_PARAMS', 'invalid item status'); }
