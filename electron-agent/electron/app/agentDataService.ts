import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentDataClient } from '../agentData/client';
import type { AgentDataRuntimeOptions } from '../agentData/runtime';
import { AgentDataRuntime } from '../agentData/runtime';
import type { AgentDataEndpoint } from '../agentData/protocol';
import type { Item, Thread, Turn } from './appServer/types';
import type { CreateThreadInput, CreateTurnInput, ThreadSnapshot } from '../agentData/threadStore';
import type { QueueTaskInput } from './appServer/taskQueue';
import type { PluginStateRecord } from './plugin/pluginManager';
// CodeGraph calls may cold-load the embedded SDK and its index. Keep this aligned with
// extensions/code-retrieval's 65s client timeout instead of AgentDataClient's
// short default used by lightweight callers.
const AGENT_DATA_SERVICE_TIMEOUT_MS = 65_000;

/** child 模式下主进程持有的子进程客户端（AgentProcessClient 满足）。 */
export interface AgentDataProcessPort {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  shutdown(): Promise<void>;
  readonly isRunning: boolean;
}

/** inproc：由 assembleAgentData 装配好的运行时（还没 start）。 */
export interface AgentDataAssembledOptions {
  runtime: AgentDataRuntime;
  onKnownWorkspace?: (workspace: string) => void;
}

/** 子进程每次拉起（含崩溃重拉）时要带的状态。 */
export interface AgentDataLaunchState { hostToken: string; listenPath: string; workspaceTokens: Record<string, string>; knownWorkspaces: string[] }

export interface AgentDataChildOptions {
  /** 创建子进程客户端，只调一次。launchState 在每次拉起时现取。 */
  createProcess: (launchState: () => AgentDataLaunchState) => AgentDataProcessPort;
  listenPath: string;
}

/**
 * AgentData 的主进程门面。两种后端：
 * - inproc：运行时在本进程里（原来的做法，也是测试的默认）；
 * - child：运行时在 agentdata-host 子进程里，本进程只转发。方法、返回结构、错误文案两边一致。
 */
export class AgentDataService {
  private runtime?: AgentDataRuntime;
  private client?: AgentDataClient;
  private startPromise?: Promise<{ version: number }>;
  private stopPromise?: Promise<void>;
  private child?: AgentDataProcessPort;
  private childEndpoint?: AgentDataEndpoint;
  private readonly hostToken = randomBytes(32).toString('hex');
  /** 规范化工作区 → 令牌。主进程签发、持有；子进程重拉时整表带回去，扩展缓存的端点一直有效。 */
  private readonly workspaceTokens = new Map<string, string>();
  private readonly pendingTokens = new Map<string, Promise<string>>();
  private readonly knownWorkspaces = new Set<string>();

  constructor(private readonly options: AgentDataRuntimeOptions | (AgentDataChildOptions & { mode: 'child' }) | AgentDataAssembledOptions) {}

  get mode(): 'inproc' | 'child' { return 'mode' in this.options ? 'child' : 'inproc'; }

