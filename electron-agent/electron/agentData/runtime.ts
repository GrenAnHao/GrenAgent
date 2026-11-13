import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataStorage } from './storage';
import type { IndexTaskStore } from '../app/codeGraph/indexTaskStore';
import { ThreadStore } from './threadStore';
import { AgentDataDiagnostics } from '../app/agentDataDiagnostics';
import type { DiagnosticReport, JobMetadata, TaskListInput, TaskRef, TaskRetryOptions } from './operationsContracts';
import type { Job } from './jobStore';
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
  methods?: Record<string, AgentDataMethod>;
  stdin?: NodeJS.ReadableStream;
  /** hooks.onUsage 由执行器在每次模型调用后回报用量，落到 service_tasks 的 token 列。 */
  executeServiceTask?: (task: ServiceTask, hooks?: ServiceTaskHooks) => Promise<unknown>;
  /** 按 job kind 注册的执行器：创建即派发，取消时通知。未注册的 kind 只落库。 */
  jobRunners?: Record<string, AgentDataJobRunner>;
  codeRetrieval?: AgentDataCodeRetrievalProvider;
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
  /** codegraph 自己的索引任务记录；传入后 codegraph.sync 不再写 agent_jobs。 */
  indexTasks?: IndexTaskStore;
}

export class AgentDataRuntime {
  private server?: Server;
  private storage?: AgentDataStorage;
  private endpoint?: AgentDataEndpoint;
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private inFlight = 0;
  private readonly token: string;
  private diagnostics?: AgentDataDiagnostics;
  private diagnosticReport?: DiagnosticReport;
  private readonly projectTokens = new Map<string, string>();
  private readonly workspaceTokens = new Map<string, string>();
  private readonly closeWaiters: Array<() => void> = [];
  private threads?: ThreadStore;
  private taskQueue?: TaskQueue;
  private toolPermission?: ToolDecisionService;

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
    if (this.options.executeServiceTask) {
      this.taskQueue = new TaskQueue({
        storage: this.storage,
        registry: new ServiceTaskRegistry(),
        execute: this.options.executeServiceTask,
      });
      this.taskQueue.recoverRunning();
    }
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
    return this.endpoint;
  }

  /**
   * 执行器（jobRunners）都在本进程里：启动时还是 pending / running 的这类任务，执行它的是上一个进程，已经没有人在跑。
   * 请求过取消的记为已取消，其余记为失败（可重试）。不收尾的话它们永远占着「运行中」：新的同类任务报
   * JOB_ALREADY_RUNNING，取消永远等不到确认，删除和重试也不可用。没有执行器的种类只落库、不归本进程管，不动。
   */

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
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    this.inFlight += 1;
    const begun = performance.now();
    let label = 'admin.unknown';
    let syncMs = 0;
    let stop = agentDataTiming.start();
    try {
      const method = this.operationsMethod(name) ?? this.adminMethod(name, params, true);
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
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    const method = this.adminMethod(name, params);
    if (!method) throw new Error(`not a job lifecycle method: ${name}`);
    return await method(params) as T;
  }

  /** plugin_state 表的读写（子进程模式下主进程的 PluginManager 经 RPC 用它）。 */
  pluginStateStore(): PluginStateStore {
    if (!this.storage || this.closed) throw new Error('agent data runtime is not started');
    return new PluginStateStore(this.storage.db);
  }

  private operationsMethod(name: string): AgentDataMethod | undefined {
    // 任务视图已下线；这里只保留诊断检查。
    if (!this.diagnostics) return undefined;
    if (name === 'admin.diagnostics.check') return async () => (this.diagnosticReport = await this.diagnostics!.check());
    return undefined;
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
        const method = projectJobs ?? this.options.methods?.[value.method] ?? this.adminMethod(value.method, value.params ?? {}) ?? this.toolPermissionMethod(value.method, workspace) ?? this.threadMethod(value.method);
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

  /**
   * 最小端点复用：按工作区 owner 取工具授权处理函数。
   * owner 来自端点侧的令牌，不能由请求负载决定；未知方法返回 undefined。
   */
  extensionMethod(name: string, owner: string): AgentDataMethod | undefined {
    if (!name.startsWith('permission.tool.')) return undefined;
    return this.toolPermissionMethod(name, owner);
  }

  /** 工具授权 RPC。workspace 由 token 决定，调用方自报的值一律被覆盖。 */
  private toolPermissionMethod(name: string, workspace: string | undefined): AgentDataMethod | undefined {
    if (!this.toolPermission) return undefined;
    return toolPermissionMethods(this.toolPermission, workspace)[name];
  }

  /** Generic job commands must not become a second Wiki management entry. */
  private projectJobMethod(name: string): AgentDataMethod | undefined {
    if (name === 'admin.export' || name === 'admin.audit.list') throw new RpcError('FORBIDDEN', 'aggregate management history is available only in the application');
    return undefined;
  }

  private adminMethod(name: string, params: Record<string, unknown>, trusted = false): AgentDataMethod | undefined {
    // agent_jobs/agent_config/agent_audit 已随任务面下线：admin.jobs.* 的写路径由各执行器端口处理，
    // 代码索引状态与任务由 CodeGraph 端口及 IndexTaskStore 持有。
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
    // codegraph.sync 是唯一仍经此入口创建的任务：它落在 codegraph 自己的 index-tasks.sqlite。
    if (name === 'admin.jobs.create') {
      const kind = typeof params?.kind === 'string' ? params.kind : '';
      if (kind !== 'codegraph.sync' || !this.options.indexTasks) throw new RpcError('METHOD_NOT_FOUND', 'job creation is retired for ' + (kind || 'missing kind'));
      return (createParams: Record<string, unknown>) => this.createIndexTask(readString(createParams.workspace));
    }
    if (name.startsWith('admin.jobs.')) throw new RpcError('METHOD_NOT_FOUND', 'job administration is retired; use the owning executor port');
    if (name.startsWith('admin.config.')) throw new RpcError('METHOD_NOT_FOUND', 'shared configuration storage is retired');
    return undefined;
  }



  /**
   * 执行器（jobRunners）都在本进程里：启动时还是 pending / running 的这类任务，执行它的是上一个进程，已经没有人在跑。
   * 请求过取消的记为已取消，其余记为失败（可重试）。不收尾的话它们永远占着「运行中」：新的同类任务报
   * JOB_ALREADY_RUNNING，取消永远等不到确认，删除和重试也不可用。没有执行器的种类只落库、不归本进程管，不动。
   */

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
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    this.inFlight += 1;
    const begun = performance.now();
    let label = 'admin.unknown';
    let syncMs = 0;
    let stop = agentDataTiming.start();
    try {
      const method = this.operationsMethod(name) ?? this.adminMethod(name, params, true);
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
    if (!this.endpoint || this.closed) throw new Error('agent data runtime is not started');
    const method = this.adminMethod(name, params);
    if (!method) throw new Error(`not a job lifecycle method: ${name}`);
    return await method(params) as T;
  }

  /** plugin_state 表的读写（子进程模式下主进程的 PluginManager 经 RPC 用它）。 */
  pluginStateStore(): PluginStateStore {
    if (!this.storage || this.closed) throw new Error('agent data runtime is not started');
    return new PluginStateStore(this.storage.db);
  }

  private operationsMethod(name: string): AgentDataMethod | undefined {
    // 任务视图已下线；这里只保留诊断检查。
    if (!this.diagnostics) return undefined;
    if (name === 'admin.diagnostics.check') return async () => (this.diagnosticReport = await this.diagnostics!.check());
    return undefined;
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
        const method = projectJobs ?? this.options.methods?.[value.method] ?? this.adminMethod(value.method, value.params ?? {}) ?? this.toolPermissionMethod(value.method, workspace) ?? this.threadMethod(value.method);
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

  /**
   * 最小端点复用：按工作区 owner 取工具授权处理函数。
   * owner 来自端点侧的令牌，不能由请求负载决定；未知方法返回 undefined。
   */
  extensionMethod(name: string, owner: string): AgentDataMethod | undefined {
    if (!name.startsWith('permission.tool.')) return undefined;
    return this.toolPermissionMethod(name, owner);
  }

  /** 工具授权 RPC。workspace 由 token 决定，调用方自报的值一律被覆盖。 */
  private toolPermissionMethod(name: string, workspace: string | undefined): AgentDataMethod | undefined {
    if (!this.toolPermission) return undefined;
    return toolPermissionMethods(this.toolPermission, workspace)[name];
  }

  /** Generic job commands must not become a second Wiki management entry. */


  /**
   * codegraph 索引任务：创建即派发到已注册的 codegraph.sync 执行器。
   * 返回的 Job 只是调用方需要的形状适配，落库的是 IndexTaskStore 自己的记录。
   */
  private createIndexTask(workspace: string): Job {
    const store = this.options.indexTasks!;
    const active = store.activeFor(workspace);
    const task = active ?? store.create({ id: randomUUID(), workspace, origin: 'manual' });
    if (!active) {
      const runner = this.options.jobRunners?.['codegraph.sync'];
      this.inFlight += 1;
      void Promise.resolve().then(() => runner?.run(task.id, workspace)).catch((error) => {
        const current = store.get(task.id);
        if (!current || ['cancelled', 'completed', 'failed'].includes(current.state)) return;
        store.fail(task.id, error instanceof Error ? error.message : String(error));
      }).finally(() => { this.inFlight -= 1; this.finishClose(); });
    }
    return { id: task.id, kind: 'codegraph.sync', workspace: task.workspace, state: task.state === 'paused' || task.state === 'blocked' ? task.state : task.state, progress: task.progress,
      ...(task.error === undefined ? {} : { error: task.error }), metadata: { target: { type: 'project', id: workspace }, resourceName: workspace },
      createdAt: task.createdAt, updatedAt: task.updatedAt } as Job;
  }

  private sameJobTarget(a: Pick<Job, 'kind' | 'workspace' | 'metadata'>, b: Pick<Job, 'kind' | 'workspace' | 'metadata'>): boolean {
    return normalizeWorkspace(a.workspace) === normalizeWorkspace(b.workspace);
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
    if (name === 'thread.create') return (p) => this.threads!.createThread({ id: readString(p.id, 'thread.create.id'), projectId: readString(p.projectId, 'thread.create.projectId'), workspace: readString(p.workspace, 'thread.create.workspace'), title: typeof p.title === 'string' ? p.title : undefined });
    if (name === 'thread.list') return () => this.threads!.listThreads();
    if (name === 'thread.read') return (p) => this.threads!.readThread(readString(p.id, 'thread.read.id'));
    if (name === 'turn.create') return (p) => this.threads!.createTurn({ id: readString(p.id, 'turn.create.id'), threadId: readString(p.threadId, 'turn.create.threadId'), input: readText(p.input, 'turn.create.input'), permissionProfile: readString(p.permissionProfile, 'turn.create.permissionProfile'), mode: p.mode === 'non-interactive' ? 'non-interactive' : 'interactive' });
    if (name === 'turn.update') return (p) => this.threads!.updateTurn(readString(p.id, 'turn.update.id'), {
      ...(isTurnStatus(p.status) ? { status: p.status } : {}),
      ...(typeof p.startedAt === 'number' ? { startedAt: p.startedAt } : {}),
      ...(typeof p.completedAt === 'number' ? { completedAt: p.completedAt } : {}),
      ...(typeof p.error === 'string' ? { error: p.error } : {}),
    });
    if (name === 'item.upsert') return (p) => this.threads!.upsertItem({ id: readString(p.id, 'item.upsert.id'), threadId: readString(p.threadId, 'item.upsert.threadId'), turnId: readString(p.turnId, 'item.upsert.turnId'), type: readItemType(p.type), status: readItemStatus(p.status), payload: p.payload });
    if (name === 'item.list') return (p) => this.threads!.listItems(readString(p.threadId, 'item.list.threadId'), p.turnId === undefined ? undefined : readString(p.turnId, 'item.list.turnId'));
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
function normalizeWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('workspace is required');
  const normalized = resolve(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function readString(value: unknown, field?: string): string { if (typeof value !== 'string' || !value.trim()) throw new RpcError('INVALID_PARAMS', field ? `${field} must be a non-empty string` : 'string parameter is required'); return value; }
function readText(value: unknown, field: string): string { if (typeof value !== 'string') throw new RpcError('INVALID_PARAMS', `${field} must be a string`); return value; }
function readJobState(value: unknown): import('./jobStore').JobState { if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') return value; throw new RpcError('INVALID_PARAMS', 'invalid job state'); }
function readRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('INVALID_PARAMS', 'object parameter is required'); return value as Record<string, unknown>; }
function readStringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new RpcError('INVALID_PARAMS', 'string array is required'); return [...value] as string[]; }
function isTurnStatus(value: unknown): value is import('../app/appServer/types').TurnStatus { return value === 'queued' || value === 'running' || value === 'blocked' || value === 'completed' || value === 'failed' || value === 'cancelled'; }
function readItemType(value: unknown): import('../app/appServer/types').ItemType { if (value === 'user_message' || value === 'assistant_message' || value === 'reasoning' || value === 'tool_call' || value === 'tool_result' || value === 'permission_request' || value === 'error') return value; throw new RpcError('INVALID_PARAMS', 'invalid item type'); }
function readItemStatus(value: unknown): import('../app/appServer/types').ItemStatus { if (value === 'started' || value === 'streaming' || value === 'completed' || value === 'failed') return value; throw new RpcError('INVALID_PARAMS', 'invalid item status'); }
