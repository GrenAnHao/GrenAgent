import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AgentProcessClient, type AgentChild, type AgentProcessExit, type ProcessTreeGuard, type SpawnAgentChild } from './agentProcessClient.js';
import { RpcPeer, type MethodHandler, type WireMessage } from './rpcPeer.js';

/** 模拟 agent-host：消息走 structuredClone，和 IPC advanced 序列化一致。 */
class FakeChild extends EventEmitter implements AgentChild {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  connected = true;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly host: RpcPeer;
  killed: NodeJS.Signals[] = [];

  constructor(methods: Record<string, MethodHandler>, private readonly autoReady = true) {
    super();
    this.host = new RpcPeer({ send: (message) => queueMicrotask(() => this.emit('message', structuredClone(message))) });
    this.host.handleAll(methods);
    if (autoReady) queueMicrotask(() => this.host.emit('host.ready', { pid: this.pid }));
  }

  send(message: WireMessage, callback: (error: Error | null) => void): boolean {
    queueMicrotask(() => { this.host.receive(structuredClone(message)); callback(null); });
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null, closeAfterMs = 0): void {
    if (!this.connected) return;
    this.connected = false;
    queueMicrotask(() => {
      this.emit('exit', code, signal);
      // 和真实子进程一样：stdio 读完后才有 close
      setTimeout(() => this.emit('close', code, signal), closeAfterMs);
    });
  }
}

