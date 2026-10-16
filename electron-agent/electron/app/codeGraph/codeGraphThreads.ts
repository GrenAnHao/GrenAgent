import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import type { IndexProgress } from '@colbymchenry/codegraph';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { fromWireError } from '../../agentProcess/rpcPeer';
import { CODEGRAPH_SDK_VERSION, type CodeGraphStatusView } from './codeGraphEngine';
import type { CodeSearchView } from './codeGraphService';
import { isIndexed } from './indexProbe';
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
}

const BUSY = 'CodeGraph workspace is busy indexing';
const CLOSED = 'CodeGraph engine is closed';
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_COOLDOWN_MS = 30_000;
const CLOSE_WAIT_MS = 15_000;

export function defaultReaderCount(env = process.env.GREN_CODEGRAPH_READ_WORKERS, cores = availableParallelism()): number {
  const configured = Number(env);
  if (env !== undefined && env.trim() !== '' && Number.isInteger(configured) && configured >= 1) return Math.min(configured, 8);
  return Math.max(1, Math.min(2, cores - 2));
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
    private readonly onProgress: (jobId: string, progress: IndexProgress) => void = () => {},
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
      if (message.type === 'progress') { this.onProgress(message.jobId, message.progress); return; }
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

/**
 * codegraph-host 主线程上的调度器，对外是 CodeGraphService 的同一组方法。
 * 一个写线程跑 runSync（多个工作区的同步在它里面照旧并发），N 个读线程跑查询，主线程不碰 SDK。
 * 同一工作区的读写互斥规则与进程内实现相同：写期间读返回 busy；写开始前先等该工作区的在途读结束，
 * 并让所有读线程关掉手里的连接，写完再按需重开。
 */
export class CodeGraphThreads {
  private readonly writer: WorkerThread;
  private readonly readers: WorkerThread[];
  private readonly writing = new Map<string, { jobId: string; dispatched: boolean; cancelled: boolean }>();
  private readonly jobs = new Map<string, string>();
  private readonly reads = new Map<string, Set<Promise<unknown>>>();
  private readonly failures = new Map<string, string>();
  private readonly lastStatus = new Map<string, CodeGraphStatusView>();
  private readonly progress = new Map<string, (progress: IndexProgress) => void>();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: CodeGraphThreadsOptions) {
    const now = options.now ?? Date.now;
    this.writer = new WorkerThread('write', options.createWorker, now, (jobId, progress) => this.progress.get(jobId)?.(progress));
    const count = Math.max(1, options.readers ?? defaultReaderCount());
    this.readers = Array.from({ length: count }, () => new WorkerThread('read', options.createWorker, now));
  }

  get syncing(): number { return this.jobs.size; }

  async status(workspace: string): Promise<CodeGraphStatusView> {
    const key = keyOf(workspace);
    const base = { workspace, connected: false, indexed: isIndexed(workspace), sdkAvailable: true, sdkVersion: CODEGRAPH_SDK_VERSION };
    if (this.closed) return { ...base, state: 'failed', message: CLOSED };
    if (this.writing.has(key)) return { ...base, ...snapshot(this.lastStatus.get(key)), state: 'indexing' };
    try {
      const status = await this.read<CodeGraphStatusView>(key, { op: 'status', workspace });
      if (status.connected) this.lastStatus.set(key, status);
      // 失败记录只在写线程这一侧知道；与进程内实现一样，只覆盖到已初始化、能打开的索引上。
      if (status.connected && this.failures.has(key)) return { ...status, state: 'failed', message: this.failures.get(key) };
      return status;
    } catch (error) {
      return { ...base, state: 'failed', message: errorText(error) };
    }
  }

  async call(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<CodeRetrievalResult> {
    if (this.closed) throw new Error(CLOSED);
    const name = readCodeRetrievalTool(tool);
    const validated = validateCodeRetrievalArgs(workspace, name, args);
    return this.read<CodeRetrievalResult>(keyOf(workspace), { op: 'call', workspace, tool: name, args: validated });
  }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    try {
      if (this.closed) throw new Error(CLOSED);
      return await this.read<CodeSearchView>(keyOf(workspace), { op: 'search', workspace, query, limit });
    } catch (error) {
      return { workspace, available: false, results: [], message: errorText(error) };
    }
  }

  async runSync(jobId: string, workspace: string, onProgress?: (progress: IndexProgress) => void): Promise<void> {
    if (this.closed) throw new Error(CLOSED);
    const key = keyOf(workspace);
    if (this.jobs.has(jobId) || this.writing.has(key)) throw new Error(BUSY);
    const job = { jobId, dispatched: false, cancelled: false };
    this.writing.set(key, job);
    this.jobs.set(jobId, key);
    if (onProgress) this.progress.set(jobId, onProgress);
    const task = (async () => {
      try {
        await Promise.allSettled([...(this.reads.get(key) ?? [])]);
        // 读线程关掉这个库的连接（等它们各自的在途读结束）；没起来的线程手里本来就没有。
        await Promise.allSettled(this.readers.filter((reader) => reader.alive).map((reader) => reader.request({ op: 'evict', workspace })));
        if (job.cancelled || this.closed) throw cancelledError();
        job.dispatched = true;
        await this.writer.request({ op: 'runSync', jobId, workspace });
        this.failures.delete(key);
      } catch (error) {
        this.failures.set(key, errorText(error));
        throw error;
      } finally {
        this.writing.delete(key);
        this.jobs.delete(jobId);
        this.progress.delete(jobId);
        this.lastStatus.delete(key);
      }
    })();
    return this.track(task);
  }

  async cancelSync(jobId: string): Promise<void> {
    const key = this.jobs.get(jobId);
    const job = key ? this.writing.get(key) : undefined;
    if (!job) return;
    job.cancelled = true;
    if (job.dispatched) await this.writer.request({ op: 'cancelSync', jobId });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const jobId of [...this.jobs.keys()]) await this.cancelSync(jobId).catch(() => undefined);
      await Promise.allSettled([...this.active]);
      await Promise.allSettled([this.writer.close(), ...this.readers.map((reader) => reader.close())]);
    })();
    return this.closing;
  }

  private read<T>(key: string, call: WorkerCall): Promise<T> {
    if (this.writing.has(key)) return Promise.reject(new Error(BUSY));
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
