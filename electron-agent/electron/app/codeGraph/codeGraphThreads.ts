import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import type { IndexProgress } from '@colbymchenry/codegraph';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { fromWireError } from '../../agentProcess/rpcPeer';
import { CODEGRAPH_SDK_VERSION, type CodeGraphStatusView, type SyncOutcome, type SyncPlan } from './codeGraphEngine';
import type { CodeSearchView } from './codeGraphService';
import { isIndexed as probeIndexed } from './indexProbe';
import { SyncScheduler, type SyncEvent, type SyncExecutor, type SyncSchedulerOptions } from './syncScheduler';
import type { WorkerCall, WorkerMessage, WorkerRequest, WorkerRole } from './workerProtocol';

/** worker_threads.Worker 用到的那一小部分；测试换成假线程。 */
export interface WorkerHandle {
  postMessage(message: WorkerRequest): void;
  on(event: 'message', listener: (message: WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}
export type CreateWorker = (role: WorkerRole) => WorkerHandle;

export interface CodeGraphThreadsOptions {
  createWorker: CreateWorker;
  /** 读线程数。默认 GREN_CODEGRAPH_READ_WORKERS，否则 clamp(核数 - 2, 1, 2)。 */
  readers?: number;
  now?: () => number;
  /** 自动同步（文件监听 + 激活补同步）。默认开，GREN_CODEGRAPH_AUTO_SYNC=off 关掉。 */
  autoSync?: boolean;
  /** 文件监听的防抖。默认 1000ms：调度器自己合并，防抖只需盖住一次保存的事件风暴。 */
  watchDebounceMs?: number;
  /** 同时挂监听的工作区数（按最近使用淘汰）。默认 3。 */
  maxWatched?: number;
  /** 没挂上监听（或监听失效）的工作区，距上次检查超过这么久，再被访问时补一次整树同步。默认 5 分钟。 */
  staleAfterMs?: number;
  /** 测试替换退避、时钟、定时器。 */
  scheduler?: Partial<Omit<SyncSchedulerOptions, 'executor'>>;
  onSyncEvent?: (event: SyncEvent) => void;
  isIndexed?: (workspace: string) => boolean;
}

const BUSY = 'CodeGraph workspace is busy indexing';
const CLOSED = 'CodeGraph engine is closed';
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_COOLDOWN_MS = 30_000;
const CLOSE_WAIT_MS = 15_000;
const NOTICE_FILES = 5;
const META_FILES = 20;

export function defaultReaderCount(env = process.env.GREN_CODEGRAPH_READ_WORKERS, cores = availableParallelism()): number {
  const configured = Number(env);
  if (env !== undefined && env.trim() !== '' && Number.isInteger(configured) && configured >= 1) return Math.min(configured, 8);
  return Math.max(1, Math.min(2, cores - 2));
}

export function autoSyncEnabled(env = process.env.GREN_CODEGRAPH_AUTO_SYNC): boolean {
  return !['off', '0', 'false'].includes((env ?? '').trim().toLowerCase());
}

/** 一个 SDK 工作线程：按需拉起，崩了下一条请求再拉起，短时间连续崩溃先冷却。 */
class WorkerThread {
  private worker?: WorkerHandle;
  private ready?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private crashes: number[] = [];
  private blockedUntil = 0;
  private exited?: Promise<void>;
  inFlight = 0;

  constructor(
    private readonly role: WorkerRole,
    private readonly create: CreateWorker,
    private readonly now: () => number,
    /** 不是请求结果的消息：进度、文件改动、监听失效。 */
    private readonly onEvent: (message: Exclude<WorkerMessage, { type: 'ready' | 'result' }>) => void = () => {},
    private readonly onExit: () => void = () => {},
  ) {}

  get alive(): boolean { return this.worker !== undefined; }

  async request<T>(call: WorkerCall): Promise<T> {
    this.inFlight += 1;
    try {
      await this.start();
      const worker = this.worker!;
      const id = this.nextId++;
      return await new Promise<T>((resolveCall, rejectCall) => {
        this.pending.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall });
        try { worker.postMessage({ ...call, id } as WorkerRequest); }
        catch (error) { this.pending.delete(id); rejectCall(error instanceof Error ? error : new Error(String(error))); }
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  /** 已经起来的线程才发 close；等它自己退出，超时再 terminate。 */
  async close(): Promise<void> {
    if (!this.worker) return;
    const exited = this.exited;
    await this.request({ op: 'close' }).catch(() => undefined);
    const done = await Promise.race([exited?.then(() => true), new Promise<false>((r) => { const t = setTimeout(() => r(false), CLOSE_WAIT_MS); t.unref?.(); })]);
    if (!done) await this.worker?.terminate();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const now = this.now();
    if (now < this.blockedUntil) {
      return Promise.reject(new Error(`CODEGRAPH_WORKER_CRASH_LOOP: CodeGraph ${this.role} 线程连续崩溃，${Math.ceil((this.blockedUntil - now) / 1000)} 秒后再试`));
    }
    const worker = this.create(this.role);
    this.worker = worker;
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => { markReady = resolveReady; failReady = rejectReady; });
    ready.catch(() => undefined);
    let markExited!: () => void;
    this.exited = new Promise<void>((r) => { markExited = r; });
    let lastError: Error | undefined;
    worker.on('message', (message) => {
      if (message.type === 'ready') { markReady(); return; }
      if (message.type !== 'result') { this.onEvent(message); return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(fromWireError(message.error));
    });
    worker.on('error', (error) => { lastError = error; });
    worker.on('exit', (code) => {
      const expected = code === 0 && this.pending.size === 0;
      const error = new Error(`CODEGRAPH_WORKER_EXITED: ${this.role} code=${code}${lastError ? ` ${lastError.message}` : ''}`);
      if (this.worker === worker) { this.worker = undefined; this.ready = undefined; }
      failReady(error);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      if (!expected) this.recordCrash();
      this.onExit();
      markExited();
    });
    this.ready = ready;
    return ready;
  }

  private recordCrash(): void {
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) { this.blockedUntil = now + CRASH_COOLDOWN_MS; this.crashes = []; }
  }
}

interface WatchState { workspace: string; active: boolean; starting: boolean; degraded: boolean; reason?: string }

/**
 * codegraph-host 主线程上的调度器，对外是 CodeGraphService 的同一组方法。
 * 一个写线程跑同步与文件监听，N 个读线程跑查询，主线程不碰 SDK。写由 SyncScheduler 排：
 * - 增量同步期间同工作区的读照常应答（SQLite WAL 下读到的是上一次提交），写完让读线程换连接；
 * - 全量重建期间同工作区的读返回 busy，写开始前先等在途的读结束、让读线程交出连接（与原来一样）；
 * - 自动同步：被查询的已索引工作区挂上 SDK FileWatcher（最多 maxWatched 个），改动交给调度器合并成增量同步；
 *   第一次访问、或监听没挂上 / 失效时距上次检查超过 staleAfterMs，补一次整树比对。不替用户建索引。
 */
export class CodeGraphThreads {
  private readonly writer: WorkerThread;
  private readonly readers: WorkerThread[];
  private readonly scheduler: SyncScheduler;
  private readonly reads = new Map<string, Set<Promise<unknown>>>();
  private readonly lastStatus = new Map<string, CodeGraphStatusView>();
  /** 挂着监听的工作区，Map 的插入顺序即最近使用顺序。 */
  private readonly watched = new Map<string, WatchState>();
  private readonly checkedAt = new Map<string, number>();
  /** 已经交给写线程的同步；还在等读排空的全量重建取消时不必惊动写线程。 */
  private readonly dispatched = new Set<string>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly autoSync: boolean;
  private readonly isIndexed: (workspace: string) => boolean;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: CodeGraphThreadsOptions) {
    this.now = options.now ?? Date.now;
    this.autoSync = options.autoSync ?? autoSyncEnabled();
    this.isIndexed = options.isIndexed ?? probeIndexed;
    this.writer = new WorkerThread('write', options.createWorker, this.now, (message) => this.onWriterEvent(message), () => this.onWriterExit());
    const count = Math.max(1, options.readers ?? defaultReaderCount());
    this.readers = Array.from({ length: count }, () => new WorkerThread('read', options.createWorker, this.now));
    this.scheduler = new SyncScheduler({ now: this.now, ...options.scheduler, executor: this.executor(), onEvent: (event) => options.onSyncEvent?.(event) });
  }

  get syncing(): number { return this.scheduler.running; }

  async status(workspace: string): Promise<CodeGraphStatusView> {
    const key = keyOf(workspace);
    const base = { workspace, connected: false, indexed: this.isIndexed(workspace), sdkAvailable: true, sdkVersion: CODEGRAPH_SDK_VERSION };
    if (this.closed) return { ...base, state: 'failed', message: CLOSED };
    // 查状态不算「访问」：诊断、项目概览会批量读状态，不该顺手挂监听、起同步。
    if (this.scheduler.isRebuilding(key)) return { ...base, ...snapshot(this.lastStatus.get(key)), state: 'indexing', ...this.syncFields(key) };
    try {
      const status = await this.read<CodeGraphStatusView>(key, { op: 'status', workspace });
      if (status.connected) this.lastStatus.set(key, status);
      // 最近一次同步失败（不含被别的进程占锁）：与原来一样，只覆盖到已初始化、能打开的索引上。
      const failed = this.scheduler.view(key).lastError;
      const merged = status.connected && failed && failed.code !== 'CODEGRAPH_LOCKED' ? { ...status, state: 'failed' as const, message: failed.message } : status;
      return { ...merged, ...this.syncFields(key) };
    } catch (error) {
      return { ...base, state: 'failed', message: errorText(error), ...this.syncFields(key) };
    }
  }

  async call(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<CodeRetrievalResult> {
    if (this.closed) throw new Error(CLOSED);
    const name = readCodeRetrievalTool(tool);
    const validated = validateCodeRetrievalArgs(workspace, name, args);
    const key = keyOf(workspace);
    this.touch(workspace, key);
    const result = await this.read<CodeRetrievalResult>(key, { op: 'call', workspace, tool: name, args: validated });
    return this.annotate(key, result);
  }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    try {
      if (this.closed) throw new Error(CLOSED);
      const key = keyOf(workspace);
      this.touch(workspace, key);
      return await this.read<CodeSearchView>(key, { op: 'search', workspace, query, limit });
    } catch (error) {
      return { workspace, available: false, results: [], message: errorText(error) };
    }
  }

  /** 用户 job：并进该工作区的待执行槽，包含它的那次同步结束时落定（前面有一次在跑就排在它后面）。 */
  async runSync(jobId: string, workspace: string, onProgress?: (progress: IndexProgress) => void): Promise<SyncOutcome> {
    if (this.closed) throw new Error(CLOSED);
    return this.track(this.scheduler.request(keyOf(workspace), workspace, { trigger: 'manual', jobId, onProgress })!);
  }

  async cancelSync(jobId: string): Promise<void> { await this.scheduler.cancel(jobId); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.scheduler.close();
      await Promise.allSettled([...this.active]);
      await Promise.allSettled([this.writer.close(), ...this.readers.map((reader) => reader.close())]);
    })();
    return this.closing;
  }

