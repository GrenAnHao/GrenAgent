import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CodeGraph, IndexProgress } from '@colbymchenry/codegraph';
import { readCodeRetrievalTool, validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { executeCodeGraphTool } from './codeGraphQuery';
import { timeSync } from '../../agentData/methodTiming';
import { isIndexed } from './indexProbe';
import type { SyncView } from './syncScheduler';

export const CODEGRAPH_SDK_VERSION = '1.6.2';
type Sdk = typeof import('@colbymchenry/codegraph');
/** FileWatcher 只有写线程挂监听时才用到；测试注入的假 SDK 可以不带。 */
export type CodeGraphSdk = Pick<Sdk, 'CodeGraph' | 'isInitialized'> & Partial<Pick<Sdk, 'FileWatcher'>>;
export type SyncMode = 'incremental' | 'full';
/** 调度器派发前问写线程：这次同步该走哪条路。uninitialized = 还没有索引。 */
export type SyncPlan = SyncMode | 'uninitialized';
export interface SyncRunOptions {
  /** 不给时按原规则自己判断（没索引、上次没建完、抽取器升级 → 全量，否则增量）。 */
  mode?: SyncMode;
  /** 增量同步只对这些项目内相对路径（POSIX）做比对，即 SDK 的 watcher 快路径；不给就整棵树比对。 */
  paths?: string[];
}
export interface SyncOutcome { mode: SyncMode; filesChanged?: number }
export interface WatchHandlers {
  debounceMs: number;
  /** paths 为 null：改动范围说不清，下一次同步要整棵树比对。 */
  onChange: (paths: string[] | null) => void;
  onDegraded: (reason: string) => void;
}
export const NOT_INITIALIZED = 'CodeGraph index is not initialized for this workspace';
/**
 * phase 等调度字段只有 codegraph-host 的多线程实现给出（进程内单线程退路没有）。增量同步期间 state 保持
 * indexed / stale / partial，只有全量重建期间是 indexing。
 */
export interface CodeGraphStatusView extends Partial<SyncView> {
  workspace: string;
  connected: boolean;
  indexed: boolean;
  sdkAvailable: boolean;
  sdkVersion: string;
  state: 'unavailable' | 'indexed' | 'indexing' | 'partial' | 'failed' | 'stale' | 'sdk_unavailable';
  files?: number;
  nodes?: number;
  edges?: number;
  lastIndexedAt?: number | null;
  message?: string;
  watcher?: { active: boolean; degraded: boolean; reason?: string };
  /** 正在用上一次提交的索引应答（有同步在跑、在排队，或监听报过的改动还没进索引）。 */
  servingStale?: boolean;
  /** 自动同步是否开启（GREN_CODEGRAPH_AUTO_SYNC=off 时为 false）。 */
  autoSync?: boolean;
}
export interface CodeGraphEngineOptions { loadSdk?: () => Promise<CodeGraphSdk>; idleTimeoutMs?: number }
interface Entry { graph?: CodeGraph; opening?: Promise<CodeGraph>; timer?: ReturnType<typeof setTimeout>; pinned?: boolean }
interface Job { workspace: string; controller: AbortController; promise: Promise<SyncOutcome> }
interface Watcher { start(): boolean; stop(): void }

class SdkUnavailable extends Error {}

/** Instances, reads and explicit index writes share one owner in the Electron process. */
export class CodeGraphEngine {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Map<string, Set<Promise<unknown>>>();
  private readonly jobs = new Map<string, Job>();
  private readonly writers = new Map<string, Job>();
  private readonly failures = new Map<string, string>();
  private readonly watchers = new Map<string, Watcher>();
  /** refresh 换下来的旧连接：等它们手上的读结束再关，close() 要等它们。 */
  private readonly retiring = new Set<Promise<void>>();
  private sdk?: Promise<CodeGraphSdk>;
  private closed = false;
  private shutdown?: Promise<void>;

  constructor(private readonly options: CodeGraphEngineOptions = {}) {}

  async status(workspace: string): Promise<CodeGraphStatusView> {
    const key = this.key(workspace);
    const base = { workspace, connected: false, indexed: isIndexed(workspace), sdkAvailable: true, sdkVersion: CODEGRAPH_SDK_VERSION };
    try {
      this.assertOpen();
      const sdk = await this.load();
      if (this.writers.has(key)) {
        const graph = this.entries.get(key)?.graph;
        return { ...base, ...(graph ? this.snapshot(graph) : {}), state: 'indexing' };
      }
      if (!sdk.isInitialized(workspace)) return { ...base, indexed: false, state: 'unavailable' };
      return await this.read(workspace, async (graph) => ({
        ...base, ...this.snapshot(graph),
        ...(this.failures.has(key) ? { state: 'failed' as const, message: this.failures.get(key) } : {}),
      }));
    } catch (error) {
      const unavailable = error instanceof SdkUnavailable;
      return { ...base, sdkAvailable: !unavailable, state: unavailable ? 'sdk_unavailable' : 'failed', message: errorText(error) };
    }
  }

  async call(workspace: string, tool: CodeRetrievalTool, args: Record<string, unknown>): Promise<CodeRetrievalResult> {
    this.assertOpen();
    const name = readCodeRetrievalTool(tool);
    const validated = validateCodeRetrievalArgs(workspace, name, args);
    // 只计到它第一次 await 为止；explore / context 内部还有 await，后半段不在统计里。
    return this.read(workspace, (graph) => timeSync(`codegraph.${name}`, () => executeCodeGraphTool(graph, workspace, name, validated)));
  }

  /** 与 runSync 不给 mode 时同一条判断；调度器据此决定这次同步期间同工作区的读要不要停。 */
  async plan(workspace: string): Promise<SyncPlan> {
    this.assertOpen();
    const sdk = await this.load();
    if (!sdk.isInitialized(workspace)) return 'uninitialized';
    return this.read(workspace, async (graph) => (graph.getIndexState() !== 'complete' || graph.isIndexStale() ? 'full' : 'incremental'));
  }

  async runSync(jobId: string, workspace: string, onProgress?: (progress: IndexProgress) => void, run: SyncRunOptions = {}): Promise<SyncOutcome> {
    this.assertOpen();
    const key = this.key(workspace);
    if (this.jobs.has(jobId) || this.writers.has(key)) throw new Error('CodeGraph workspace is busy indexing');
    const controller = new AbortController();
    const job: Job = { workspace, controller, promise: Promise.resolve({ mode: 'incremental' }) };
    this.jobs.set(jobId, job);
    this.writers.set(key, job);
    this.clearTimer(key);
    job.promise = Promise.resolve().then(async () => {
      await Promise.allSettled([...(this.reads.get(key) ?? [])]);
      this.checkCancelled(controller.signal);
      const sdk = await this.load();
      this.checkCancelled(controller.signal);
      const initialized = sdk.isInitialized(workspace);
      // 调度器说了走增量，就不替它建新索引：没有索引时报错，由它决定要不要全量。
      if (run.mode === 'incremental' && !initialized) throw new Error(NOT_INITIALIZED);
      const graph = await this.graph(workspace, !initialized);
      this.checkCancelled(controller.signal);
      const options = { signal: controller.signal, onProgress: (progress: IndexProgress) => onProgress?.(progress) };
      const full = run.mode ? run.mode === 'full' : !initialized || graph.getIndexState() !== 'complete' || graph.isIndexStale();
      let outcome: SyncOutcome;
      if (full) {
        const indexed = await graph.indexAll(options);
        this.checkCancelled(controller.signal);
        if (!indexed.success) throw indexFailure(indexed.errors?.map((error) => error.message).join('; ') || 'CodeGraph index failed');
        if (graph.getIndexState() !== 'complete') throw new Error('CodeGraph index is partial or interrupted');
        outcome = { mode: 'full' };
      } else {
        // v1.6 sync does not forward signal internally. Do not dispose its DB or
        // report cancellation until the operation has actually settled.
        // 拿不到 codegraph.lock 时 SDK 抛 LockUnavailableError（name 原样过线），调度器按「延后」处理。
        const result = await graph.sync({ ...options, ...(run.paths?.length ? { paths: run.paths } : {}) });
        this.checkCancelled(controller.signal);
        outcome = { mode: 'incremental', filesChanged: result.filesAdded + result.filesModified + result.filesRemoved };
      }
      this.failures.delete(key);
      return outcome;
    }).catch((error) => {
      this.failures.set(key, errorText(error));
      if (controller.signal.aborted) this.checkCancelled(controller.signal);
      throw error;
    }).finally(() => {
      this.jobs.delete(jobId);
      this.writers.delete(key);
      this.scheduleClose(key);
    });
    return job.promise;
  }

  async cancelSync(jobId: string): Promise<void> {
    this.jobs.get(jobId)?.controller.abort();
  }

  /**
   * 之后的读换一条新连接，旧连接等此刻在途的读结束再关。另一个线程增量写完这个库后由调度方调用：
   * SQLite 的 WAL 让旧连接也能读到新提交，但 SDK 的 QueryBuilder 在连接上缓存了节点（nodeCache），
   * 别的连接写入不会让它失效。与 evict 不同，refresh 不等读、不挡新读。
   */
  async refresh(workspace: string): Promise<void> {
    const key = this.key(workspace);
    const entry = this.entries.get(key);
    if (!entry || this.writers.has(key)) return;
    this.entries.delete(key);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    const inFlight = [...(this.reads.get(key) ?? []), ...(entry.opening ? [entry.opening] : [])];
    const retired: Promise<void> = Promise.allSettled(inFlight).then(() => { entry.graph?.close(); }).finally(() => { this.retiring.delete(retired); });
    this.retiring.add(retired);
  }

  /**
   * 给工作区挂 SDK 的 FileWatcher，只当事件源：它负责防抖、忽略规则（.gitignore、内置排除）、目录删除与
   * Windows 上访问时间戳的误报；它的 syncFn 不在这里同步，只把改动交给调度方，立刻返回。
   * 挂着监听的工作区连接不随空闲回收（Windows 上滤误报要读索引里的文件记录）。
   */
  async watch(workspace: string, handlers: WatchHandlers): Promise<{ active: boolean; reason?: string }> {
    this.assertOpen();
    const key = this.key(workspace);
    if (this.watchers.has(key)) return { active: true };
    const sdk = await this.load();
    if (!sdk.FileWatcher) throw new Error('CodeGraph SDK does not provide FileWatcher');
    if (!sdk.isInitialized(workspace)) throw new Error(NOT_INITIALIZED);
    await this.graph(workspace);
    if (this.watchers.has(key)) return { active: true };
    const entry = this.entries.get(key);
    if (entry) { entry.pinned = true; this.clearTimer(key); }
    const fileStateCurrent = (relative: string): boolean => {
      const graph = this.entries.get(key)?.graph as unknown as { isIndexedFileStateCurrent?: (path: string) => boolean } | undefined;
      try { return graph?.isIndexedFileStateCurrent?.(relative) ?? false; } catch { return false; }
    };
    const watcher = new sdk.FileWatcher(resolve(workspace), async (paths) => {
      handlers.onChange(paths && paths.length ? [...paths] : null);
      return { filesChanged: paths?.length ?? 0, durationMs: 0 };
    }, { debounceMs: handlers.debounceMs, onDegraded: handlers.onDegraded }, process.platform === 'win32' ? fileStateCurrent : undefined);
    this.watchers.set(key, watcher);
    if (watcher.start()) return { active: true };
    this.watchers.delete(key);
    this.unpin(key);
    return { active: false, reason: 'CodeGraph 不支持在这个位置监听文件（例如 WSL 的 /mnt 盘）' };
  }

  async unwatch(workspace: string): Promise<void> {
    const key = this.key(workspace);
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    this.watchers.delete(key);
    watcher.stop();
    this.unpin(key);
  }

  /**
   * 等本引擎里该工作区的在途读结束，再关掉缓存的图。另一个线程要写这个库之前由调度方调用：
   * 写完以后读方重新打开，不会拿着写之前的连接和读缓存。调用方负责在此期间不再发新的读。
   */
  async evict(workspace: string): Promise<void> {
    const key = this.key(workspace);
    await Promise.allSettled([...(this.reads.get(key) ?? [])]);
    const entry = this.entries.get(key);
    if (!entry || this.writers.has(key)) return;
    if (entry.opening) await entry.opening.catch(() => undefined);
    if (this.reads.has(key)) return;
    this.clearTimer(key);
    entry.graph?.close();
    this.entries.delete(key);
  }

  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    for (const key of this.entries.keys()) this.clearTimer(key);
    for (const job of this.jobs.values()) job.controller.abort();
    const active = [
      ...[...this.jobs.values()].map((job) => job.promise),
      ...[...this.reads.values()].flatMap((reads) => [...reads]),
      ...[...this.entries.values()].flatMap((entry) => entry.opening ? [entry.opening] : []),
      ...this.retiring,
    ];
    this.shutdown = Promise.allSettled(active).then(() => {
      for (const entry of this.entries.values()) entry.graph?.close();
      this.entries.clear();
    });
    return this.shutdown;
  }

  private async read<T>(workspace: string, action: (graph: CodeGraph) => Promise<T>): Promise<T> {
    this.assertOpen();
    const key = this.key(workspace);
    if (this.writers.has(key)) throw new Error('CodeGraph workspace is busy indexing');
    this.clearTimer(key);
    const active = this.reads.get(key) ?? new Set<Promise<unknown>>();
    this.reads.set(key, active);
    const task = this.graph(workspace).then(action);
    active.add(task);
    try { return await task; }
    finally {
      active.delete(task);
      if (!active.size) this.reads.delete(key);
      this.scheduleClose(key);
    }
  }

  private async graph(workspace: string, initialize = false): Promise<CodeGraph> {
    this.assertOpen();
    const sdk = await this.load();
    this.assertOpen();
    if (!initialize && !sdk.isInitialized(workspace)) throw new Error(NOT_INITIALIZED);
    const key = this.key(workspace);
    let entry = this.entries.get(key);
    if (entry?.graph) {
      entry.graph.reopenIfReplaced();
      return entry.graph;
    }
    if (entry?.opening) return entry.opening;
    entry ??= {};
    this.entries.set(key, entry);
    const target = entry;
    target.opening = Promise.resolve().then(async () => {
      this.assertOpen();
      if (!initialize && !sdk.isInitialized(workspace)) throw new Error(NOT_INITIALIZED);
      const graph = initialize ? await sdk.CodeGraph.init(workspace, { index: false }) : await sdk.CodeGraph.open(workspace, { sync: false });
      if (this.closed) { graph.close(); this.assertOpen(); }
      target.graph = graph;
      return graph;
    }).finally(() => { target.opening = undefined; });
    return target.opening;
  }

  private load(): Promise<CodeGraphSdk> {
    if (!this.sdk) {
      this.sdk = Promise.resolve().then(this.options.loadSdk ?? loadEmbeddedSdk).catch((error) => {
        this.sdk = undefined;
        throw new SdkUnavailable(`CodeGraph SDK unavailable: ${errorText(error)}`);
      });
    }
    return this.sdk;
  }

  private snapshot(graph: CodeGraph): Pick<CodeGraphStatusView, 'indexed' | 'connected' | 'state' | 'files' | 'nodes' | 'edges' | 'lastIndexedAt'> {
    const stats = graph.getStats();
    const indexState = graph.getIndexState();
    let state: CodeGraphStatusView['state'] = graph.isIndexStale() ? 'stale' : 'indexed';
    if (indexState === 'indexing' || indexState === 'partial') state = 'partial';
    if (indexState === 'failed') state = 'failed';
    return {
      indexed: true, connected: true,
      state,
      files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount, lastIndexedAt: graph.getLastIndexedAt(),
    };
  }

  private key(workspace: string): string {
    const path = resolve(workspace);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  private assertOpen(): void { if (this.closed) throw new Error('CodeGraph engine is closed'); }
  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      const error = new Error('CodeGraph sync was cancelled; completed index writes are retained');
      error.name = 'AbortError';
      throw error;
    }
  }
  private clearTimer(key: string): void { const entry = this.entries.get(key); if (entry?.timer) { clearTimeout(entry.timer); entry.timer = undefined; } }
  private unpin(key: string): void { const entry = this.entries.get(key); if (entry) entry.pinned = false; this.scheduleClose(key); }
  private scheduleClose(key: string): void {
    const entry = this.entries.get(key);
    if (this.closed || !entry?.graph || entry.opening || entry.pinned || this.reads.has(key) || this.writers.has(key)) return;
    this.clearTimer(key);
    entry.timer = setTimeout(() => { entry.graph?.close(); this.entries.delete(key); }, this.options.idleTimeoutMs ?? 15 * 60_000);
    entry.timer.unref?.();
  }
}

