import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeGraphEngine, type CodeGraphSdk } from './codeGraphEngine';
import { executeCodeGraphTool } from './codeGraphQuery';

vi.mock('./codeGraphQuery', () => ({ executeCodeGraphTool: vi.fn(async () => ({ content: [], isError: false, structuredContent: { schemaVersion: 1, rows: [], nodes: [], edges: [] } })) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(initialized = true) {
  const graph = {
    close: vi.fn(), watch: vi.fn(),
    getStats: vi.fn(() => ({ fileCount: 2, nodeCount: 5, edgeCount: 6 })),
    getIndexState: vi.fn(() => 'complete'), isIndexStale: vi.fn(() => false),
    getLastIndexedAt: vi.fn(() => 123), reopenIfReplaced: vi.fn(),
    indexAll: vi.fn(async (_options?: unknown) => ({ success: true })),
    sync: vi.fn(async (_options?: unknown) => ({ filesAdded: 0, filesModified: 0, filesRemoved: 0 })),
  };
  const sdk = { CodeGraph: { open: vi.fn(async () => graph), init: vi.fn(async () => graph) }, isInitialized: vi.fn(() => initialized) };
  const engine = new CodeGraphEngine({ loadSdk: async () => sdk as unknown as CodeGraphSdk });
  engines.push(engine);
  return { engine, graph, sdk };
}
const engines: CodeGraphEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map((engine) => engine.close())); vi.clearAllMocks(); });