  private executor(): SyncExecutor {
    return {
      plan: (workspace) => this.writer.request<SyncPlan>({ op: 'plan', workspace }),
      run: async (task) => {
        if (task.mode === 'full') {
          // 全量会就地重写索引：调度器已经挡住新读，这里等在途的读结束，再让已启动的读线程关掉手里的连接。
          const key = keyOf(task.workspace);
          await Promise.allSettled([...(this.reads.get(key) ?? [])]);
          await Promise.allSettled(this.readers.filter((reader) => reader.alive).map((reader) => reader.request({ op: 'evict', workspace: task.workspace })));
          if (task.cancelled()) throw cancelledError();
        }
        this.dispatched.add(task.runId);
        try {
          return await this.writer.request<SyncOutcome>({ op: 'runSync', jobId: task.runId, workspace: task.workspace, mode: task.mode, ...(task.paths ? { paths: task.paths } : {}) });
        } finally {
          this.dispatched.delete(task.runId);
        }
      },
      cancel: async (runId) => { if (this.dispatched.has(runId)) await this.writer.request({ op: 'cancelSync', jobId: runId }); },
      committed: async (workspace) => {
        this.lastStatus.delete(keyOf(workspace));
        await Promise.allSettled(this.readers.filter((reader) => reader.alive).map((reader) => reader.request({ op: 'refresh', workspace })));
      },
    };
  }

