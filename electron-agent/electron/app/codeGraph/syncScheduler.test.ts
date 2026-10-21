import { describe, expect, it, vi } from 'vitest';
import type { SyncOutcome, SyncPlan } from './codeGraphEngine';
import { SyncScheduler, type SyncEvent, type SyncExecutor, type SyncTask } from './syncScheduler';

function deferred<T = unknown>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 每次 run 都挂起，测试逐个放行；plan 默认 incremental。 */
function harness(options: { plan?: (workspace: string) => SyncPlan; maxFailures?: number } = {}) {
  let clock = 1_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const runs: Array<SyncTask & { done: ReturnType<typeof deferred<SyncOutcome>> }> = [];
  const order: string[] = [];
  const events: SyncEvent[] = [];
  const executor: SyncExecutor = {
    plan: vi.fn(async (workspace: string) => options.plan?.(workspace) ?? 'incremental'),
    run: vi.fn(async (task: SyncTask) => { const done = deferred<SyncOutcome>(); runs.push({ ...task, done }); order.push(`run:${task.workspace}:${task.mode}`); return done.promise; }),
    cancel: vi.fn(async (runId: string) => { const run = runs.find((r) => r.runId === runId); run?.done.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }),
    committed: vi.fn(async (workspace: string) => { order.push(`committed:${workspace}`); }),
  };
  const scheduler = new SyncScheduler({
    executor,
    now: () => clock,
    random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { at: clock + ms, fn, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
    retry: { maxFailures: options.maxFailures ?? 3 },
    onEvent: (event) => events.push(event),
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((t) => !t.cancelled && t.at <= clock)) { timer.cancelled = true; timer.fn(); }
    await flush();
  };
  return { scheduler, executor, runs, order, events, advance, now: () => clock };
}

const ok = (filesChanged = 1): SyncOutcome => ({ mode: 'incremental', filesChanged });

describe('SyncScheduler', () => {
  it('merges watcher paths into one pending batch while a sync runs, then runs it once with the union', async () => {
    const h = harness();
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].paths).toEqual(['x.ts']);
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['y.ts'] });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['z.ts', 'y.ts'] });
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'syncing', pendingChanges: 3 });
    expect(h.scheduler.pendingFiles('a', 10)).toEqual(['y.ts', 'z.ts', 'x.ts']);
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].paths).toEqual(['y.ts', 'z.ts']);
    h.runs[1].done.resolve(ok());
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', generation: 2, pendingChanges: 0, consecutiveFailures: 0 });
    expect(h.order.filter((step) => step.startsWith('committed'))).toHaveLength(2);
  });

  it('an unknown change range (null paths) or an activation absorbs the path list into a whole-tree sync', async () => {
    const h = harness();
    h.scheduler.request('a', 'A', { trigger: 'activate' });
    await flush();
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: null });
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs[1].paths).toBeUndefined();
  });

  it('a manual job queued behind a running auto sync completes with the next sync, and hears that it is queued', async () => {
    const h = harness();
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    const progress: unknown[] = [];
    const job = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'job-1', onProgress: (p) => progress.push(p) })!;
    expect(progress).toEqual([{ phase: 'queued', current: 0, total: 0 }]);
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs).toHaveLength(2);
    // 手动同步整树比对，不沿用 watcher 的路径
    expect(h.runs[1].paths).toBeUndefined();
    h.scheduler.progress(h.runs[1].runId, { phase: 'parsing', current: 1, total: 4 } as never);
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'syncing', trigger: 'manual', progress: { stage: '解析代码', processed: 1, total: 4 } });
    h.runs[1].done.resolve(ok(3));
    await expect(job).resolves.toEqual(ok(3));
    expect(progress.at(-1)).toEqual({ phase: 'parsing', current: 1, total: 4 });
  });

  it('manual jobs use the plan (full rebuild when the index needs it); automatic ones always go incremental', async () => {
    const h = harness({ plan: () => 'full' });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    expect(h.runs[0].mode).toBe('incremental');
    expect(h.scheduler.isRebuilding('a')).toBe(false);
    h.runs[0].done.resolve(ok());
    await flush();
    const job = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j' })!;
    await flush();
    expect(h.runs[1].mode).toBe('full');
    expect(h.scheduler.isRebuilding('a')).toBe(true);
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'rebuilding', mode: 'full' });
    h.runs[1].done.resolve({ mode: 'full' });
    await expect(job).resolves.toEqual({ mode: 'full' });
    expect(h.scheduler.isRebuilding('a')).toBe(false);
  });

  it('never creates an index on its own: automatic triggers on an uninitialized workspace are no-ops, manual ones build it', async () => {
    const h = harness({ plan: () => 'uninitialized' });
    h.scheduler.request('a', 'A', { trigger: 'activate' });
    await flush(); await flush();
    expect(h.runs).toHaveLength(0);
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', generation: 0 });
    void h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j' });
    await flush();
    expect(h.runs[0].mode).toBe('full');
  });

  it('automatic syncs run one at a time globally; manual syncs start right away like before', async () => {
    const h = harness();
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    h.scheduler.request('b', 'B', { trigger: 'watch', paths: ['y.ts'] });
    await flush();
    expect(h.runs.map((r) => r.workspace)).toEqual(['A']);
    expect(h.scheduler.view('b')).toMatchObject({ phase: 'queued' });
    void h.scheduler.request('c', 'C', { trigger: 'manual', jobId: 'jc' });
    await flush();
    expect(h.runs.map((r) => r.workspace)).toEqual(['A', 'C']);
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    // C 还在跑：B 等它
    expect(h.runs.map((r) => r.workspace)).toEqual(['A', 'C']);
    h.runs[1].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs.map((r) => r.workspace)).toEqual(['A', 'C', 'B']);
  });

  it('higher-priority triggers go first when the lane frees up', async () => {
    const h = harness();
    h.scheduler.request('busy', 'BUSY', { trigger: 'activate' });
    await flush();
    h.scheduler.request('a', 'A', { trigger: 'activate' });
    h.scheduler.request('b', 'B', { trigger: 'watch', paths: ['b.ts'] });
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs.map((r) => r.workspace)).toEqual(['BUSY', 'B']);
  });

  it('backs off exponentially after failures, keeps the paths, and opens the breaker at the limit', async () => {
    const h = harness({ maxFailures: 3 });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    h.runs[0].done.reject(new Error('CODEGRAPH_PARSE: boom'));
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'backoff', consecutiveFailures: 1, nextRetryAt: h.now() + 30_000, lastError: { message: 'CODEGRAPH_PARSE: boom', code: 'CODEGRAPH_PARSE' }, pendingChanges: 1 });
    expect(h.events.at(-1)).toMatchObject({ outcome: 'failed', consecutiveFailures: 1, nextRetryAt: h.now() + 30_000 });
    await h.advance(29_999);
    expect(h.runs).toHaveLength(1);
    await h.advance(1);
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].paths).toEqual(['x.ts']);
    h.runs[1].done.reject(new Error('boom'));
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'backoff', consecutiveFailures: 2, nextRetryAt: h.now() + 60_000 });
    await h.advance(60_000);
    h.runs[2].done.reject(new Error('boom'));
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'failed', consecutiveFailures: 3 });
    expect(h.events.at(-1)).toMatchObject({ outcome: 'breaker' });
    // 熔断后不再自己重试
    await h.advance(60 * 60_000);
    expect(h.runs).toHaveLength(3);
  });

  it('after the breaker opens, file changes re-arm at most once per interval, and a manual sync always runs and closes it', async () => {
    const h = harness({ maxFailures: 1 });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    h.runs[0].done.reject(new Error('boom'));
    await flush(); await flush();
    expect(h.scheduler.view('a').phase).toBe('failed');
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['y.ts'] });
    await flush();
    expect(h.runs).toHaveLength(1);
    await h.advance(5 * 60_000);
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['y.ts'] });
    await flush();
    expect(h.runs).toHaveLength(2);
    // 被丢掉的 x.ts 由整树比对补上
    expect(h.runs[1].paths).toBeUndefined();
    h.runs[1].done.reject(new Error('boom again'));
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'failed', consecutiveFailures: 2 });
    const job = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j' })!;
    await flush();
    h.runs[2].done.resolve(ok());
    await expect(job).resolves.toEqual(ok());
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', consecutiveFailures: 0 });
    expect(h.scheduler.view('a').lastError).toBeUndefined();
  });

  it('a manual job fails with the error and is not retried; a manual request during backoff runs immediately', async () => {
    const h = harness();
    const job = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j1' })!;
    await flush();
    h.runs[0].done.reject(new Error('disk full'));
    await expect(job).rejects.toThrow('disk full');
    await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', consecutiveFailures: 1, lastError: { message: 'disk full' } });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    h.runs[1].done.reject(new Error('disk full'));
    await flush(); await flush();
    expect(h.scheduler.view('a').phase).toBe('backoff');
    void h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j2' });
    await flush();
    expect(h.runs).toHaveLength(3);
    expect(h.scheduler.view('a').phase).toBe('syncing');
  });

  it('defers on lock contention without counting a failure, and reports it once after five minutes', async () => {
    const h = harness({ maxFailures: 2 });
    const locked = () => Object.assign(new Error('Sync could not acquire the file lock'), { name: 'LockUnavailableError' });
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    const delays: number[] = [];
    // 10s 起翻倍、上限 2 分钟；第 7 次撞锁时已经连续占锁超过 5 分钟
    for (let i = 0; i < 7; i += 1) {
      h.runs[i].done.reject(locked());
      await flush(); await flush();
      const view = h.scheduler.view('a');
      expect(view).toMatchObject({ phase: 'backoff', consecutiveFailures: 0, lastError: { code: 'CODEGRAPH_LOCKED' } });
      expect(h.events.filter((e) => e.outcome === 'locked')).toHaveLength(i < 6 ? 0 : 1);
      delays.push(view.nextRetryAt! - h.now());
      await h.advance(view.nextRetryAt! - h.now());
    }
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
    expect(h.runs).toHaveLength(8);
    h.runs[7].done.resolve(ok());
    await flush(); await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', consecutiveFailures: 0 });
  });

  it('cancelling a queued manual job removes it without touching the running sync; cancelling a running one aborts the write', async () => {
    const h = harness();
    h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] });
    await flush();
    const queued = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'q' })!;
    await h.scheduler.cancel('q');
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.executor.cancel).not.toHaveBeenCalled();
    h.runs[0].done.resolve(ok());
    await flush(); await flush();
    expect(h.runs).toHaveLength(1);

    const running = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'r' })!;
    await flush();
    await h.scheduler.cancel('r');
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.executor.cancel).toHaveBeenCalledWith(h.runs[1].runId);
    await flush();
    expect(h.scheduler.view('a')).toMatchObject({ phase: 'idle', consecutiveFailures: 0 });
  });

  it('cancel while planning never dispatches the write', async () => {
    const plan = deferred<SyncPlan>();
    const h = harness();
    (h.executor.plan as ReturnType<typeof vi.fn>).mockReturnValueOnce(plan.promise);
    const job = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'j' })!;
    await h.scheduler.cancel('j');
    plan.resolve('incremental');
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.runs).toHaveLength(0);
  });

  it('drops automatic requests past the queue limit and makes the next one a whole-tree sync', async () => {
    const h = harness();
    const scheduler = new SyncScheduler({ executor: h.executor, maxQueued: 1, now: h.now });
    scheduler.request('busy', 'BUSY', { trigger: 'activate' });
    await flush();
    scheduler.request('a', 'A', { trigger: 'watch', paths: ['a.ts'] });
    scheduler.request('b', 'B', { trigger: 'watch', paths: ['b.ts'] });
    expect(scheduler.view('a').phase).toBe('queued');
    expect(scheduler.view('b').phase).toBe('idle');
    scheduler.request('b', 'B', { trigger: 'watch', paths: ['c.ts'] });
    expect(scheduler.view('b').phase).toBe('idle');
    void scheduler.request('b', 'B', { trigger: 'manual', jobId: 'jb' });
    await flush();
    expect(h.runs.at(-1)).toMatchObject({ workspace: 'B' });
    expect(h.runs.at(-1)!.paths).toBeUndefined();
  });

  it('close rejects queued jobs, cancels running syncs and waits for them', async () => {
    const h = harness();
    const running = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'r' })!;
    running.catch(() => undefined);
    await flush();
    const queued = h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'q' })!;
    queued.catch(() => undefined);
    await h.scheduler.close();
    await expect(queued).rejects.toThrow('CodeGraph engine is closed');
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(h.scheduler.request('a', 'A', { trigger: 'manual', jobId: 'late' })).rejects.toThrow('closed');
    expect(h.scheduler.request('a', 'A', { trigger: 'watch', paths: ['x.ts'] })).toBeUndefined();
  });
});
