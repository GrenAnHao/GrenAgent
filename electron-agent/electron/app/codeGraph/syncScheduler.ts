/**
 * codegraph-host 主线程上的写调度：每个工作区至多一个在跑 + 一个待执行，重复请求并进待执行槽；
 * 手动同步不受车道限制（与原来一样可以跨工作区并发），自动同步全局一次只跑一个、且只在没有别的同步时跑；
 * 失败按指数退避重试，连续失败到上限后熔断，等下一次手动 / 文件改动 / 激活再试；拿不到 codegraph.lock 时延后，不算失败。
 * 纯逻辑：SDK 调用经 SyncExecutor 注入，时钟、定时器、随机数可替换，便于单测。
 * 见 .agents/notes/implemented/architecture/2026-10-18-codegraph-auto-sync-and-stale-reads.md。
 */
import type { IndexProgress } from '@colbymchenry/codegraph';
import type { SyncMode, SyncOutcome, SyncPlan } from './codeGraphEngine';

export type SyncTrigger = 'manual' | 'watch' | 'activate' | 'retry';
export type SyncPhase = 'idle' | 'queued' | 'syncing' | 'rebuilding' | 'backoff' | 'failed';

export interface SyncTask {
  runId: string;
  workspace: string;
  mode: SyncMode;
  /** 只在增量且改动范围已知时给出。 */
  paths?: string[];
  /** 全量派发前要先等同工作区在途的读结束，期间取消了就不再派发。 */
  cancelled: () => boolean;
}

export interface SyncExecutor {
  plan(workspace: string): Promise<SyncPlan>;
  /** 全量时调度器已经把同工作区的新读挡住（isRebuilding 为真），执行方负责排空在途的读、让读线程交出连接再派发。 */
  run(task: SyncTask): Promise<SyncOutcome>;
  cancel(runId: string): Promise<void>;
  /** 派发过的同步结束（成功或失败）后调用：读线程换连接，之后的读看得到这次写入。 */
  committed(workspace: string): Promise<void>;
}

export interface SyncRetryPolicy {
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: number;
  maxFailures: number;
  lockBaseMs: number;
  lockMaxMs: number;
  /** 被别的进程占锁持续这么久才作为一条 locked 事件报告一次。 */
  lockReportAfterMs: number;
}

export const DEFAULT_RETRY: SyncRetryPolicy = {
  baseMs: 30_000, factor: 2, maxMs: 30 * 60_000, jitter: 0.2, maxFailures: 6,
  lockBaseMs: 10_000, lockMaxMs: 120_000, lockReportAfterMs: 5 * 60_000,
};

export interface SyncEvent {
  workspace: string;
  outcome: 'failed' | 'breaker' | 'locked';
  triggers: SyncTrigger[];
  mode?: SyncMode;
  message: string;
  consecutiveFailures: number;
  nextRetryAt?: number;
}

export interface SyncView {
  phase: SyncPhase;
  mode?: SyncMode;
  trigger?: SyncTrigger;
  progress?: { stage: string; processed?: number; total?: number };
  queuedAt?: number;
  startedAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: { message: string; at: number; code?: string };
  consecutiveFailures: number;
  nextRetryAt?: number;
  /** 文件监听报过、还没进索引的文件数（范围说不清的整树比对不计数）。 */
  pendingChanges: number;
  /** 每次同步成功 +1，本进程内单调。 */
  generation: number;
}

export interface SyncRequest {
  trigger: SyncTrigger;
  /** 项目内相对路径；不给或 null 表示整棵树比对。 */
  paths?: readonly string[] | null;
  /** 手动同步（用户 job）：返回的 promise 在包含它的那次同步结束时落定。 */
  jobId?: string;
  onProgress?: (progress: IndexProgress) => void;
}

export interface SyncSchedulerOptions {
  executor: SyncExecutor;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  /** 等待执行的工作区数上限；超出时自动触发被丢弃（下次触发会再来），手动不受限。 */
  maxQueued?: number;
  /** 一个工作区攒的改动路径超过这么多就退回整树比对。 */
  maxPendingPaths?: number;
  /** 熔断后，自动触发（文件改动、激活）至少隔这么久才重新试一次。 */
  rearmAfterMs?: number;
  retry?: Partial<SyncRetryPolicy>;
  onEvent?: (event: SyncEvent) => void;
  /** 某个工作区的调度状态变了（进出队列、开始、结束）。 */
  onChange?: (workspace: string) => void;
}