  /** 工作区被访问（查询、搜索）：已索引的挂上监听，第一次访问或监听不可用且久未检查时补一次整树同步。 */
  private touch(workspace: string, key: string): void {
    if (!this.autoSync || this.closed || !this.isIndexed(workspace)) return;
    const watch = this.watched.get(key);
    if (watch) { this.watched.delete(key); this.watched.set(key, watch); }
    else this.startWatch(workspace, key);
    const current = this.watched.get(key);
    const healthy = Boolean(current?.active && !current.degraded);
    const checked = this.checkedAt.get(key);
    const now = this.now();
    if (checked === undefined || (!healthy && now - checked >= (this.options.staleAfterMs ?? 5 * 60_000))) {
      this.checkedAt.set(key, now);
      this.scheduler.request(key, workspace, { trigger: 'activate' });
    }
  }

  private startWatch(workspace: string, key: string): void {
    const state: WatchState = { workspace, active: false, starting: true, degraded: false };
    this.watched.set(key, state);
    while (this.watched.size > (this.options.maxWatched ?? 3)) {
      const [oldKey, old] = this.watched.entries().next().value as [string, WatchState];
      this.watched.delete(oldKey);
      // 不再监听的工作区，之后的改动没人报：下次访问时整树补一次。
      this.checkedAt.delete(oldKey);
      if (old.active) void this.writer.request({ op: 'unwatch', workspace: old.workspace }).catch(() => undefined);
    }
    void this.writer.request<{ active: boolean; reason?: string }>({ op: 'watch', workspace, debounceMs: this.options.watchDebounceMs ?? 1_000 }).then((result) => {
      if (this.watched.get(key) !== state) {
        // 起监听的途中被淘汰了：收回刚挂上的监听。
        if (result.active) void this.writer.request({ op: 'unwatch', workspace }).catch(() => undefined);
        return;
      }
      state.starting = false;
      state.active = result.active;
      if (!result.active) { state.degraded = true; state.reason = result.reason; }
    }, (error: unknown) => {
      if (this.watched.get(key) !== state) return;
      state.starting = false;
      state.degraded = true;
      state.reason = errorText(error);
    });
  }

