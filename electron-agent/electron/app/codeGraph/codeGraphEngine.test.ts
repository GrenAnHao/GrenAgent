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

  it('allows retry after an SDK load failure without falling back to a CLI', async () => {
    const { sdk } = fixture();
    const loadSdk = vi.fn().mockRejectedValueOnce(new Error('missing platform package')).mockResolvedValue(sdk);
    const engine = new CodeGraphEngine({ loadSdk }); engines.push(engine);
    expect(await engine.status('/repo')).toMatchObject({ connected: false, sdkAvailable: false, state: 'sdk_unavailable' });
    expect(await engine.status('/repo')).toMatchObject({ connected: true, sdkAvailable: true });
  });
});
