import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { autoSyncEnabled, CodeGraphThreads, defaultReaderCount, type CodeGraphThreadsOptions, type WorkerHandle } from './codeGraphThreads';
import type { WorkerMessage, WorkerRequest, WorkerRole } from './workerProtocol';

type Handler = (request: WorkerRequest, worker: FakeWorker) => unknown | Promise<unknown>;

class FakeWorker extends EventEmitter implements WorkerHandle {
  readonly received: WorkerRequest[] = [];
  constructor(readonly role: WorkerRole, readonly index: number, private readonly handler: Handler) {
    super();
    queueMicrotask(() => this.send({ type: 'ready' }));
  }
  send(message: WorkerMessage): void { this.emit('message', message); }
  postMessage(request: WorkerRequest): void {
    this.received.push(request);
    void Promise.resolve().then(() => this.handler(request, this)).then(
      (value) => this.send({ type: 'result', id: request.id, ok: true, value: value ?? null }),
      (error: Error) => this.send({ type: 'result', id: request.id, ok: false, error: { message: error.message, name: error.name } }),
    );
    if (request.op === 'close') queueMicrotask(() => this.emit('exit', 0));
  }
  ops(): string[] { return this.received.map((r) => r.op); }
  crash(code = 1): void { this.emit('error', new Error('boom')); this.emit('exit', code); }
  terminate = vi.fn(async () => 1);
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 写线程的 plan 默认回 incremental、watch 默认挂上；其它交给 handler。 */
function setup(handler: Handler, readers = 2, now = () => 0, extra: Partial<CodeGraphThreadsOptions> = {}) {
  const workers: FakeWorker[] = [];
  const wrapped: Handler = (request, worker) => {
    const value = handler(request, worker);
    if (value !== undefined) return value;
    if (request.op === 'plan') return 'incremental';
    if (request.op === 'watch') return { active: true };
    return null;
  };
  const threads = new CodeGraphThreads({
    readers, now, autoSync: false, isIndexed: () => false,
    createWorker: (role) => { const w = new FakeWorker(role, workers.length, wrapped); workers.push(w); return w; },
    ...extra,
  });
  const of = (role: WorkerRole) => workers.filter((w) => w.role === role);
  return { threads, workers, of };
}

const indexed = (workspace: string) => ({ workspace, connected: true, indexed: true, sdkAvailable: true, sdkVersion: '1.6.2', state: 'indexed', files: 3, nodes: 9, edges: 4 });
const W = (name: string) => (process.platform === 'win32' ? `C:\\cg\\${name}` : `/cg/${name}`);
const result = (text: string) => ({ content: [{ type: 'text', text }], isError: false, structuredContent: { schemaVersion: 1, rows: [], nodes: [], edges: [] } });

describe('CodeGraphThreads', () => {
  it('runs a sync on the write thread while other workspaces are queried concurrently on read threads', async () => {
    const sync = deferred();
    const queries: Array<ReturnType<typeof deferred>> = [];
    const { threads, of } = setup((request) => {
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'call') { const d = deferred(); queries.push(d); return d.promise; }
      return undefined;
    });
    const running = threads.runSync('job-a', W('a'));
    const q1 = threads.call(W('b'), 'codegraph_search', { query: 'x' });
    const q2 = threads.call(W('c'), 'codegraph_search', { query: 'y' });
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    // 两个查询落在两个不同的读线程上，写线程上的同步还没结束
    expect(of('read').map((w) => w.received.filter((r) => r.op === 'call').length)).toEqual([1, 1]);
    await vi.waitFor(() => expect(of('write')[0].ops()).toEqual(['plan', 'runSync']));
    queries.forEach((q, i) => q.resolve({ n: i }));
    await expect(Promise.all([q1, q2])).resolves.toEqual([{ n: 0 }, { n: 1 }]);
    expect(threads.syncing).toBe(1);
    sync.resolve({ mode: 'incremental', filesChanged: 1 });
    await expect(running).resolves.toEqual({ mode: 'incremental', filesChanged: 1 });
    expect(threads.syncing).toBe(0);
  });

  it('keeps answering reads of the workspace during an incremental sync, then has the read threads swap connections', async () => {
    const sync = deferred();
    const { threads, of } = setup((request) => {
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'status') return indexed(request.workspace);
      if (request.op === 'call') return result('old rows');
      return undefined;
    });
    await threads.status(W('a'));
    const running = threads.runSync('job-a', W('a'));
    await vi.waitFor(() => expect(of('write')[0].ops()).toContain('runSync'));
    expect((of('write')[0].received.find((r) => r.op === 'runSync') as { mode?: string }).mode).toBe('incremental');
    await expect(threads.call(W('a'), 'codegraph_search', { query: 'x' })).resolves.toMatchObject({
      content: [{ text: 'old rows' }],
      structuredContent: { meta: { servingStale: true, phase: 'syncing', generation: 0, pendingFiles: 0, files: [] } },
    });
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexed', phase: 'syncing', trigger: 'manual', servingStale: true, files: 3 });
    // 读线程上没有 evict：增量同步不让读交出连接
    expect(of('read').flatMap((w) => w.ops())).not.toContain('evict');
    sync.resolve({ mode: 'incremental', filesChanged: 2 });
    await running;
    // 写完：每个已启动的读线程换连接
    expect(of('read').filter((w) => w.ops().includes('status') || w.ops().includes('call')).every((w) => w.ops().at(-1) === 'refresh')).toBe(true);
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexed', phase: 'idle', servingStale: false, generation: 1 });
    const fresh = await threads.call(W('a'), 'codegraph_search', { query: 'x' });
    expect(fresh.structuredContent.meta).toBeUndefined();
  });

