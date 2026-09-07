import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TencentDbRuntime, parentGuardImport, type RuntimeSpawn } from './runtime';

function layout() {
  return {
    root: 'C:/runtime',
    node: () => 'node',
    knowledgeEntry: () => 'C:/runtime/knowledge/bin/server.mjs',
    coreConfig: () => 'C:/runtime/core/config.json',
    assertCoreReady: () => {},
  } as never;
}

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('close', 0);
    return true;
  });
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child;
}

function fakeRegistry() {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    pids: vi.fn(() => []),
    killTree: vi.fn().mockResolvedValue(undefined),
    killAll: vi.fn().mockResolvedValue(undefined),
  };
}

async function startRuntime(children: ReturnType<typeof fakeChild>[], registry = fakeRegistry()) {
  const calls: Array<{ args: string[]; options: Parameters<RuntimeSpawn>[2] }> = [];
  let index = 0;
  const spawnImpl = vi.fn((_command: string, args: string[], options: Parameters<RuntimeSpawn>[2]) => {
    calls.push({ args, options });
    return children[index++] as never;
  });
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: registry as never, killTimeoutMs: 50 });
  const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));
  const status = await runtime.startLocal({ dataDir, gatewayApiKey: 'secret' });
  return { runtime, status, calls, registry, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TencentDbRuntime', () => {
  it('encodes the parent-guard watchdog as a data URL import', () => {
    const url = parentGuardImport();
    expect(url.startsWith('data:text/javascript;base64,')).toBe(true);
    const source = Buffer.from(url.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8');
    expect(source).toContain('process.stdin.resume()');
    expect(source).toContain('process.stdin.on("end"');
    expect(source).toContain('process.exit(0)');
  });

  it('spawns gateway and knowledge with piped stdin, watchdog import and registry entries', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    const { calls, registry, fetchImpl } = await startRuntime(children);
    expect(calls[0].args).toEqual(['--import', parentGuardImport(), '--import', 'tsx', 'src/gateway/server.ts']);
    expect(calls[1].args).toEqual(['--import', parentGuardImport(), 'C:/runtime/knowledge/bin/server.mjs']);
    for (const call of calls) {
      expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(call.options.detached).toBe(process.platform !== 'win32');
    }
    expect(registry.register).toHaveBeenCalledWith(children[0], 'tencentdb:core');
    expect(registry.register).toHaveBeenCalledWith(children[1], 'tencentdb:knowledge');
    expect(calls[1].options.env.KNOWLEDGE_API_TOKEN).toBe('secret');
    expect(fetchImpl.mock.calls.some(([url]) => typeof url === 'string' && url.endsWith('/health'))).toBe(true);
  });

  it('stops gracefully through stdin EOF without killTree', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    const { runtime, registry } = await startRuntime(children);
    await runtime.stop();
    expect(registry.killTree).not.toHaveBeenCalled();
    expect(runtime.getState()).toBe('stopped');
  });

  it('shares one startup when callers race during warmup', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    let childIndex = 0;
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: Parameters<RuntimeSpawn>[2]) => children[childIndex++] as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: fakeRegistry() as never });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));
    await Promise.all([
      runtime.startLocal({ dataDir, gatewayApiKey: 'secret' }),
      runtime.startLocal({ dataDir, gatewayApiKey: 'secret' }),
    ]);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it('cancels startup when stopped before health checks complete', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    let childIndex = 0;
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: Parameters<RuntimeSpawn>[2]) => children[childIndex++] as never);
    let releaseHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => health));
    const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: fakeRegistry() as never, killTimeoutMs: 50 });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));
    const starting = runtime.startLocal({ dataDir, gatewayApiKey: 'secret' });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2));

    const stopping = runtime.stop();
    releaseHealth(new Response('', { status: 200 }));

    await stopping;
    await expect(starting).rejects.toThrow('TencentDB runtime startup cancelled');
    expect(runtime.getState()).toBe('stopped');
    expect(children.every((child) => child.exitCode === 0)).toBe(true);
  });

  it('cleans up the first child when the second child cannot spawn', async () => {
    const core = fakeChild(101);
    const registry = fakeRegistry();
    let calls = 0;
    const spawnImpl = vi.fn(() => {
      calls += 1;
      if (calls === 1) return core as never;
      throw new Error('knowledge spawn failed');
    });
    const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: registry as never });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));

    await expect(runtime.startLocal({ dataDir, gatewayApiKey: 'secret' })).rejects.toThrow('knowledge spawn failed');
    expect(core.exitCode).toBe(0);
    expect(runtime.getState()).toBe('failed');
  });

  it('turns a child spawn error event into a startup failure', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    let childIndex = 0;
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: Parameters<RuntimeSpawn>[2]) => children[childIndex++] as never);
    let releaseHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => health));
    const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: fakeRegistry() as never });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));
    const starting = runtime.startLocal({ dataDir, gatewayApiKey: 'secret' });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2));

    children[0].emit('error', new Error('core spawn failed'));
    releaseHealth(new Response('', { status: 200 }));

    await expect(starting).rejects.toThrow('core spawn failed');
    expect(runtime.getState()).toBe('failed');
  });

  it('does not mark an exited child ready after health checks succeed', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    let childIndex = 0;
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: Parameters<RuntimeSpawn>[2]) => children[childIndex++] as never);
    let healthCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      healthCalls += 1;
      if (healthCalls === 2) {
        children[0].exitCode = 1;
        children[0].emit('close', 1);
      }
      return new Response('', { status: 200 });
    }));
    const runtime = new TencentDbRuntime(layout(), { spawnImpl: spawnImpl as never, registry: fakeRegistry() as never });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));

    await expect(runtime.startLocal({ dataDir, gatewayApiKey: 'secret' })).rejects.toThrow(/core exited|startup/);
    expect(runtime.getState()).toBe('failed');
  });

  it('escalates to killTree when a child ignores stdin EOF on stop', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    const { runtime, registry } = await startRuntime(children);
    children[0].stdin.removeAllListeners('finish');
    await runtime.stop();
    expect(registry.killTree).toHaveBeenCalledWith(101);
    expect(registry.killTree).not.toHaveBeenCalledWith(102);
  });

  it('marks the runtime failed and stops the sibling when a child exits unexpectedly', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    const { runtime, status } = await startRuntime(children);
    expect(status.state).toBe('ready');
    children[0].exitCode = 1;
    children[0].emit('close', 1);
    await vi.waitFor(() => expect(runtime.getState()).toBe('failed'));
    await vi.waitFor(() => expect(children[1].exitCode).toBe(0));
  });

  it('surfaces a child startup error together with its stderr', async () => {
    const children = [fakeChild(101), fakeChild(102)];
    let childIndex = 0;
    const spawnImpl = vi.fn((_command: string, _args: string[], _options: Parameters<RuntimeSpawn>[2]) => {
      return children[childIndex++] as never;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed');
    }));
    const runtime = new TencentDbRuntime(layout(), {
      spawnImpl: spawnImpl as never,
      registry: fakeRegistry() as never,
      killTimeoutMs: 50,
    });
    const dataDir = await mkdtemp(join(tmpdir(), 'tencentdb-runtime-test-'));
    const starting = runtime.startLocal({ dataDir, gatewayApiKey: 'secret' });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2));
    children[1].stderr.emit('data', 'KNOWLEDGE_API_TOKEN is required\n');
    children[1].exitCode = 1;
    children[1].emit('close', 1);
    await expect(starting).rejects.toThrow(/KNOWLEDGE_API_TOKEN is required/);
  });
});
