import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CodeGraphThreads, defaultReaderCount, type WorkerHandle } from './codeGraphThreads';
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
  crash(code = 1): void { this.emit('error', new Error('boom')); this.emit('exit', code); }
  terminate = vi.fn(async () => 1);
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(handler: Handler, readers = 2, now = () => 0) {
  const workers: FakeWorker[] = [];
  const threads = new CodeGraphThreads({ readers, now, createWorker: (role) => { const w = new FakeWorker(role, workers.length, handler); workers.push(w); return w; } });
  const of = (role: WorkerRole) => workers.filter((w) => w.role === role);
  return { threads, workers, of };
}

const indexed = (workspace: string) => ({ workspace, connected: true, indexed: true, sdkAvailable: true, sdkVersion: '1.6.2', state: 'indexed', files: 3, nodes: 9, edges: 4 });
const W = (name: string) => (process.platform === 'win32' ? `C:\\cg\\${name}` : `/cg/${name}`);

describe('CodeGraphThreads', () => {
  it('runs a sync on the write thread while other workspaces are queried concurrently on read threads', async () => {
    const sync = deferred();
    const queries: Array<ReturnType<typeof deferred>> = [];
    const { threads, of } = setup((request) => {
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'call') { const d = deferred(); queries.push(d); return d.promise; }
      return null;
    });
    const running = threads.runSync('job-a', W('a'));
    const q1 = threads.call(W('b'), 'codegraph_search', { query: 'x' });
    const q2 = threads.call(W('c'), 'codegraph_search', { query: 'y' });
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    // 两个查询落在两个不同的读线程上，写线程上的同步还没结束
    expect(of('read').map((w) => w.received.filter((r) => r.op === 'call').length)).toEqual([1, 1]);
    expect(of('write')[0].received.map((r) => r.op)).toEqual(['runSync']);
    queries.forEach((q, i) => q.resolve({ n: i }));
    await expect(Promise.all([q1, q2])).resolves.toEqual([{ n: 0 }, { n: 1 }]);
    expect(threads.syncing).toBe(1);
    sync.resolve(null);
    await running;
    expect(threads.syncing).toBe(0);
  });

  it('keeps the busy rule for the workspace being written, and reports indexing with the last snapshot', async () => {
    const sync = deferred();
    const { threads } = setup((request) => {
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'status') return indexed(request.workspace);
      if (request.op === 'search') return { workspace: request.workspace, available: true, results: [] };
      return null;
    });
    await threads.status(W('a'));
    const running = threads.runSync('job-a', W('a'));
    await expect(threads.call(W('a'), 'codegraph_search', { query: 'x' })).rejects.toThrow('CodeGraph workspace is busy indexing');
    await expect(threads.search(W('a'), 'x', 5)).resolves.toEqual({ workspace: W('a'), available: false, results: [], message: 'CodeGraph workspace is busy indexing' });
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexing', files: 3, nodes: 9, connected: true });
    await expect(threads.runSync('job-b', W('a'))).rejects.toThrow('CodeGraph workspace is busy indexing');
    sync.resolve(null);
    await running;
    await expect(threads.search(W('a'), 'x', 5)).resolves.toMatchObject({ available: true });
  });

  it('validates arguments before the busy check, like the in-process engine', async () => {
    const { threads } = setup(() => null);
    await expect(threads.call(W('a'), 'codegraph_sync' as never, {})).rejects.toThrow(/tool/i);
    await expect(threads.call(W('a'), 'codegraph_node', { file: '../x.ts' })).rejects.toThrow(/file/);
  });

  it('waits for in-flight reads of that workspace and evicts read handles before dispatching the write', async () => {
    const read = deferred();
    const order: string[] = [];
    const { threads, of } = setup((request) => {
      order.push(`${request.op}`);
      if (request.op === 'call') return read.promise;
      return null;
    });
    const pending = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(order).toContain('call'));
    const running = threads.runSync('job-a', W('a'));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).not.toContain('runSync');
    read.resolve({ ok: 1 });
    await pending;
    await running;
    expect(order.slice(-2)).toEqual(['evict', 'runSync']);
    // 只给已经起来的读线程发 evict
    expect(of('read').flatMap((w) => w.received.filter((r) => r.op === 'evict'))).toHaveLength(1);
  });

  it('records a failed sync into status and clears it after a successful one', async () => {
    let fail = true;
    const { threads } = setup((request) => {
      if (request.op === 'runSync') { if (fail) throw new Error('parse exploded'); return null; }
      if (request.op === 'status') return indexed(request.workspace);
      return null;
    });
    await expect(threads.runSync('j1', W('a'))).rejects.toThrow('parse exploded');
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'failed', message: 'parse exploded' });
    fail = false;
    await threads.runSync('j2', W('a'));
    await expect(threads.status(W('a'))).resolves.toMatchObject({ state: 'indexed' });
  });

  it('cancels before dispatch without touching the write thread, and forwards cancel after dispatch', async () => {
    const read = deferred();
    const sync = deferred();
    const { threads, of } = setup((request) => {
      if (request.op === 'call') return read.promise;
      if (request.op === 'runSync') return sync.promise;
      if (request.op === 'cancelSync') { sync.reject(Object.assign(new Error('CodeGraph sync was cancelled; completed index writes are retained'), { name: 'AbortError' })); return null; }
      return null;
    });
    const blocking = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    const early = threads.runSync('early', W('a'));
    await threads.cancelSync('early');
    read.resolve({});
    await blocking;
    await expect(early).rejects.toMatchObject({ name: 'AbortError' });
    expect(of('write')).toHaveLength(0);

    const late = threads.runSync('late', W('b'));
    await vi.waitFor(() => expect(of('write')[0]?.received.some((r) => r.op === 'runSync')).toBe(true));
    await threads.cancelSync('late');
    await expect(late).rejects.toThrow(/cancelled/);
    expect(of('write')[0].received.map((r) => r.op)).toEqual(['runSync', 'cancelSync']);
  });

  it('a crashed read thread fails its in-flight request and the next request gets a fresh thread', async () => {
    const { threads, of } = setup((request) => (request.op === 'call' ? new Promise(() => {}) : { ok: true }), 1);
    const doomed = threads.call(W('a'), 'codegraph_search', { query: 'x' });
    await vi.waitFor(() => expect(of('read')[0]?.received).toHaveLength(1));
    of('read')[0].crash();
    await expect(doomed).rejects.toThrow(/CODEGRAPH_WORKER_EXITED: read code=1 boom/);
    await expect(threads.status(W('a'))).resolves.toEqual({ ok: true });
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

  it('a crashed write thread fails the sync and releases the workspace for reads', async () => {
    const { threads, of } = setup((request) => (request.op === 'runSync' ? new Promise(() => {}) : { workspace: W('a'), available: true, results: [] }));
    const running = threads.runSync('job', W('a'));
    await vi.waitFor(() => expect(of('write')[0]?.received).toHaveLength(1));
    of('write')[0].crash(3221225477);
    await expect(running).rejects.toThrow(/CODEGRAPH_WORKER_EXITED: write code=3221225477/);
    await expect(threads.search(W('a'), 'x', 1)).resolves.toMatchObject({ available: true });
  });

  it('routes write progress to the job that asked for it', async () => {
    const { threads } = setup((request, worker) => {
      if (request.op === 'runSync') worker.send({ type: 'progress', jobId: request.jobId, progress: { phase: 'parsing', current: 1, total: 2 } as never });
      return null;
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
      return null;
    });
    await threads.status(W('b'));
    const running = threads.runSync('job', W('a'));
    running.catch(() => undefined);
    await vi.waitFor(() => expect(of('write')[0]?.received).toHaveLength(1));
    await threads.close();
    expect(of('write')[0].received.map((r) => r.op)).toEqual(['runSync', 'cancelSync', 'close']);
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
  });
});