  it('keeps the busy rule during a full rebuild, and reports indexing with the last snapshot', async () => {
    const sync = deferred();
    const { threads, of } = setup((request) => {
      if (request.op === 'plan') return 'full';
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'status') return indexed(request.workspace);
      if (request.op === 'search') return { workspace: request.workspace, available: true, results: [] };
      return undefined;
    });
    await threads.status(W('a'));
    const running = threads.runSync('job-a', W('a'));
    await vi.waitFor(() => expect(of('write')[0].ops()).toContain('runSync'));
    await expect(threads.call(W('a'), 'codegraph_search', { query: 'x' })).rejects.toThrow('CodeGraph workspace is busy indexing');
    await expect(threads.search(W('a'), 'x', 5)).resolves.toEqual({ workspace: W('a'), available: false, results: [], message: 'CodeGraph workspace is busy indexing' });
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexing', phase: 'rebuilding', mode: 'full', files: 3, nodes: 9, connected: true });
    sync.resolve({ mode: 'full' });
    await running;
    await expect(threads.search(W('a'), 'x', 5)).resolves.toMatchObject({ available: true });
  });

  it('a second manual job for the same workspace queues behind the running one instead of failing busy', async () => {
    const syncs: Array<ReturnType<typeof deferred>> = [];
    const { threads, of } = setup((request) => {
      if (request.op === 'runSync') { const d = deferred(); syncs.push(d); return d.promise; }
      return undefined;
    });
    const first = threads.runSync('job-a', W('a'));
    await vi.waitFor(() => expect(syncs).toHaveLength(1));
    const stages: unknown[] = [];
    const second = threads.runSync('job-b', W('a'), (p) => stages.push(p));
    expect(stages).toEqual([{ phase: 'queued', current: 0, total: 0 }]);
    syncs[0].resolve({ mode: 'incremental' });
    await first;
    await vi.waitFor(() => expect(syncs).toHaveLength(2));
    syncs[1].resolve({ mode: 'incremental' });
    await second;
    expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(2);
  });

  it('validates arguments before the busy check, like the in-process engine', async () => {
    const { threads } = setup(() => undefined);
    await expect(threads.call(W('a'), 'codegraph_sync' as never, {})).rejects.toThrow(/tool/i);
    await expect(threads.call(W('a'), 'codegraph_node', { file: '../x.ts' })).rejects.toThrow(/file/);
  });

  it('before a full rebuild, waits for in-flight reads of that workspace and evicts read handles', async () => {
    const read = deferred();
    const order: string[] = [];
    const { threads, of } = setup((request) => {
      order.push(`${request.op}`);
      if (request.op === 'plan') return 'full';
      if (request.op === 'call') return read.promise;
      return undefined;
    });
    const pending = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(order).toContain('call'));
    const running = threads.runSync('job-a', W('a'));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).not.toContain('runSync');
    read.resolve(result('x'));
    await pending;
    await running;
    expect(order.filter((op) => op !== 'refresh').slice(-2)).toEqual(['evict', 'runSync']);
    // 只给已经起来的读线程发 evict
    expect(of('read').flatMap((w) => w.received.filter((r) => r.op === 'evict'))).toHaveLength(1);
  });

  it('records a failed sync into status and clears it after a successful one', async () => {
    let fail = true;
    const { threads } = setup((request) => {
      if (request.op === 'runSync') { if (fail) throw new Error('parse exploded'); return null; }
      if (request.op === 'status') return indexed(request.workspace);
      return undefined;
    });
    await expect(threads.runSync('j1', W('a'))).rejects.toThrow('parse exploded');
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'failed', message: 'parse exploded', lastError: { message: 'parse exploded' }, consecutiveFailures: 1 });
    fail = false;
    await threads.runSync('j2', W('a'));
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexed', consecutiveFailures: 0 });
  });

  it('does not report lock contention by another process as a failed index', async () => {
    const { threads } = setup((request) => {
      if (request.op === 'runSync') throw Object.assign(new Error('Sync could not acquire the file lock'), { name: 'LockUnavailableError' });
      if (request.op === 'status') return indexed(request.workspace);
      return undefined;
    });
    await expect(threads.runSync('j1', W('a'))).rejects.toMatchObject({ name: 'LockUnavailableError' });
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexed', lastError: { code: 'CODEGRAPH_LOCKED' }, consecutiveFailures: 0 });
  });

  it('cancels a full rebuild still waiting for reads without dispatching it, and forwards cancel after dispatch', async () => {
    const read = deferred();
    const sync = deferred();
    const { threads, of } = setup((request) => {
      if (request.op === 'plan') return request.workspace === W('a') ? 'full' : 'incremental';
      if (request.op === 'call') return read.promise;
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'cancelSync') { sync.reject(Object.assign(new Error('CodeGraph sync was cancelled; completed index writes are retained'), { name: 'AbortError' })); return null; }
      return undefined;
    });
    const blocking = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    const early = threads.runSync('early', W('a'));
    await vi.waitFor(() => expect(of('write')[0]?.ops()).toEqual(['plan']));
    await threads.cancelSync('early');
    read.resolve(result('x'));
    await blocking;
    await expect(early).rejects.toMatchObject({ name: 'AbortError' });
    expect(of('write')[0].ops()).not.toContain('runSync');

    const late = threads.runSync('late', W('b'));
    await vi.waitFor(() => expect(of('write')[0].ops()).toContain('runSync'));
    await threads.cancelSync('late');
    await expect(late).rejects.toThrow(/cancelled/);
    expect(of('write')[0].ops()).toEqual(['plan', 'plan', 'runSync', 'cancelSync']);
  });

  it('a crashed read thread fails its in-flight request and the next request gets a fresh thread', async () => {
    const { threads, of } = setup((request) => (request.op === 'call' ? new Promise(() => {}) : { ok: true }), 1);
    const doomed = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(of('read')[0]?.received).toHaveLength(1));
    of('read')[0].crash();
    await expect(doomed).rejects.toThrow(/CODEGRAPH_WORKER_EXITED: read code=1 boom/);
    await expect(threads.status(W('a'))).resolves.toMatchObject({ ok: true });
    expect(of('read')).toHaveLength(2);
  });

  it('cools down after repeated crashes instead of respawning in a loop', async () => {
    let clock = 0;
    const { threads, of } = setup((request) => (request.op === 'call' ? new Promise(() => {}) : null), 1, () => clock);
    for (let i = 0; i < 3; i += 1) {
      const doomed = threads.call(W('a'), 'codegraph_search', { query: 'x' });
      await vi.waitFor(() => expect(of('read')[i]?.received.length).toBe(1));
      of('read')[i].crash();
      await expect(doomed).rejects.toThrow(/CODEGRAPH_WORKER_EXITED/);
    }
    await expect(threads.call(W('a'), 'codegraph_search', { query: 'x' })).rejects.toThrow(/CODEGRAPH_WORKER_CRASH_LOOP/);
    expect(of('read')).toHaveLength(3);
    clock = 31_000;
    void threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(of('read')).toHaveLength(4));
  });

  it('a crashed write thread fails the sync and leaves the workspace readable', async () => {
    const { threads, of } = setup((request) => (request.op === 'runSync' ? new Promise(() => {}) : request.op === 'search' ? { workspace: W('a'), available: true, results: [] } : undefined));
    const running = threads.runSync('job', W('a'));
    await vi.waitFor(() => expect(of('write')[0]?.ops()).toContain('runSync'));
    of('write')[0].crash(3221225477);
    await expect(running).rejects.toThrow(/CODEGRAPH_WORKER_EXITED: write code=3221225477/);
    await expect(threads.search(W('a'), 'x', 1)).resolves.toMatchObject({ available: true });
  });

  it('routes write progress to the job that asked for it', async () => {
    const { threads } = setup((request, worker) => {
      if (request.op === 'runSync') worker.send({ type: 'progress', jobId: request.jobId, progress: { phase: 'parsing', current: 1, total: 2 } as never });
      return undefined;
    });
    const seen: unknown[] = [];
    await threads.runSync('job', W('a'), (p) => seen.push(p));
    expect(seen).toEqual([{ phase: 'parsing', current: 1, total: 2 }]);
  });

  it('close cancels running syncs, waits for them, then lets every started thread close itself', async () => {
    const sync = deferred();
    const { threads, of } = setup((request) => {
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'cancelSync') { sync.reject(new Error('cancelled')); return null; }
      return undefined;
    });
    await threads.status(W('b'));
    const running = threads.runSync('job', W('a'));
    running.catch(() => undefined);
    await vi.waitFor(() => expect(of('write')[0]?.ops()).toContain('runSync'));
    await threads.close();
    expect(of('write')[0].ops()).toEqual(['plan', 'runSync', 'cancelSync', 'close']);
    expect(of('read')[0].received.at(-1)?.op).toBe('close');
    expect(of('read')[0].terminate).not.toHaveBeenCalled();
    await expect(threads.call(W('a'), 'codegraph_search', { query: 'x' })).rejects.toThrow('CodeGraph engine is closed');
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'failed', message: 'CodeGraph engine is closed' });
  });

  it('picks reader count from the environment or the core count', () => {
    expect(defaultReaderCount(undefined, 16)).toBe(2);
    expect(defaultReaderCount(undefined, 3)).toBe(1);
    expect(defaultReaderCount('4', 2)).toBe(4);
    expect(defaultReaderCount('99', 2)).toBe(8);
    expect(defaultReaderCount('0', 16)).toBe(2);
    expect(defaultReaderCount('abc', 16)).toBe(2);
    expect(autoSyncEnabled(undefined)).toBe(true);
    expect(autoSyncEnabled('off')).toBe(false);
    expect(autoSyncEnabled(' FALSE ')).toBe(false);
  });
});

