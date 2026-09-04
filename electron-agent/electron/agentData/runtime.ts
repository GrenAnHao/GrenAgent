import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { AgentDataStorage } from './storage';
import { ThreadStore } from './threadStore';
import { MemoryStore } from './memoryStore';
import { WikiStore } from './wikiStore';
import { JobStore } from './jobStore';
import { MemoryService, type MemoryTaskQueue } from '../app/memoryService';
import { ServiceTaskRegistry } from '../app/appServer/serviceTaskRegistry';
import { TaskQueue } from '../app/appServer/taskQueue';
import type { ServiceTask } from '../app/appServer/types';
import { isRpcRequest, PROTOCOL_VERSION, RpcError, type AgentDataEndpoint, type RpcResponse } from './protocol';

export type AgentDataMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface AgentDataJobRunner {
  run(jobId: string, workspace: string): Promise<void>;
  cancel(jobId: string): void;
}

export interface AgentDataRuntimeOptions {
  dataPath: string;
  methods?: Record<string, AgentDataMethod>;
  stdin?: NodeJS.ReadableStream;
  executeServiceTask?: (task: ServiceTask) => Promise<unknown>;
  /** 按 job kind 注册的执行器：创建即派发，取消时通知。未注册的 kind 只落库。 */
  jobRunners?: Record<string, AgentDataJobRunner>;
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
  private jobs?: JobStore;
  private threads?: ThreadStore;
  private memoryService?: MemoryService;

  constructor(private readonly options: AgentDataRuntimeOptions) {}