function setup(over: {
  methods?: (child: FakeChild) => Record<string, MethodHandler>;
  hostMethods?: Record<string, MethodHandler>;
  autoReady?: boolean;
  now?: () => number;
  killTree?: (pid: number) => Promise<void>;
  shutdownTimeoutMs?: number;
  readyTimeoutMs?: number;
  guard?: (pid: number) => Promise<ProcessTreeGuard | undefined>;
} = {}) {
  const children: FakeChild[] = [];
  const events: Array<[string, unknown]> = [];
  const exits: AgentProcessExit[] = [];
  const sweeps: Array<[string, boolean]> = [];
  const logs: string[] = [];
  const spawn = vi.fn<SpawnAgentChild>(() => {
    let child!: FakeChild;
    const methods: Record<string, MethodHandler> = {
      'host.shutdown': () => { queueMicrotask(() => child.exit(0)); return null; },
    };
    child = new FakeChild(methods, over.autoReady ?? true);
    child.host.handleAll(over.methods?.(child) ?? {});
    children.push(child);
    return child;
  });
  const client = new AgentProcessClient({
    entry: 'agent-host.js',
    execPath: 'electron.exe',
    env: { A: '1' },
    nodeArgs: ['--trace-warnings'],
    hostMethods: over.hostMethods ?? {},
    onEvent: (channel, payload) => events.push([channel, payload]),
    onExit: (exit) => exits.push(exit),
    spawn,
    log: (stream, line) => logs.push(`${stream}:${line}`),
    ...(over.now ? { now: over.now } : {}),
    ...(over.killTree ? { killTree: over.killTree } : {}),
    ...(over.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: over.shutdownTimeoutMs } : {}),
    ...(over.readyTimeoutMs !== undefined ? { readyTimeoutMs: over.readyTimeoutMs } : {}),
    ...(over.guard ? { guard: over.guard, onSweep: (summary: string, exit: AgentProcessExit) => sweeps.push([summary, exit.expected]) } : {}),
  });
  return { client, spawn, children, events, exits, sweeps, logs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AgentProcessClient', () => {
  it('第一条请求时拉起子进程，等 host.ready 后再转发', async () => {
    const { client, spawn } = setup({ methods: () => ({ 'pi.send': (p) => ({ echoed: p.command }) }) });
    await expect(client.request('pi.send', { command: 'agent_get_state' })).resolves.toEqual({ echoed: 'agent_get_state' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe('electron.exe');
    expect(args).toEqual(['--trace-warnings', 'agent-host.js']);
    expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true, env: { A: '1' } });
  });

  it('子进程能反过来请求主进程', async () => {
    const { client } = setup({
      hostMethods: { 'host.resolveWorkspace': (p) => `real:${String(p.path)}` },
      methods: (child) => ({ 'pi.open': (p) => child.host.request('host.resolveWorkspace', { path: p.workspace }) }),
    });
    await expect(client.request('pi.open', { workspace: 'D:/p' })).resolves.toBe('real:D:/p');
  });

  it('子进程事件交给 onEvent，host.ready 不外传', async () => {
    const { client, children, events } = setup();
    await client.start();
    children[0]!.host.emit('broadcast', { channel: 'pi://event', payload: { x: 1 } });
    await tick();
    expect(events).toEqual([['broadcast', { channel: 'pi://event', payload: { x: 1 } }]]);
  });

  it('并发请求只拉起一次', async () => {
    const { client, spawn } = setup({ methods: () => ({ ping: () => 'pong' }) });
    await Promise.all([client.request('ping'), client.request('ping'), client.start()]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('意外退出：在途请求失败、报告退出原因，下一条请求重新拉起', async () => {
    const never = new Promise(() => {});
    const { client, spawn, children, exits } = setup({ methods: () => ({ slow: () => never, ping: () => 'pong' }) });
    await client.start();
    const inflight = client.request('slow');
    await tick();
    children[0]!.stderr.write('TypeError: boom\n');
    await tick();
    children[0]!.exit(1);
    await expect(inflight).rejects.toThrow(/AGENT_HOST_EXITED: code=1 .*TypeError: boom/);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: 1, expected: false });
    expect(exits[0]!.stderrTail).toContain('TypeError: boom');
    expect(client.isRunning).toBe(false);
    await expect(client.request('ping')).resolves.toBe('pong');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('exit 之后、close 之前到达的 stderr 也进得了尾巴', async () => {
    const { client, children, exits } = setup();
    await client.start();
    const child = children[0]!;
    child.connected = false;
    child.emit('exit', 134, null);
    child.stderr.write('FATAL ERROR: Reached heap limit\n');
    await tick();
    child.emit('close', 134, null);
    await tick();
    expect(exits[0]!.stderrTail).toContain('Reached heap limit');
  });

  it('孙进程占着 stderr、close 迟迟不来时，exit 之后照样很快结算', async () => {
    const { client, children, exits } = setup();
    await client.start();
    children[0]!.exit(1, null, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toHaveLength(1);
    expect(client.isRunning).toBe(false);
  });

  it('重新拉起后，退出信息里不带上一个子进程的 stderr', async () => {
    const { client, children, exits } = setup();
    await client.start();
    children[0]!.stderr.write('old crash\n');
    await tick();
    children[0]!.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.start();
    children[1]!.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits[0]!.stderrTail).toContain('old crash');
    expect(exits[1]!.stderrTail).not.toContain('old crash');
  });

  it('已经起来的子进程上的 error 不当作退出', async () => {
    const { client, children, exits } = setup({ methods: () => ({ ping: () => 'pong' }) });
    await client.start();
    children[0]!.emit('error', new Error('kill EPERM'));
    await tick();
    expect(exits).toHaveLength(0);
    await expect(client.request('ping')).resolves.toBe('pong');
  });

  it('host.fatal 的原因写进退出信息和失败消息', async () => {
    const never = new Promise(() => {});
    const { client, children, exits } = setup({ methods: () => ({ slow: () => never }) });
    await client.start();
    const inflight = client.request('slow');
    children[0]!.host.emit('host.fatal', { message: 'cannot load extensions' });
    await tick();
    children[0]!.exit(1);
    await expect(inflight).rejects.toThrow('cannot load extensions');
    expect(exits[0]!.fatal).toBe('cannot load extensions');
  });

  it('60 秒内崩 3 次就暂停拉起，冷却后恢复', async () => {
    let now = 0;
    const { client, spawn, children } = setup({ now: () => now, methods: () => ({ ping: () => 'pong' }) });
    for (let i = 0; i < 3; i += 1) {
      await client.start();
      children[i]!.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      now += 1_000;
    }
    await expect(client.request('ping')).rejects.toThrow('AGENT_HOST_CRASH_LOOP');
    expect(spawn).toHaveBeenCalledTimes(3);
    now += 30_000;
    await expect(client.request('ping')).resolves.toBe('pong');
  });

  it('关停：子进程自己收尾退出，不杀进程；之后不再拉起', async () => {
    const killTree = vi.fn(async () => {});
    const { client, exits, spawn } = setup({ killTree });
    await client.start();
    await client.shutdown();
    expect(killTree).not.toHaveBeenCalled();
    expect(exits).toEqual([expect.objectContaining({ code: 0, expected: true })]);
    await expect(client.request('ping')).rejects.toThrow('AGENT_HOST_STOPPED');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('关停超时就整树杀掉', async () => {
    const children: FakeChild[] = [];
    const killTree = vi.fn(async (pid: number) => { children.find((c) => c.pid === pid)?.exit(null, 'SIGKILL'); });
    const stuck = setup({
      shutdownTimeoutMs: 20,
      killTree,
      methods: () => ({ 'host.shutdown': () => new Promise(() => {}) }),
    });
    await stuck.client.start();
    children.push(...stuck.children);
    await stuck.client.shutdown();
    expect(killTree).toHaveBeenCalledWith(stuck.children[0]!.pid);
    expect(stuck.exits[0]).toMatchObject({ expected: true, signal: 'SIGKILL' });
  });

  it('没有拉起过就关停，直接返回', async () => {
    const { client, spawn } = setup();
    await client.shutdown();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('迟迟不就绪时超时失败并杀掉子进程', async () => {
    const { client, children } = setup({ autoReady: false, readyTimeoutMs: 20 });
    await expect(client.start()).rejects.toThrow(/AGENT_HOST_READY_TIMEOUT|AGENT_HOST_EXITED/);
    expect(children[0]!.killed).toContain('SIGKILL');
  });

  it('spawn 本身抛错时请求失败，不留下半个状态', async () => {
    const client = new AgentProcessClient({
      entry: 'x.js', execPath: 'missing.exe', env: {}, hostMethods: {}, onEvent: () => {},
      spawn: () => { throw new Error('spawn ENOENT'); },
    });
    await expect(client.request('ping')).rejects.toThrow('spawn ENOENT');
    expect(client.isRunning).toBe(false);
  });

  describe('进程树守卫', () => {
    function guardSpy(summary = 'swept 3 kept 0') {
      const pids: number[] = [];
      const release = vi.fn(async () => summary);
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const guard = vi.fn(async (pid: number) => { pids.push(pid); await gate; return { release }; });
      return { guard, release, pids, unblock };
    }

    it('拉起后用子进程 pid 建守卫，守卫就位前不算就绪', async () => {
      const spy = guardSpy();
      const { client, children } = setup({ guard: spy.guard });
      let ready = false;
      const starting = client.start().then(() => { ready = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spy.pids).toEqual([children[0]!.pid]);
      expect(ready).toBe(false);
      spy.unblock();
      await starting;
      expect(ready).toBe(true);
    });

    it('崩溃后 release，清理结果交给 onSweep', async () => {
      const spy = guardSpy('swept 4 kept 1');
      spy.unblock();
      const { client, children, sweeps } = setup({ guard: spy.guard });
      await client.start();
      children[0]!.exit(1);
      await vi.waitFor(() => expect(sweeps).toEqual([['swept 4 kept 1', false]]));
      expect(spy.release).toHaveBeenCalledTimes(1);
    });

    it('关停要等守卫清理完', async () => {
      let finishSweep!: () => void;
      const release = vi.fn(() => new Promise<string>((resolve) => { finishSweep = () => resolve('swept 1 kept 0'); }));
      const { client, sweeps } = setup({ guard: async () => ({ release }) });
      await client.start();
      let done = false;
      const stopping = client.shutdown().then(() => { done = true; });
      await vi.waitFor(() => expect(release).toHaveBeenCalled());
      expect(done).toBe(false);
      finishSweep();
      await stopping;
      expect(sweeps).toEqual([['swept 1 kept 0', true]]);
    });

    it('守卫建不起来时记一行日志，照常运行', async () => {
      const { client, logs } = setup({
        guard: async () => { throw new Error('JOB_GUARD_FAILED: error AssignProcessToJobObject 5'); },
        methods: () => ({ ping: () => 'pong' }),
      });
      await expect(client.request('ping')).resolves.toBe('pong');
      expect(logs.some((line) => line.includes('process tree guard unavailable') && line.includes('AssignProcessToJobObject'))).toBe(true);
    });
  });

  it('子进程的 stdout / stderr 按行转给日志', async () => {
    const { client, children, logs } = setup();
    await client.start();
    children[0]!.stdout.write('hello\nwor');
    children[0]!.stdout.write('ld\n');
    children[0]!.stderr.write('warn line\r\n');
    await tick();
    expect(logs).toEqual(['stdout:hello', 'stdout:world', 'stderr:warn line']);
  });
});