describe('CodeGraphThreads auto sync', () => {
  const auto = (handler: Handler, extra: Partial<CodeGraphThreadsOptions> = {}, now = () => 0) =>
    setup((request, worker) => handler(request, worker) ?? (request.op === 'call' ? result('rows') : undefined), 1, now, { autoSync: true, isIndexed: () => true, ...extra });
  const query = (threads: CodeGraphThreads, name: string) => threads.call(W(name), 'codegraph_search', { query: 'x' });

  it('the first query of an indexed workspace starts a watcher and a whole-tree catch-up sync; later queries and status reads do not', async () => {
    const { threads, of } = auto((request) => (request.op === 'status' ? indexed(request.workspace) : undefined));
    await query(threads, 'a');
    await vi.waitFor(() => expect(of('write')[0].ops()).toEqual(['watch', 'plan', 'runSync']));
    const watch = of('write')[0].received[0] as Extract<WorkerRequest, { op: 'watch' }>;
    expect(watch).toMatchObject({ workspace: W('a'), debounceMs: 1000 });
    const run = of('write')[0].received[2] as Extract<WorkerRequest, { op: 'runSync' }>;
    expect(run).toMatchObject({ mode: 'incremental' });
    expect(run.paths).toBeUndefined();
    await vi.waitFor(async () => expect(await threads.status(W('a'))).toMatchObject({ phase: 'idle', watcher: { active: true, degraded: false }, autoSync: true }));
    await query(threads, 'a');
    await threads.search(W('a'), 'x', 5);
    expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(1);
  });

  it('reading status alone (diagnostics, project overview) never starts a watcher or a sync', async () => {
    const { threads, of } = auto((request) => (request.op === 'status' ? indexed(request.workspace) : undefined));
    await threads.status(W('a'));
    await new Promise((r) => setTimeout(r, 5));
    expect(of('write')).toHaveLength(0);
  });

  it('never touches workspaces without an index, and does nothing when auto sync is off', async () => {
    const off = setup((request) => (request.op === 'status' ? indexed(request.workspace) : undefined), 1, () => 0, { autoSync: false, isIndexed: () => true });
    await off.threads.search(W('a'), 'x', 1);
    const missing = setup(() => undefined, 1, () => 0, { autoSync: true, isIndexed: () => false });
    await missing.threads.search(W('a'), 'x', 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(off.of('write')).toHaveLength(0);
    expect(missing.of('write')).toHaveLength(0);
    await expect(off.threads.status(W('a'))).resolves.toMatchObject({ autoSync: false, phase: 'idle' });
  });

  it('turns watcher change events into incremental syncs of exactly those paths, and tells the model which files lag', async () => {
    const syncs: Array<ReturnType<typeof deferred>> = [];
    const { threads, of } = auto((request) => {
      if (request.op === 'runSync') { const d = deferred(); syncs.push(d); return d.promise; }
      if (request.op === 'call') return result('rows');
      return undefined;
    });
    await threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(syncs).toHaveLength(1));
    const writer = of('write')[0];
    writer.send({ type: 'changed', workspace: W('a'), paths: ['src/a.ts', 'src/b.ts'] });
    writer.send({ type: 'changed', workspace: W('a'), paths: ['src/c.ts'] });
    const lagging = await threads.call(W('a'), 'codegraph_search', { query: 'x' });
    expect(lagging.structuredContent.meta).toMatchObject({ servingStale: true, pendingFiles: 3, files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    expect(lagging.content.at(-1)?.text).toBe('Note: the CodeGraph index has not caught up with 3 recently changed file(s): src/a.ts, src/b.ts, src/c.ts. Results from these files may be outdated; read them directly if they matter.');
    syncs[0].resolve({ mode: 'incremental' });
    await vi.waitFor(() => expect(syncs).toHaveLength(2));
    expect(writer.received.filter((r) => r.op === 'runSync').at(-1)).toMatchObject({ mode: 'incremental', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    syncs[1].resolve({ mode: 'incremental' });
    await vi.waitFor(async () => expect((await threads.status(W('a'))).phase).toBe('idle'));
    const caughtUp = await threads.call(W('a'), 'codegraph_search', { query: 'x' });
    expect(caughtUp.content).toHaveLength(1);
    expect(caughtUp.structuredContent.meta).toBeUndefined();
  });

  it('watches at most maxWatched workspaces, evicting the least recently used one', async () => {
    const { threads, of } = auto(() => undefined, { maxWatched: 2 });
    for (const name of ['a', 'b']) await query(threads, name);
    await vi.waitFor(() => expect(of('write')[0].ops().filter((op) => op === 'watch')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 5));
    await query(threads, 'a');
    await query(threads, 'c');
    await vi.waitFor(() => expect(of('write')[0].received.filter((r) => r.op === 'unwatch')).toEqual([expect.objectContaining({ workspace: W('b') })]));
  });

  it('a degraded watcher is reported, and the workspace falls back to a catch-up sync on access after staleAfterMs', async () => {
    let clock = 0;
    const { threads, of } = auto((request) => (request.op === 'status' ? indexed(request.workspace) : undefined), { staleAfterMs: 1_000 }, () => clock);
    await query(threads, 'a');
    await vi.waitFor(() => expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(1));
    of('write')[0].send({ type: 'watchDegraded', workspace: W('a'), reason: 'EMFILE: too many open files' });
    await vi.waitFor(async () => expect(await threads.status(W('a'))).toMatchObject({ watcher: { active: false, degraded: true, reason: 'EMFILE: too many open files' }, phase: 'idle' }));
    expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(1);
    clock = 1_000;
    await query(threads, 'a');
    await vi.waitFor(() => expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(2));
  });

  it('when the write thread dies, watchers are re-armed on the next access with a catch-up sync', async () => {
    const { threads, of } = auto(() => undefined);
    await query(threads, 'a');
    await vi.waitFor(() => expect(of('write')[0].ops().filter((op) => op === 'runSync')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));
    of('write')[0].crash();
    await query(threads, 'a');
    await vi.waitFor(() => expect(of('write')[1]?.ops()).toEqual(['watch', 'plan', 'runSync']));
  });
});