  async start(): Promise<AgentDataEndpoint> {
    if (this.endpoint) return this.endpoint;
    this.storage = new AgentDataStorage(this.options.dataPath);
    this.storage.migrate();
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
      });
      this.memoryService = new MemoryService({ store: this.memory, queue });
      queue.recoverRunning();
    } else {
      this.memoryService = new MemoryService({ store: this.memory, queue: fallbackQueue });
    }
    this.wiki = new WikiStore(this.storage.db);
    this.jobs = new JobStore(this.storage.db);
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.inFlight === 0) this.storage?.close();
    this.endpoint = undefined;
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) { socket.destroy(); return; }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        void this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    this.inFlight += 1;
    let response: RpcResponse;
    let shutdown = false;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC request');
      if (value.token !== this.token) throw new RpcError('UNAUTHORIZED', 'invalid token');
      if (value.method === 'system.hello') response = { id: value.id, ok: true, result: { version: PROTOCOL_VERSION } };
      else if (value.method === 'system.status') response = { id: value.id, ok: true, result: { state: this.closed ? 'closed' : 'ready', version: PROTOCOL_VERSION } };
      else if (value.method === 'system.shutdown') { response = { id: value.id, ok: true, result: null }; shutdown = true; }
      else {
        const method = this.options.methods?.[value.method] ?? this.memoryMethod(value.method) ?? this.wikiMethod(value.method) ?? this.adminMethod(value.method) ?? this.threadMethod(value.method);
        if (!method) throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${value.method}`);
        response = { id: value.id, ok: true, result: await method(value.params) };
      }
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
      response = { id: this.requestId(line), ok: false, error: { code: e.code, message: e.message } };
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`, () => { if (shutdown) this.close(); });
    this.inFlight -= 1;
    if (this.closed && this.inFlight === 0) this.storage?.close();
  }

  private wikiMethod(name: string): AgentDataMethod | undefined {
    if (!this.wiki) return undefined;
    if (name === 'wiki.replace') return (params) => this.wiki!.replacePage({ workspace: readString(params.workspace) }, readString(params.page), readString(params.title), readString(params.content), typeof params.sourcePath === 'string' ? params.sourcePath : undefined);
    if (name === 'wiki.search') return (params) => this.wiki!.search(readWikiQueryScope(params), readString(params.query), typeof params.limit === 'number' ? params.limit : 20);
    if (name === 'wiki.admin.overview') return (params) => this.wiki!.overview(readWikiQueryScope(params));
    if (name === 'wiki.deleteWorkspace') return (params) => { this.wiki!.deleteWorkspace({ workspace: readString(params.workspace) }); return null; };
    return undefined;
  }

  private memoryMethod(name: string): AgentDataMethod | undefined {
    if (!this.memory) return undefined;
    if (name === 'memory.upsert') return (params) => this.memory!.upsert(readScope(params), {
      level: readLevel(params.level), content: readString(params.content), source: typeof params.source === 'string' ? params.source : undefined,
    });
    if (name === 'memory.capture') return (params) => this.memoryService!.capture({ ...readScope(params), projectId: typeof params.projectId === 'string' ? params.projectId : readString(params.workspace), source: readString(params.source), transcript: readString(params.transcript), fingerprint: readString(params.fingerprint) });
    if (name === 'memory.captureCommit' || name === 'memory.commitCapture') return (params) => { this.memory!.commitCapture(readScope(params), readString(params.source), readString(params.fingerprint)); return null; };
    if (name === 'memory.completeExtraction') return (params) => this.memoryService!.completeExtraction(readString(params.taskId), params.output);
    if (name === 'memory.search') return (params) => this.memoryService!.search({ ...readQueryScope(params), projectId: typeof params.projectId === 'string' ? params.projectId : (typeof params.workspace === 'string' ? params.workspace : ''), query: readString(params.query), limit: typeof params.limit === 'number' ? params.limit : 20 });
    if (name === 'memory.admin.overview') return (params) => this.memory!.overview(readQueryScope(params));
    if (name === 'memory.delete') return (params) => { this.memory!.remove(readScope(params), readString(params.id)); return null; };
    return undefined;
  }

  private adminMethod(name: string): AgentDataMethod | undefined {
    if (!this.jobs) return undefined;
    if (name === 'admin.jobs.list') return (params) => this.jobs!.list(params.state === undefined ? undefined : readJobState(params.state));
    if (name === 'codeRetrieval.admin.status') return () => ({ connected: false, indexed: false });
    if (name === 'codeRetrieval.search') return (p) => ({ workspace: readString(p.workspace), available: false, results: [], message: 'CodeGraph index is not connected' });
    if (name === 'admin.jobs.get') return (p) => this.jobs!.get(readString(p.id));
    if (name === 'admin.jobs.cancel') return (p) => {
      const id = readString(p.id);
      const job = this.jobs!.get(id);
      const runner = job ? this.options.jobRunners?.[job.kind] : undefined;
      if (!runner) return this.jobs!.cancel(id);
      // 有执行器时取消只是"请求"：状态由执行器确认停止后通过 admin.jobs.markCancelled 落定，
      // 避免出现"状态已取消但后台还在写文件"。
      runner.cancel(id);
      return this.jobs!.get(id);
    };
    if (name === 'admin.jobs.markCancelled') return (p) => this.jobs!.cancel(readString(p.id));
    if (name === 'admin.jobs.create') return (p) => {
      const kind = readString(p.kind);
      const workspace = readString(p.workspace);
      const runner = this.options.jobRunners?.[kind];
      // 同 workspace 同 kind 已有未结束任务时拒绝：避免两个同步进程并发写同一份索引。
      if (runner && this.jobs!.hasActive(kind, workspace)) throw new RpcError('JOB_ALREADY_RUNNING', `${kind} is already running for this workspace`);
      const job = this.jobs!.create({ kind, workspace });
      // fire-and-forget：执行器自己把状态写回 agent_jobs，创建调用不等它完成。
      if (runner) void runner.run(job.id, workspace).catch((error) => this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error)));
      return job;
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
function isTurnStatus(value: unknown): value is import('../app/appServer/types').TurnStatus { return value === 'queued' || value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function readItemType(value: unknown): import('../app/appServer/types').ItemType { if (value === 'user_message' || value === 'assistant_message' || value === 'reasoning' || value === 'tool_call' || value === 'tool_result' || value === 'permission_request' || value === 'error') return value; throw new RpcError('INVALID_PARAMS', 'invalid item type'); }
function readItemStatus(value: unknown): import('../app/appServer/types').ItemStatus { if (value === 'started' || value === 'streaming' || value === 'completed' || value === 'failed') return value; throw new RpcError('INVALID_PARAMS', 'invalid item status'); }