interface Waiter {
  resolve: (outcome: SyncOutcome) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: IndexProgress) => void;
}

interface Batch {
  triggers: Set<SyncTrigger>;
  /** null = 整棵树比对。 */
  paths: Set<string> | null;
  waiters: Map<string, Waiter>;
  queuedAt: number;
}

interface Run extends Batch {
  runId: string;
  mode?: SyncMode;
  startedAt: number;
  cancelled: boolean;
  dispatched: boolean;
  progress?: SyncView['progress'];
  done?: Promise<void>;
}

interface Slot {
  key: string;
  workspace: string;
  running?: Run;
  pending?: Batch;
  backoffUntil?: number;
  timer?: unknown;
  breaker: boolean;
  /** 一次带路径的同步被取消或丢弃后，下一次自动同步整树比对，补上丢掉的那些路径。 */
  reconcile: boolean;
  consecutiveFailures: number;
  lockRetries: number;
  lockedSince?: number;
  lockReported: boolean;
  lastError?: SyncView['lastError'];
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastRearmAt?: number;
  generation: number;
}

const PRIORITY: Record<SyncTrigger, number> = { manual: 3, watch: 2, activate: 1, retry: 1 };
const STAGES: Record<string, string> = { scanning: '扫描文件', parsing: '解析代码', resolving: '解析引用', linking: '关联符号' };
export const SYNC_CLOSED = 'CodeGraph engine is closed';

