import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PiManager, type PiSpawn } from './manager';

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