  async start(): Promise<{ version: number }> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (!this.client) {
        if ('mode' in this.options) {
          const options = this.options;
          this.child ??= options.createProcess(() => ({
            hostToken: this.hostToken,
            listenPath: options.listenPath,
            workspaceTokens: Object.fromEntries(this.workspaceTokens),
            knownWorkspaces: [...this.knownWorkspaces],
          }));
          await this.child.start();
          this.childEndpoint = { host: '', port: 0, path: options.listenPath, token: this.hostToken };
          this.client = new AgentDataClient(this.childEndpoint, { timeoutMs: AGENT_DATA_SERVICE_TIMEOUT_MS, closeOnTimeout: false });
        } else {
          this.runtime = 'runtime' in this.options ? this.options.runtime : new AgentDataRuntime(this.options);
          const endpoint = await this.runtime.start();
          this.client = new AgentDataClient(endpoint, { timeoutMs: AGENT_DATA_SERVICE_TIMEOUT_MS, closeOnTimeout: false });
        }
      }
      return this.client!.request<{ version: number }>('system.hello');
    })().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  status(): Promise<{ state: string; version: number }> { return this.requireClient().request('system.status'); }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => {});
      if (this.child) {
        await this.client?.close();
        await this.child.shutdown();
      } else {
        if (this.client) await this.client.request('system.shutdown').catch(() => {});
        await this.client?.close(); this.runtime?.close();
        await this.runtime?.waitClosed();
      }
      this.client = undefined; this.runtime = undefined; this.child = undefined;
    })().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  endpoint(): AgentDataEndpoint | undefined { return this.childEndpoint ?? this.runtime?.getEndpoint(); }

  /**
   * 工作区的扩展端点。child 模式下令牌由本进程签发，先登记到子进程、确认后才返回：
   * 交给 agent-host 的令牌一定已经被服务端认得。
   */
  async agentEndpoint(workspace: string): Promise<AgentDataEndpoint> {
    if (!this.child) {
      if (!this.runtime) throw new Error('agent data runtime is not started');
      return this.runtime.agentEndpoint(workspace);
    }
    if (!this.childEndpoint) throw new Error('agent data runtime is not started');
    const key = normalizeWorkspace(workspace);
    const known = this.workspaceTokens.get(key);
    if (known) return { ...this.childEndpoint, token: known };
    let pending = this.pendingTokens.get(key);
    if (!pending) {
      const token = randomBytes(32).toString('hex');
      pending = this.child.request('agentdata.registerWorkspace', { workspace, token }).then(() => {
        this.workspaceTokens.set(key, token);
        return token;
      }).finally(() => this.pendingTokens.delete(key));
      this.pendingTokens.set(key, pending);
    }
    return { ...this.childEndpoint, token: await pending };
  }

  /** CodeGraph 的项目列表来自主进程知道的工作区（agent-host 解析过的）。 */
  registerKnownWorkspace(workspace: string): void {
    this.knownWorkspaces.add(workspace);
    if ('runtime' in this.options) this.options.onKnownWorkspace?.(workspace);
    if (this.child?.isRunning) void this.child.request('agentdata.registerKnownWorkspace', { workspace }).catch(() => undefined);
  }

  requestAdmin<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.child) return this.child.request<T>('agentdata.admin', { name: method, params });
    if (!this.runtime) return Promise.reject(new Error('agent data runtime is not started'));
    return this.runtime.requestAdmin<T>(method, params);
  }
  resolveDiagnosticPath(id: string): Promise<string> {
    if (this.child) return this.child.request<string>('agentdata.resolveDiagnosticPath', { id });
    if (!this.runtime) return Promise.reject(new Error('agent data runtime is not started'));
    return this.runtime.resolveDiagnosticPath(id);
  }
  /** 只在 inproc 模式下由主进程里的 CodeGraphJobs 调用；child 模式下执行器和运行时同在子进程里。 */
  recordJobStage(id: string, stage: string, processed?: number, total?: number): void {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    this.runtime.recordJobStage(id, stage, processed, total);
  }
  async runServiceTask(input: Omit<QueueTaskInput, 'system'>): Promise<unknown> {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.runServiceTask(input);
  }

  /** PluginManager 的持久化（主进程不再打开 agent-data.db）。 */
  async loadPluginStates(): Promise<PluginStateRecord[]> {
    if (this.child) return this.child.request<PluginStateRecord[]>('agentdata.plugins.load');
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.pluginStateStore().load();
  }
  savePluginState(record: PluginStateRecord): void {
    const task = this.child
      ? this.child.request('agentdata.plugins.save', { record })
      : Promise.resolve().then(() => this.runtime?.pluginStateStore().save(record));
    task.catch((error: unknown) => console.error('plugin state was not persisted', error));
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return this.requireClient().request<T>(method, params); }
  createThread(input: CreateThreadInput): Promise<Thread> { return this.request('thread.create', input); }
  listThreads(): Promise<Thread[]> { return this.request('thread.list'); }
  readThread(id: string): Promise<ThreadSnapshot | undefined> { return this.request('thread.read', { id }); }
  createTurn(input: CreateTurnInput): Promise<Turn> { return this.request('turn.create', input); }
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn> { return this.request('turn.update', { id, ...patch }); }
  upsertItem(item: Omit<Item, 'createdAt'> & Partial<Pick<Item, 'createdAt' | 'updatedAt'>>): Promise<Item> { return this.request('item.upsert', item); }
  listItems(threadId: string, turnId?: string): Promise<Item[]> { return this.request('item.list', { threadId, ...(turnId === undefined ? {} : { turnId }) }); }

  private requireClient(): AgentDataClient { if (!this.client) throw new Error('agent data runtime is not started'); return this.client; }
}

/** 与 AgentDataRuntime 的 normalizeWorkspace 相同，令牌表的键两边要一致。 */
function normalizeWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('workspace is required');
  const normalized = resolve(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