export class SyncScheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly runs = new Map<string, { slot: Slot; run: Run }>();
  private readonly retry: SyncRetryPolicy;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;
  private seq = 0;
  private closed = false;

  constructor(private readonly options: SyncSchedulerOptions) {
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
  }

  /** 在跑的同步数（诊断采样用）。 */
  get running(): number { return this.runs.size; }

  /** 全量重建期间同工作区的读要挡掉：索引被就地重写，读到的会是半截数据。 */
  isRebuilding(key: string): boolean { return this.slots.get(key)?.running?.mode === 'full'; }

  /** 正在跑或排着队（含退避等待）的同步。 */
  isBusy(key: string): boolean { const slot = this.slots.get(key); return Boolean(slot?.running || slot?.pending); }

  request(key: string, workspace: string, request: SyncRequest): Promise<SyncOutcome> | undefined {
    const manual = request.trigger === 'manual';
    if (this.closed) return manual ? Promise.reject(new Error(SYNC_CLOSED)) : undefined;
    const slot = this.slot(key, workspace);
    if (!manual) {
      if (slot.breaker) {
        // 熔断后不再自己重试；文件改动 / 激活可以重新试一次，但有最短间隔，免得每次保存都撞同一个错。
        const now = this.now();
        if (slot.lastRearmAt !== undefined && now - slot.lastRearmAt < (this.options.rearmAfterMs ?? 5 * 60_000)) return undefined;
        slot.lastRearmAt = now;
      }
      if (!slot.pending && this.queuedCount() >= (this.options.maxQueued ?? 8)) {
        slot.reconcile = true;
        return undefined;
      }
    }
    const paths = slot.reconcile && !manual ? null : request.paths;
    if (!manual) slot.reconcile = false;
    const batch = slot.pending ??= { triggers: new Set(), paths: new Set(), waiters: new Map(), queuedAt: this.now() };
    batch.triggers.add(request.trigger);
    this.mergePaths(batch, paths);
    let result: Promise<SyncOutcome> | undefined;
    if (request.jobId !== undefined) {
      const jobId = request.jobId;
      result = new Promise<SyncOutcome>((resolve, reject) => { batch.waiters.set(jobId, { resolve, reject, onProgress: request.onProgress }); });
    }
    if (manual) this.clearBackoff(slot);
    this.pump();
    // 没能立刻开始（同工作区还有一次在跑）：先告诉任务它在排队。
    if (request.onProgress && slot.pending === batch) request.onProgress({ phase: 'queued', current: 0, total: 0 } as unknown as IndexProgress);
    this.changed(slot);
    return result;
  }

  async cancel(jobId: string): Promise<void> {
    for (const slot of this.slots.values()) {
      const pending = slot.pending;
      const waiter = pending?.waiters.get(jobId);
      if (pending && waiter) {
        pending.waiters.delete(jobId);
        waiter.reject(cancelledError());
        if (![...pending.waiters.keys()].length) pending.triggers.delete('manual');
        if (!pending.triggers.size) { slot.pending = undefined; if (pending.paths) slot.reconcile = true; }
        this.changed(slot);
        return;
      }
      const run = slot.running;
      if (run?.waiters.has(jobId)) {
        // 同一次同步里并进来的自动触发一起停；它们的路径在结束时记成「下次整树比对」。
        run.cancelled = true;
        if (run.dispatched) await this.options.executor.cancel(run.runId);
        return;
      }
    }
  }

  progress(runId: string, progress: IndexProgress): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const { phase, current, total } = progress as { phase: string; current?: number; total?: number };
    entry.run.progress = {
      stage: STAGES[phase] ?? phase,
      ...(Number.isSafeInteger(current) && Number.isSafeInteger(total) && (total as number) > 0 ? { processed: current, total } : {}),
    };
    for (const waiter of entry.run.waiters.values()) waiter.onProgress?.(progress);
  }

  view(key: string): SyncView {
    const slot = this.slots.get(key);
    if (!slot) return { phase: 'idle', consecutiveFailures: 0, pendingChanges: 0, generation: 0 };
    const now = this.now();
    const { running, pending } = slot;
    const waiting = slot.backoffUntil !== undefined && slot.backoffUntil > now;
    let phase: SyncPhase = 'idle';
    if (running) phase = running.mode === 'full' ? 'rebuilding' : 'syncing';
    else if (pending && waiting) phase = 'backoff';
    else if (pending) phase = 'queued';
    else if (slot.breaker) phase = 'failed';
    const lead = running ?? pending;
    return {
      phase,
      ...(running?.mode ? { mode: running.mode } : {}),
      ...(lead ? { trigger: topTrigger(lead.triggers) } : {}),
      ...(running?.progress ? { progress: running.progress } : {}),
      ...(pending ? { queuedAt: pending.queuedAt } : {}),
      ...(running ? { startedAt: running.startedAt } : {}),
      ...(slot.lastAttemptAt !== undefined ? { lastAttemptAt: slot.lastAttemptAt } : {}),
      ...(slot.lastSuccessAt !== undefined ? { lastSuccessAt: slot.lastSuccessAt } : {}),
      ...(slot.lastError ? { lastError: slot.lastError } : {}),
      consecutiveFailures: slot.consecutiveFailures,
      ...(pending && waiting ? { nextRetryAt: slot.backoffUntil } : {}),
      pendingChanges: this.pendingFiles(key, Number.POSITIVE_INFINITY).length,
      generation: slot.generation,
    };
  }

  /** 监听报过、还没进索引的文件（待执行在前），最多 limit 个。 */
  pendingFiles(key: string, limit: number): string[] {
    const slot = this.slots.get(key);
    if (!slot) return [];
    const seen = new Set<string>();
    for (const batch of [slot.pending, slot.running]) {
      for (const path of batch?.paths ?? []) {
        if (seen.size >= limit) return [...seen];
        seen.add(path);
      }
    }
    return [...seen];
  }

  async close(): Promise<void> {
    this.closed = true;
    const running: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      this.clearBackoff(slot);
      for (const waiter of slot.pending?.waiters.values() ?? []) waiter.reject(new Error(SYNC_CLOSED));
      slot.pending = undefined;
      const run = slot.running;
      if (!run) continue;
      run.cancelled = true;
      if (run.dispatched) await this.options.executor.cancel(run.runId).catch(() => undefined);
      if (run.done) running.push(run.done);
    }
    await Promise.allSettled(running);
  }

  private slot(key: string, workspace: string): Slot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { key, workspace, breaker: false, reconcile: false, consecutiveFailures: 0, lockRetries: 0, lockReported: false, generation: 0 };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private queuedCount(): number { let count = 0; for (const slot of this.slots.values()) if (slot.pending) count += 1; return count; }

  private mergePaths(batch: Batch, paths: readonly string[] | null | undefined): void {
    if (!paths || !paths.length) { batch.paths = null; return; }
    if (!batch.paths) return;
    for (const path of paths) batch.paths.add(path);
    if (batch.paths.size > (this.options.maxPendingPaths ?? 5_000)) batch.paths = null;
  }

  private pump(): void {
    if (this.closed) return;
    const now = this.now();
    const ready = [...this.slots.values()]
      .filter((slot) => slot.pending && !slot.running && !(slot.backoffUntil !== undefined && slot.backoffUntil > now))
      .sort((a, b) => topPriority(b.pending!.triggers) - topPriority(a.pending!.triggers) || a.pending!.queuedAt - b.pending!.queuedAt);
    for (const slot of ready) {
      // 手动同步照旧随时开始；自动同步只在一个同步都没有时开始，长索引期间不再往写线程里叠活。
      if (!slot.pending!.triggers.has('manual') && this.runs.size > 0) continue;
      this.start(slot);
    }
  }

  private start(slot: Slot): void {
    const batch = slot.pending!;
    slot.pending = undefined;
    this.clearBackoff(slot);
    const run: Run = { ...batch, runId: `sync-${++this.seq}`, startedAt: this.now(), cancelled: false, dispatched: false };
    slot.running = run;
    slot.lastAttemptAt = run.startedAt;
    this.runs.set(run.runId, { slot, run });
    run.done = this.execute(slot, run).finally(() => {
      this.runs.delete(run.runId);
      if (slot.running === run) slot.running = undefined;
      this.pump();
      this.changed(slot);
    });
  }

  private async execute(slot: Slot, run: Run): Promise<void> {
    const executor = this.options.executor;
    try {
      const manual = run.triggers.has('manual');
      const plan = await executor.plan(slot.workspace);
      if (run.cancelled) throw cancelledError();
      if (plan === 'uninitialized' && !manual) {
        // 只维护已有索引：自动触发不替用户建 .codegraph/。
        this.succeed(slot, run, { mode: 'incremental', filesChanged: 0 }, false);
        return;
      }
      // 自动同步一律增量：SDK 的 sync() 本身能补上次被打断的索引；抽取器升级后的全量重建只在用户手动同步时做。
      const mode: SyncMode = plan === 'uninitialized' || (manual && plan === 'full') ? 'full' : 'incremental';
      run.mode = mode;
      this.changed(slot);
      run.dispatched = true;
      let outcome: SyncOutcome;
      try {
        outcome = await executor.run({
          runId: run.runId, workspace: slot.workspace, mode,
          ...(mode === 'incremental' && run.paths?.size ? { paths: [...run.paths] } : {}),
          cancelled: () => run.cancelled || this.closed,
        });
      } finally {
        await executor.committed(slot.workspace).catch(() => undefined);
      }
      this.succeed(slot, run, outcome, true);
    } catch (error) {
      this.fail(slot, run, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private succeed(slot: Slot, run: Run, outcome: SyncOutcome, wrote: boolean): void {
    if (wrote) {
      slot.generation += 1;
      slot.lastSuccessAt = this.now();
    }
    slot.consecutiveFailures = 0;
    slot.lockRetries = 0;
    slot.lockedSince = undefined;
    slot.lockReported = false;
    slot.lastError = undefined;
    slot.breaker = false;
    slot.lastRearmAt = undefined;
    for (const waiter of run.waiters.values()) waiter.resolve(outcome);
  }

  private fail(slot: Slot, run: Run, error: Error): void {
    for (const waiter of run.waiters.values()) waiter.reject(error);
    const automatic = [...run.triggers].some((trigger) => trigger !== 'manual');
    const now = this.now();
    if (run.cancelled || error.name === 'AbortError' || this.closed) {
      if (run.paths) slot.reconcile = true;
      return;
    }
    if (error.name === 'LockUnavailableError') {
      // 另一个进程（官方 CLI / MCP）在写这个索引：延后重试，不计失败，也不熔断。
      slot.lastError = { message: error.message, at: now, code: 'CODEGRAPH_LOCKED' };
      slot.lockedSince ??= now;
      if (!slot.lockReported && now - slot.lockedSince >= this.retry.lockReportAfterMs) {
        slot.lockReported = true;
        this.emit(slot, run, 'locked', error.message);
      }
      if (!automatic) return;
      slot.lockRetries += 1;
      this.requeue(slot, run, this.delay(this.retry.lockBaseMs, slot.lockRetries, this.retry.lockMaxMs));
      return;
    }
    slot.consecutiveFailures += 1;
    slot.lastError = { message: error.message, at: now, ...(errorCode(error) ? { code: errorCode(error) } : {}) };
    if (slot.consecutiveFailures >= this.retry.maxFailures) {
      slot.breaker = true;
      slot.lastRearmAt = now;
      if (run.paths) slot.reconcile = true;
      // 熔断期间攒下的自动触发一并丢掉（下次整树比对补上），只留等着的手动任务。
      const pending = slot.pending;
      if (pending && !pending.waiters.size) { slot.pending = undefined; slot.reconcile = true; }
      else if (pending) { pending.triggers = new Set(['manual']); }
      this.emit(slot, run, 'breaker', error.message);
      return;
    }
    if (!automatic) { this.emit(slot, run, 'failed', error.message); return; }
    this.requeue(slot, run, this.delay(this.retry.baseMs, slot.consecutiveFailures, this.retry.maxMs));
    this.emit(slot, run, 'failed', error.message);
  }

  /** 把失败那次里自动触发的部分并回待执行槽，到点再跑（期间新的手动请求会提前开跑）。 */
  private requeue(slot: Slot, run: Run, delay: number): void {
    const batch = slot.pending ??= { triggers: new Set(), paths: new Set(), waiters: new Map(), queuedAt: run.queuedAt };
    batch.triggers.add('retry');
    batch.queuedAt = Math.min(batch.queuedAt, run.queuedAt);
    this.mergePaths(batch, run.paths ? [...run.paths] : null);
    this.clearBackoff(slot);
    if (batch.triggers.has('manual')) return;
    slot.backoffUntil = this.now() + delay;
    slot.timer = this.setTimer(() => { slot.timer = undefined; slot.backoffUntil = undefined; this.pump(); this.changed(slot); }, delay);
  }

  private delay(base: number, attempt: number, max: number): number {
    const raw = Math.min(max, base * this.retry.factor ** Math.max(0, attempt - 1));
    const jitter = 1 + (this.random() * 2 - 1) * this.retry.jitter;
    return Math.max(0, Math.round(raw * jitter));
  }

  private clearBackoff(slot: Slot): void {
    if (slot.timer !== undefined) this.clearTimer(slot.timer);
    slot.timer = undefined;
    slot.backoffUntil = undefined;
  }

  private emit(slot: Slot, run: Run, outcome: SyncEvent['outcome'], message: string): void {
    this.options.onEvent?.({
      workspace: slot.workspace, outcome, triggers: [...run.triggers], ...(run.mode ? { mode: run.mode } : {}), message,
      consecutiveFailures: slot.consecutiveFailures, ...(slot.backoffUntil !== undefined ? { nextRetryAt: slot.backoffUntil } : {}),
    });
  }

  private changed(slot: Slot): void { this.options.onChange?.(slot.workspace); }
}

function topPriority(triggers: Set<SyncTrigger>): number { let best = 0; for (const trigger of triggers) best = Math.max(best, PRIORITY[trigger]); return best; }
function topTrigger(triggers: Set<SyncTrigger>): SyncTrigger | undefined {
  let best: SyncTrigger | undefined;
  for (const trigger of triggers) if (!best || PRIORITY[trigger] > PRIORITY[best]) best = trigger;
  return best;
}

function errorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') return code;
  return /^([A-Z][A-Z0-9_]{3,}):/.exec(error.message)?.[1];
}

function cancelledError(): Error {
  const error = new Error('CodeGraph sync was cancelled; completed index writes are retained');
  error.name = 'AbortError';
  return error;
}
