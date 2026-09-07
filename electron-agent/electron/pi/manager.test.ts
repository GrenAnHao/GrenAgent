import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PiManager, piGoalWorkerKey, type PiSpawn } from './manager';

function fakeChild(pid = 4321) {
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

const command = { command: 'pi', args: ['--mode', 'rpc'] };

describe('PiManager', () => {
  it('opens a goal worker under a session key and passes the session path directly to Pi', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn((_cmd: string, _args: string[], _opts: Parameters<PiSpawn>[2]) => child as never);
    const registry = fakeRegistry();
    const onEvent = vi.fn();
    const manager = new PiManager(command, { onEvent }, { spawnImpl: spawnImpl as never, registry: registry as never });

    const client = manager.openGoalWorker('session-a', 'C:/work', 'C:/sessions/a.jsonl');

    expect(manager.get(piGoalWorkerKey('C:/work', 'session-a'))).toBe(client);
    expect(manager.get('C:/work')).toBeUndefined();
    expect(client.metadata).toMatchObject({ source: 'goal', sessionId: 'session-a' });
    expect(spawnImpl).toHaveBeenCalledWith('pi', [...command.args, '--session', 'C:/sessions/a.jsonl'], expect.any(Object));
    client.handleLine('{"type":"agent_start"}');
    expect(onEvent).toHaveBeenCalledWith('C:/work', { type: 'agent_start' }, expect.objectContaining({
      key: piGoalWorkerKey('C:/work', 'session-a'), logicalWorkspace: 'C:/work', sessionId: 'session-a', source: 'goal',
    }));
  });

  it('closes a goal worker without closing the interactive workspace worker', async () => {
    const interactive = fakeChild(4321);
    const goal = fakeChild(4322);
    const spawnImpl = vi.fn()
      .mockImplementationOnce(() => interactive as never)
      .mockImplementationOnce(() => goal as never);
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, { spawnImpl: spawnImpl as never, registry: registry as never });

    manager.open('C:/work', 'C:/work');
    manager.openGoalWorker('session-a', 'C:/work', 'C:/sessions/a.jsonl');
    await manager.closeGoalWorker('session-a', 'C:/work');

    expect(manager.get('C:/work')).toBeDefined();
    expect(manager.get(piGoalWorkerKey('C:/work', 'session-a'))).toBeUndefined();
  });

  it('keeps same-named Goal workers isolated by workspace', async () => {
    const first = fakeChild(4322);
    const second = fakeChild(4323);
    const spawnImpl = vi.fn()
      .mockImplementationOnce(() => first as never)
      .mockImplementationOnce(() => second as never);
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, { spawnImpl: spawnImpl as never, registry: registry as never });

    const firstClient = manager.openGoalWorker('same-session', 'C:/one', 'C:/sessions/one.jsonl');
    const secondClient = manager.openGoalWorker('same-session', 'C:/two', 'C:/sessions/two.jsonl');

    expect(firstClient).not.toBe(secondClient);
    expect(manager.get(piGoalWorkerKey('C:/one', 'same-session'))).toBe(firstClient);
    expect(manager.get(piGoalWorkerKey('C:/two', 'same-session'))).toBe(secondClient);
    await expect(manager.closeGoalWorker('same-session')).rejects.toThrow('AMBIGUOUS_GOAL_SESSION');
    await manager.closeGoalWorker('same-session', 'C:/one');
    expect(manager.get(piGoalWorkerKey('C:/two', 'same-session'))).toBe(secondClient);
  });

  it('removes the client from the map when the sidecar exits on its own', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const registry = fakeRegistry();
    const onExit = vi.fn();
    const manager = new PiManager(command, { onExit }, { spawnImpl: spawnImpl as never, registry: registry as never });

    manager.open('ws-a', '/work');
    expect(manager.get('ws-a')).toBeDefined();

    child.exitCode = 1;
    child.emit('close', 1);
    await vi.waitFor(() => expect(manager.get('ws-a')).toBeUndefined());
    expect(onExit).toHaveBeenCalledWith('ws-a', 1);
  });

  it('handles stdin EPIPE without an uncaught stream error', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, { spawnImpl: spawnImpl as never, registry: registry as never });

    manager.open('ws-a', '/work');
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(() => child.stdin.emit('error', error)).not.toThrow();
  });

  it('closes stdin for a graceful stop and skips killTree when the child exits', async () => {
    const child = fakeChild();
    child.stdin.once('finish', () => {
      child.exitCode = 0;
      child.emit('close', 0);
    });
    const spawnImpl = vi.fn(() => child as never);
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, { spawnImpl: spawnImpl as never, registry: registry as never });

    manager.open('ws-a', '/work');
    await manager.close('ws-a');
    expect(registry.killTree).not.toHaveBeenCalled();
    expect(manager.get('ws-a')).toBeUndefined();
  });

  it('escalates to killTree when the child ignores stdin EOF', async () => {
    const child = fakeChild(777);
    const spawnImpl = vi.fn(() => child as never);
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, {
      spawnImpl: spawnImpl as never,
      registry: registry as never,
      killTimeoutMs: 30,
    });

    manager.open('ws-a', '/work');
    await manager.close('ws-a');
    expect(registry.killTree).toHaveBeenCalledWith(777);
  });

  it('registers spawned children and detaches them into their own process group on POSIX', () => {
    const child = fakeChild();
    let options: Parameters<PiSpawn>[2] | undefined;
    const spawnImpl = vi.fn((_cmd: string, _args: string[], opts: Parameters<PiSpawn>[2]) => {
      options = opts;
      return child as never;
    });
    const registry = fakeRegistry();
    const manager = new PiManager(command, {}, { spawnImpl: spawnImpl as never, registry: registry as never });

    manager.open('ws-a', '/work', { EXTRA: '1' });
    expect(registry.register).toHaveBeenCalledWith(child, 'pi:ws-a');
    expect(options?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options?.windowsHide).toBe(true);
    expect(options?.detached).toBe(process.platform !== 'win32');
    expect(options?.env?.EXTRA).toBe('1');
  });
});