describe('embedded CodeGraph lifecycle', () => {
  it('closes an instance whose async open finishes after shutdown was requested', async () => {
    const { engine, sdk, graph } = fixture();
    const pending = deferred<typeof graph>();
    sdk.CodeGraph.open.mockImplementationOnce(() => pending.promise);
    const reading = engine.call('/repo', 'codegraph_search', { query: 'a' }).catch((error) => error);
    await vi.waitFor(() => expect(sdk.CodeGraph.open).toHaveBeenCalled());
    const closing = engine.close();
    pending.resolve(graph);
    await closing;
    expect(await reading).toBeInstanceOf(Error);
    expect(graph.close).toHaveBeenCalledOnce();
  });

  it('closes idle instances and reopens on demand', async () => {
    const { sdk, graph } = fixture();
    const engine = new CodeGraphEngine({ loadSdk: async () => sdk as unknown as CodeGraphSdk, idleTimeoutMs: 5 });
    engines.push(engine);
    await engine.call('/repo', 'codegraph_search', { query: 'a' });
    await vi.waitFor(() => expect(graph.close).toHaveBeenCalledOnce());
    await engine.call('/repo', 'codegraph_search', { query: 'b' });
    expect(sdk.CodeGraph.open).toHaveBeenCalledTimes(2);
  });

  it('treats a leftover indexing marker as an interrupted partial index', async () => {
    const { engine, graph } = fixture();
    graph.getIndexState.mockReturnValue('indexing');
    expect(await engine.status('/repo')).toMatchObject({ connected: true, state: 'partial' });
  });

  it('does not query a cached handle after its index disappears', async () => {
    const { engine, sdk } = fixture();
    await engine.call('/repo', 'codegraph_search', { query: 'parse' });
    sdk.isInitialized.mockReturnValue(false);
    await expect(engine.call('/repo', 'codegraph_search', { query: 'parse' })).rejects.toThrow(/not initialized/i);
  });

  it('rejects a full index that reports success but remains incomplete', async () => {
    const { engine, graph } = fixture(false);
    graph.getIndexState.mockReturnValue('partial');
    await expect(engine.runSync('partial', '/repo')).rejects.toThrow(/partial/i);
  });

  it('does not initialize an index during queries or status checks', async () => {
    const { engine, sdk } = fixture(false);
    await expect(engine.call('/repo', 'codegraph_search', { query: 'parse' })).rejects.toThrow(/not initialized/i);
    expect(await engine.status('/repo')).toMatchObject({ indexed: false, connected: false });
    expect(sdk.CodeGraph.init).not.toHaveBeenCalled();
    expect(sdk.CodeGraph.open).not.toHaveBeenCalled();
  });

  it('shares one instance across queries and reports real statistics', async () => {
    const { engine, sdk, graph } = fixture();
    await Promise.all([engine.call('/repo', 'codegraph_search', { query: 'a' }), engine.call('/repo', 'codegraph_search', { query: 'b' })]);
    expect(sdk.CodeGraph.open).toHaveBeenCalledTimes(1);
    expect(await engine.status('/repo')).toMatchObject({ connected: true, indexed: true, state: 'indexed', files: 2, nodes: 5, edges: 6, sdkVersion: '1.6.2' });
    expect(graph.watch).not.toHaveBeenCalled();
  });

  it('uses init without implicit indexing, then an abortable full index', async () => {
    const { engine, sdk, graph } = fixture(false);
    await engine.runSync('job', '/repo');
    expect(sdk.CodeGraph.init).toHaveBeenCalledWith(expect.any(String), { index: false });
    expect(graph.indexAll).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
    expect(graph.sync).not.toHaveBeenCalled();
  });

  it('rejects simultaneous writes and reads of a workspace being indexed', async () => {
    const { engine, graph } = fixture();
    const pending = deferred<{ filesAdded: number }>();
    graph.sync.mockImplementationOnce(() => pending.promise as never);
    const running = engine.runSync('one', '/repo');
    await vi.waitFor(() => expect(graph.sync).toHaveBeenCalled());
    await expect(engine.runSync('two', '/repo')).rejects.toThrow(/busy/i);
    await expect(engine.call('/repo', 'codegraph_search', { query: 'parse' })).rejects.toThrow(/busy/i);
    expect(await engine.status('/repo')).toMatchObject({ state: 'indexing' });
    pending.resolve({ filesAdded: 1 });
    await running;
  });

  it('waits for an already-started query before mutating its graph', async () => {
    const { engine, graph } = fixture();
    const pending = deferred<Awaited<ReturnType<typeof executeCodeGraphTool>>>();
    vi.mocked(executeCodeGraphTool).mockImplementationOnce(() => pending.promise);
    const reading = engine.call('/repo', 'codegraph_search', { query: 'parse' });
    await vi.waitFor(() => expect(executeCodeGraphTool).toHaveBeenCalled());
    const writing = engine.runSync('write', '/repo');
    await Promise.resolve();
    expect(graph.sync).not.toHaveBeenCalled();
    pending.resolve({ content: [], isError: false, structuredContent: { schemaVersion: 1, rows: [], nodes: [], edges: [] } });
    await Promise.all([reading, writing]);
    expect(graph.sync).toHaveBeenCalledTimes(1);
  });

  it('requests cancellation without closing an active SDK operation', async () => {
    const { engine, graph } = fixture();
    const pending = deferred<{ filesAdded: number }>();
    graph.sync.mockImplementationOnce(() => pending.promise as never);
    const running = engine.runSync('job', '/repo').catch((error: Error) => error);
    await vi.waitFor(() => expect(graph.sync).toHaveBeenCalled());
    await engine.cancelSync('job');
    const options = graph.sync.mock.calls[0][0] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    expect(graph.close).not.toHaveBeenCalled();
    pending.resolve({ filesAdded: 1 });
    expect(await running).toMatchObject({ message: expect.stringMatching(/cancelled/i) });
    expect(graph.close).not.toHaveBeenCalled();
  });

  it('waits for cancelled writes before closing SQLite during shutdown', async () => {
    const { engine, graph } = fixture();
    const pending = deferred<{ filesAdded: number }>();
    graph.sync.mockImplementationOnce(() => pending.promise as never);
    const running = engine.runSync('job', '/repo').catch(() => {});
    await vi.waitFor(() => expect(graph.sync).toHaveBeenCalled());
    const closing = engine.close();
    expect(graph.close).not.toHaveBeenCalled();
    await expect(engine.call('/repo', 'codegraph_search', { query: 'a' })).rejects.toThrow(/closed/i);
    pending.resolve({ filesAdded: 0 });
    await Promise.all([running, closing]);
    expect(graph.close).toHaveBeenCalledTimes(1);
    await engine.close();
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  it('rejects unsuccessful full indexes and never reports them as complete', async () => {
    const { engine, graph } = fixture(false);
    graph.indexAll.mockResolvedValueOnce({ success: false, errors: [{ message: 'index lock unavailable' }] } as never);
    await expect(engine.runSync('job', '/repo')).rejects.toThrow(/index lock unavailable/);
  });

  it('validates operations before opening a graph', async () => {
    const { engine, sdk } = fixture();
    await expect(engine.call('/repo', 'codegraph_sync' as never, {})).rejects.toThrow(/tool/i);
    await expect(engine.call('/repo', 'codegraph_node', { file: '../outside' })).rejects.toThrow(/file/i);
    expect(sdk.CodeGraph.open).not.toHaveBeenCalled();
  });

  it('plans uninitialized / full / incremental with the same rule runSync uses', async () => {
    const fresh = fixture(false);
    await expect(fresh.engine.plan('/repo')).resolves.toBe('uninitialized');
    expect(fresh.sdk.CodeGraph.open).not.toHaveBeenCalled();
    const { engine, graph } = fixture();
    await expect(engine.plan('/repo')).resolves.toBe('incremental');
    graph.isIndexStale.mockReturnValueOnce(true);
    await expect(engine.plan('/repo')).resolves.toBe('full');
    graph.getIndexState.mockReturnValueOnce(null as never);
    await expect(engine.plan('/repo')).resolves.toBe('full');
  });

  it('an explicit incremental run syncs only the given paths, even when the index would otherwise be rebuilt', async () => {
    const { engine, graph } = fixture();
    graph.isIndexStale.mockReturnValue(true);
    graph.sync.mockResolvedValueOnce({ filesAdded: 1, filesModified: 2, filesRemoved: 0 });
    await expect(engine.runSync('job', '/repo', undefined, { mode: 'incremental', paths: ['src/a.ts'] })).resolves.toEqual({ mode: 'incremental', filesChanged: 3 });
    expect(graph.sync).toHaveBeenCalledWith(expect.objectContaining({ paths: ['src/a.ts'], signal: expect.any(AbortSignal) }));
    expect(graph.indexAll).not.toHaveBeenCalled();
    await engine.runSync('whole', '/repo', undefined, { mode: 'incremental' });
    expect(graph.sync.mock.calls[1][0]).not.toHaveProperty('paths');
  });

  it('an explicit incremental run never creates an index', async () => {
    const { engine, sdk } = fixture(false);
    await expect(engine.runSync('job', '/repo', undefined, { mode: 'incremental' })).rejects.toThrow(/not initialized/i);
    expect(sdk.CodeGraph.init).not.toHaveBeenCalled();
  });

  it('reports a full index that could not take codegraph.lock as LockUnavailableError', async () => {
    const { engine, graph } = fixture(false);
    graph.indexAll.mockResolvedValueOnce({ success: false, errors: [{ message: 'Could not acquire file lock - another process may be indexing' }] } as never);
    await expect(engine.runSync('job', '/repo')).rejects.toMatchObject({ name: 'LockUnavailableError' });
  });

  it('refresh hands later reads a new connection and closes the old one once its in-flight reads finish', async () => {
    const { engine, sdk, graph } = fixture();
    const second = { ...graph, close: vi.fn() };
    sdk.CodeGraph.open.mockResolvedValueOnce(graph).mockResolvedValueOnce(second);
    const pending = deferred<Awaited<ReturnType<typeof executeCodeGraphTool>>>();
    vi.mocked(executeCodeGraphTool).mockImplementationOnce(() => pending.promise);
    const reading = engine.call('/repo', 'codegraph_search', { query: 'old' });
    await vi.waitFor(() => expect(executeCodeGraphTool).toHaveBeenCalledTimes(1));
    await engine.refresh('/repo');
    // 新读不等旧读，也不用旧连接
    await engine.call('/repo', 'codegraph_search', { query: 'new' });
    expect(vi.mocked(executeCodeGraphTool).mock.calls[1][0]).toBe(second);
    expect(graph.close).not.toHaveBeenCalled();
    pending.resolve({ content: [], isError: false, structuredContent: { schemaVersion: 1, rows: [], nodes: [], edges: [] } });
    await reading;
    await vi.waitFor(() => expect(graph.close).toHaveBeenCalledOnce());
    expect(second.close).not.toHaveBeenCalled();
  });

  it('watch wires the SDK FileWatcher as an event source only and keeps the graph open while watching', async () => {
    const { sdk, graph } = fixture();
    const instances: Array<{ root: string; syncFn: (paths?: string[]) => Promise<unknown>; options: Record<string, unknown>; guard?: (path: string) => boolean; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    class FakeWatcher {
      start = vi.fn(() => true); stop = vi.fn();
      constructor(root: string, syncFn: (paths?: string[]) => Promise<unknown>, options: Record<string, unknown>, guard?: (path: string) => boolean) { instances.push({ root, syncFn, options, guard, start: this.start, stop: this.stop }); }
    }
    const engine = new CodeGraphEngine({ loadSdk: async () => ({ ...sdk, FileWatcher: FakeWatcher }) as unknown as CodeGraphSdk, idleTimeoutMs: 5 });
    engines.push(engine);
    const changes: Array<string[] | null> = [];
    const degraded: string[] = [];
    await expect(engine.watch('/repo', { debounceMs: 750, onChange: (paths) => changes.push(paths), onDegraded: (reason) => degraded.push(reason) })).resolves.toEqual({ active: true });
    await expect(engine.watch('/repo', { debounceMs: 750, onChange: () => {}, onDegraded: () => {} })).resolves.toEqual({ active: true });
    expect(instances).toHaveLength(1);
    expect(instances[0].options).toMatchObject({ debounceMs: 750 });
    // syncFn 不同步，只上报改动并立刻返回
    await expect(instances[0].syncFn(['src/a.ts'])).resolves.toEqual({ filesChanged: 1, durationMs: 0 });
    await instances[0].syncFn(undefined);
    expect(changes).toEqual([['src/a.ts'], null]);
    expect(graph.sync).not.toHaveBeenCalled();
    (instances[0].options.onDegraded as (reason: string) => void)('EMFILE');
    expect(degraded).toEqual(['EMFILE']);
    if (process.platform === 'win32') expect(instances[0].guard).toEqual(expect.any(Function));
    // 挂着监听时不随空闲关闭
    await engine.call('/repo', 'codegraph_search', { query: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(graph.close).not.toHaveBeenCalled();
    await engine.unwatch('/repo');
    expect(instances[0].stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(graph.close).toHaveBeenCalledOnce());
  });

  it('reports a watcher the platform refuses to start, and close stops active watchers', async () => {
    const { sdk } = fixture();
    let allow = false;
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    class FakeWatcher { stop = vi.fn(); start = vi.fn(() => allow); constructor() { stops.push(this.stop); } }
    const engine = new CodeGraphEngine({ loadSdk: async () => ({ ...sdk, FileWatcher: FakeWatcher }) as unknown as CodeGraphSdk });
    const handlers = { debounceMs: 1, onChange: () => {}, onDegraded: () => {} };
    await expect(engine.watch('/repo', handlers)).resolves.toMatchObject({ active: false, reason: expect.stringContaining('不支持') });
    allow = true;
    await expect(engine.watch('/repo', handlers)).resolves.toEqual({ active: true });
    await engine.close();
    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it('allows retry after an SDK load failure without falling back to a CLI', async () => {
    const { sdk } = fixture();
    const loadSdk = vi.fn().mockRejectedValueOnce(new Error('missing platform package')).mockResolvedValue(sdk);
    const engine = new CodeGraphEngine({ loadSdk }); engines.push(engine);
    expect(await engine.status('/repo')).toMatchObject({ connected: false, sdkAvailable: false, state: 'sdk_unavailable' });
    expect(await engine.status('/repo')).toMatchObject({ connected: true, sdkAvailable: true });
  });
});