  private onWriterEvent(message: Exclude<WorkerMessage, { type: 'ready' | 'result' }>): void {
    if (message.type === 'progress') { this.scheduler.progress(message.jobId, message.progress); return; }
    const key = keyOf(message.workspace);
    const state = this.watched.get(key);
    if (!state || this.closed) return;
    if (message.type === 'changed') {
      this.scheduler.request(key, state.workspace, { trigger: 'watch', paths: message.paths });
      return;
    }
    state.active = false;
    state.degraded = true;
    state.reason = message.reason;
  }

  /** 写线程没了，监听跟着没了：清掉登记，下次访问时重新挂上并整树补一次。 */
  private onWriterExit(): void {
    this.watched.clear();
    this.checkedAt.clear();
  }

  private syncFields(key: string): Partial<CodeGraphStatusView> {
    const view = this.scheduler.view(key);
    const watch = this.watched.get(key);
    return {
      ...view,
      autoSync: this.autoSync,
      watcher: { active: Boolean(watch?.active), degraded: Boolean(watch?.degraded), ...(watch?.reason ? { reason: watch.reason } : {}) },
      servingStale: ['queued', 'syncing', 'backoff'].includes(view.phase) || view.pendingChanges > 0,
    };
  }

  /** 索引落后于磁盘时，在结果里标出来；监听报过的具体文件再给模型一句话，让它直接读这些文件。 */
  private annotate(key: string, result: CodeRetrievalResult): CodeRetrievalResult {
    const view = this.scheduler.view(key);
    const stale = ['queued', 'syncing', 'backoff'].includes(view.phase) || view.pendingChanges > 0;
    if (!stale || !result?.structuredContent) return result;
    const files = this.scheduler.pendingFiles(key, META_FILES);
    const annotated: CodeRetrievalResult = {
      ...result,
      structuredContent: { ...result.structuredContent, meta: { servingStale: true, generation: view.generation, phase: view.phase, pendingFiles: view.pendingChanges, files } },
    };
    if (!files.length || result.isError) return annotated;
    const shown = files.slice(0, NOTICE_FILES).join(', ');
    const more = view.pendingChanges > NOTICE_FILES ? `, and ${view.pendingChanges - NOTICE_FILES} more` : '';
    const text = `Note: the CodeGraph index has not caught up with ${view.pendingChanges} recently changed file(s): ${shown}${more}. Results from these files may be outdated; read them directly if they matter.`;
    return { ...annotated, content: [...result.content, { type: 'text', text }] };
  }

  private read<T>(key: string, call: WorkerCall): Promise<T> {
    if (this.scheduler.isRebuilding(key)) return Promise.reject(new Error(BUSY));
    const reader = this.pickReader();
    const task = reader.request<T>(call);
    const set = this.reads.get(key) ?? new Set<Promise<unknown>>();
    this.reads.set(key, set);
    set.add(task);
    const settle = () => { set.delete(task); if (!set.size && this.reads.get(key) === set) this.reads.delete(key); };
    task.then(settle, settle);
    return this.track(task);
  }

  /** 在途最少的读线程；已经起来的优先，减少冷启动。 */
  private pickReader(): WorkerThread {
    let best = this.readers[0];
    for (const reader of this.readers) {
      const score = reader.inFlight * 2 + (reader.alive ? 0 : 1);
      const bestScore = best.inFlight * 2 + (best.alive ? 0 : 1);
      if (score < bestScore) best = reader;
    }
    return best;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task);
    const drop = () => { this.active.delete(task); };
    task.then(drop, drop);
    return task;
  }
}

function keyOf(workspace: string): string {
  const path = resolve(workspace);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function snapshot(status: CodeGraphStatusView | undefined): Partial<CodeGraphStatusView> {
  if (!status) return {};
  const { connected, indexed, files, nodes, edges, lastIndexedAt } = status;
  return { connected, indexed, files, nodes, edges, lastIndexedAt };
}

function cancelledError(): Error {
  const error = new Error('CodeGraph sync was cancelled; completed index writes are retained');
  error.name = 'AbortError';
  return error;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
