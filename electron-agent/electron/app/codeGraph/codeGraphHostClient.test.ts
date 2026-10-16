import type { IndexProgress } from '@colbymchenry/codegraph';
import { describe, expect, it, vi } from 'vitest';
import { RpcPeer } from '../../agentProcess/rpcPeer';
import { CodeGraphHostClient, type CodeGraphHostProcess } from './codeGraphHostClient';
import { CodeGraphJobs } from './codeGraphJobs';
import { CODEGRAPH_DIAG_CHANNEL, CODEGRAPH_HOST_METHODS } from './hostContract';
import { createCodeGraphHostMethods } from './hostMethods';

type Engine = Parameters<typeof createCodeGraphHostMethods>[0];

/** 两个 RpcPeer 背靠背：真实的线协议、真实的子进程处理表，只是不起进程。 */
function wire(engine: Partial<Engine>) {
  let child!: RpcPeer;
  let running = true;
  let onEvent!: (channel: string, payload: unknown) => void;
  const main = new RpcPeer({ send: (message) => queueMicrotask(() => child.receive(structuredClone(message))) });
  child = new RpcPeer({ send: (message) => queueMicrotask(() => main.receive(structuredClone(message))) });
  main.onEvent((channel, payload) => onEvent(channel, payload));
  const tracker = { active: new Set<string>() };
  child.handleAll(createCodeGraphHostMethods(engine as Engine, (jobId, progress) => child.emit('codegraph.progress', { jobId, progress }), tracker));
  const shutdown = vi.fn(async () => { running = false; });
  const process: CodeGraphHostProcess = {
    request: (method, params = {}) => running ? main.request(method, params) : Promise.reject(new Error('AGENT_HOST_STOPPED')),
    shutdown,
    get isRunning() { return running; },
  };
  const diag = vi.fn();
  const client = new CodeGraphHostClient({
    listWorkspaces: () => ['/definitely/missing/workspace'],
    createProcess: (listener) => { onEvent = listener; return process; },
    onDiag: diag,
  });
  return { client, child, main, shutdown, diag, tracker, crash: (error: Error) => { running = false; main.close(error); } };
}

describe('CodeGraphHostClient', () => {
  it('exposes exactly the contract methods on the child side', () => {
    expect(Object.keys(createCodeGraphHostMethods({} as Engine, () => {})).sort()).toEqual([...CODEGRAPH_HOST_METHODS].sort());
  });

  it('forwards status, call and search with the same result shape', async () => {
    const result = { content: [{ type: 'text' as const, text: 'ok' }], structuredContent: { title: 't', rows: [{ symbol: 'parse', file: 'a.ts' }] } } as unknown as Awaited<ReturnType<Engine['call']>>;
    const engine = {
      status: vi.fn(async (workspace: string) => ({ workspace, connected: true, indexed: true, sdkAvailable: true, sdkVersion: '1.6.2', state: 'indexed' as const })),
      call: vi.fn(async () => result),
      search: vi.fn(async (workspace: string) => ({ workspace, available: true, results: [{ symbol: 'parse', file: 'a.ts' }] })),
    };
    const { client } = wire(engine);
    await expect(client.status('/w')).resolves.toMatchObject({ workspace: '/w', state: 'indexed' });
    await expect(client.call('/w', 'codegraph_search', { query: 'parse' })).resolves.toEqual(result);
    expect(engine.call).toHaveBeenCalledWith('/w', 'codegraph_search', { query: 'parse' });
    await expect(client.search('/w', 'parse', 5)).resolves.toMatchObject({ available: true });
    expect(engine.search).toHaveBeenCalledWith('/w', 'parse', 5);
  });

  it('keeps engine error messages intact across the process boundary', async () => {
    const { client } = wire({ call: vi.fn(async () => { throw new Error('CodeGraph workspace is busy indexing'); }) });
    await expect(client.call('/w', 'codegraph_search', { query: 'x' })).rejects.toThrow('CodeGraph workspace is busy indexing');
  });

  it('search never throws, even when the child is gone', async () => {
    const { client, crash } = wire({});
    crash(new Error('AGENT_HOST_EXITED: code=1'));
    await expect(client.search('/w', 'x', 5)).resolves.toEqual({ workspace: '/w', available: false, results: [], message: 'AGENT_HOST_STOPPED' });
  });

  it('streams progress to the caller of runSync and stops routing it afterwards', async () => {
    let emit!: (progress: IndexProgress) => void;
    let finish!: () => void;
    const engine = {
      runSync: vi.fn((_id: string, _ws: string, onProgress?: (p: IndexProgress) => void) => {
        emit = onProgress!;
        return new Promise<void>((resolve) => { finish = resolve; });
      }),
    };
    const { client, tracker } = wire(engine);
    const seen: IndexProgress[] = [];
    const run = client.runSync('job-1', '/w', (p) => seen.push(p));
    await vi.waitFor(() => expect(engine.runSync).toHaveBeenCalled());
    expect(tracker.active.has('job-1')).toBe(true);
    emit({ phase: 'parsing', current: 3, total: 10 } as IndexProgress);
    await vi.waitFor(() => expect(seen).toEqual([{ phase: 'parsing', current: 3, total: 10 }]));
    finish();
    await run;
    expect(tracker.active.size).toBe(0);
    emit({ phase: 'parsing', current: 4, total: 10 } as IndexProgress);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
  });

  it('cancelSync reaches the child while it runs and is a no-op once it is gone', async () => {
    const engine = { cancelSync: vi.fn(async () => {}) };
    const { client, crash } = wire(engine);
    await client.cancelSync('job-1');
    expect(engine.cancelSync).toHaveBeenCalledWith('job-1');
    crash(new Error('gone'));
    await expect(client.cancelSync('job-2')).resolves.toBeUndefined();
    expect(engine.cancelSync).toHaveBeenCalledTimes(1);
  });

  it('a child crash during sync fails the job instead of leaving it running', async () => {
    const engine = { runSync: vi.fn(() => new Promise<void>(() => {})) };
    const { client, crash } = wire(engine);
    const callbacks = { start: vi.fn(async () => {}), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}), cancelled: vi.fn(async () => {}), stage: vi.fn() };
    const jobs = new CodeGraphJobs(client, callbacks);
    const run = jobs.run('job-1', '/w');
    await vi.waitFor(() => expect(engine.runSync).toHaveBeenCalled());
    crash(new Error('AGENT_HOST_EXITED: code=null signal=SIGKILL'));
    await run;
    expect(callbacks.fail).toHaveBeenCalledWith('job-1', 'AGENT_HOST_EXITED: code=null signal=SIGKILL');
    expect(callbacks.complete).not.toHaveBeenCalled();
  });

  it('forwards diagnostics and refuses work after close', async () => {
    const { client, child, shutdown, diag } = wire({});
    child.emit(CODEGRAPH_DIAG_CHANNEL, { memory: { rss: 1 }, lag: { maxMs: 5 }, syncing: 0 });
    await vi.waitFor(() => expect(diag).toHaveBeenCalledWith({ memory: { rss: 1 }, lag: { maxMs: 5 }, syncing: 0 }));
    await client.close();
    await client.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(client.status('/w')).rejects.toThrow('CodeGraph engine is closed');
    await expect(client.runSync('j', '/w')).rejects.toThrow('CodeGraph engine is closed');
  });

  it('probes projects in the main process without touching the child', () => {
    const { client } = wire({});
    expect(client.projects()).toEqual([{ workspace: '/definitely/missing/workspace', indexed: false }]);
  });
});
