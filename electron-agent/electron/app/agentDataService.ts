import { randomUUID } from 'node:crypto';
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

/** 由 assembleAgentData 装配好的运行时（还没 start）。 */
export interface AgentDataAssembledOptions {
  runtime: AgentDataRuntime;
  onKnownWorkspace?: (workspace: string) => void;
}

/**
 * AgentData 的主进程门面。
 *
 * agentdata-host 已下线：运行时固定在本进程里，不再有 child 模式与崩溃重拉。
 * 这层保留的价值只有两点：把运行时的启动/关停收敛到一处，以及给 IPC 与主进程
 * 提供一个稳定的方法面（线程、插件状态、知识短调用、扩展方法转发）。
 *
 * 有意不直接调用运行时的私有 store：线程仍走它已有的 `thread.*` / `turn.*` /
 * `item.*` 方法面，避免在门面里复制一套持久化逻辑。
 */
export class AgentDataService {
  private runtime?: AgentDataRuntime;
  private client?: AgentDataClient;
  private startPromise?: Promise<{ version: number }>;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: AgentDataAssembledOptions) {}

  get mode(): 'inproc' { return 'inproc'; }

  async start(): Promise<{ version: number }> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (!this.client) {
        this.runtime = this.options.runtime;
        const endpoint = await this.runtime.start();
        this.client = new AgentDataClient(endpoint, { timeoutMs: AGENT_DATA_SERVICE_TIMEOUT_MS, closeOnTimeout: false });
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
      if (this.client) await this.client.request('system.shutdown').catch(() => {});
      await this.client?.close();
      this.runtime?.close();
      await this.runtime?.waitClosed();
      this.client = undefined; this.runtime = undefined;
    })().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  endpoint(): AgentDataEndpoint | undefined { return this.runtime?.getEndpoint(); }

  /** CodeGraph 的项目列表来自主进程知道的工作区（agent-host 解析过的）。 */
  registerKnownWorkspace(workspace: string): void {
    this.options.onKnownWorkspace?.(workspace);
  }

  requestAdmin<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.runtime) return Promise.reject(new Error('agent data runtime is not started'));
    return this.runtime.requestAdmin<T>(method, params);
  }

  /**
   * 最小扩展端点复用：按 owner 执行的工具授权方法。
   * 返回 undefined 表示该方法不允许从端点访问，而不是“不存在”。
   */
  extensionMethod(name: string, owner: string): ((params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined {
    if (!this.runtime) return undefined;
    return this.runtime.extensionMethod(name, owner);
  }

  async runServiceTask(input: Omit<QueueTaskInput, 'system'>): Promise<unknown> {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.runServiceTask(input);
  }

  /** PluginManager 的持久化；运行时独占数据库。 */
  async loadPluginStates(): Promise<PluginStateRecord[]> {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.pluginStateStore().load();
  }

  savePluginState(record: PluginStateRecord): void {
    Promise.resolve()
      .then(() => this.runtime?.pluginStateStore().save(record))
      .catch((error: unknown) => console.error('plugin state was not persisted', error));
  }

  /** socket 类请求：线程、回合与条目持久化。 */
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.requireClient().request<T>(method, params);
  }

  createThread(input: CreateThreadInput): Promise<Thread> { return this.request('thread.create', input); }
  listThreads(): Promise<Thread[]> { return this.request('thread.list'); }
  readThread(id: string): Promise<ThreadSnapshot | undefined> { return this.request('thread.read', { id }); }
  createTurn(input: CreateTurnInput): Promise<Turn> { return this.request('turn.create', input); }
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn> { return this.request('turn.update', { id, ...patch }); }
  upsertItem(item: Omit<Item, 'createdAt'> & Partial<Pick<Item, 'createdAt' | 'updatedAt'>>): Promise<Item> { return this.request('item.upsert', item); }
  listItems(threadId: string, turnId?: string): Promise<Item[]> { return this.request('item.list', { threadId, ...(turnId === undefined ? {} : { turnId }) }); }

  private requireClient(): AgentDataClient {
    if (!this.client) throw new Error('agent data runtime is not started');
    return this.client;
  }
}