async function loadEmbeddedSdk(): Promise<CodeGraphSdk> {
  const appRequire = createRequire(import.meta.url);
  // Run SDK workers and resolve its bundled dependencies from real files, not
  // virtual asar paths. package-codegraph.cjs restores the nested dependencies.
  const entry = appRequire.resolve('@colbymchenry/codegraph').replace(/\.asar([/\\])/, '.asar.unpacked$1');
  const sdkRequire = createRequire(entry);
  const manifest = sdkRequire('@colbymchenry/codegraph/package.json') as { version: string };
  if (manifest.version !== CODEGRAPH_SDK_VERSION) throw new Error(`Expected CodeGraph ${CODEGRAPH_SDK_VERSION}, received ${manifest.version}`);
  // Require an installed application dependency: never let the SDK shim fall
  // back to a user's global CLI cache or download a missing platform package.
  sdkRequire.resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`);
  return sdkRequire(entry) as CodeGraphSdk;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** indexAll 拿不到 codegraph.lock 时不抛错、只在 errors 里写一句；统一成 sync 那边的 LockUnavailableError。 */
function indexFailure(message: string): Error {
  const error = new Error(message);
  if (/could not acquire file lock|locked by another process/i.test(message)) error.name = 'LockUnavailableError';
  return error;
}
