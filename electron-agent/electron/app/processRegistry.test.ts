import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry, type ProcessSignal } from './processRegistry';

class FakeChild extends EventEmitter {
  constructor(public pid?: number) {
    super();
  }
}

describe('ProcessRegistry', () => {
  it('registers a child and unregisters it on close', () => {
    const registry = new ProcessRegistry({ platform: 'win32', execFileImpl: vi.fn() });
    const child = new FakeChild(77);
    registry.register(child, 'pi:workspace');
    expect(registry.pids()).toEqual([{ pid: 77, label: 'pi:workspace' }]);
    child.emit('close');
    expect(registry.pids()).toEqual([]);
  });

  it('ignores children without a pid', () => {
    const registry = new ProcessRegistry({ platform: 'win32', execFileImpl: vi.fn() });
    registry.register(new FakeChild(undefined), 'broken');
    expect(registry.pids()).toEqual([]);
  });

  it('kills the process tree with taskkill on win32 and swallows failures', async () => {
    const execFileImpl = vi.fn().mockRejectedValue(new Error('not found'));
    const registry = new ProcessRegistry({ platform: 'win32', execFileImpl });
    await expect(registry.killTree(4242)).resolves.toBeUndefined();
    expect(execFileImpl).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F']);
  });

  it('propagates strict Windows kill failures and retains the live entry for retry', async () => {
    const failure = new Error('fixture access denied');
    const execFileImpl = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const registry = new ProcessRegistry({ platform: 'win32', execFileImpl });
    registry.register(new FakeChild(4242), 'fixture');
    await expect(registry.killTree(4242, { strict: true })).rejects.toBe(failure);
    expect(registry.pids()).toEqual([{ pid: 4242, label: 'fixture' }]);
    await expect(registry.killTree(4242, { strict: true })).resolves.toBeUndefined();
    expect(registry.pids()).toEqual([]);
  });

  it('rejects a strict POSIX cancellation if no signal can be delivered to the still-live process', async () => {
    const registry = new ProcessRegistry({ platform: 'linux', escalationDelayMs: 0, signalProcess: (_pid, signal) => signal === 0 });
    registry.register(new FakeChild(4242), 'fixture');
    await expect(registry.killTree(4242, { strict: true })).rejects.toThrow('process tree cancellation failed');
    expect(registry.pids()).toEqual([{ pid: 4242, label: 'fixture' }]);
  });

  it('terminates the process group on POSIX without escalation when the child exits', async () => {
    const signals: Array<[number, ProcessSignal]> = [];
    let alive = true;
    const registry = new ProcessRegistry({
      platform: 'linux',
      escalationDelayMs: 500,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 0) return alive;
        if (signal === 'SIGTERM') alive = false;
        return true;
      },
    });
    await registry.killTree(123);
    expect(signals).toEqual([
      [-123, 'SIGTERM'],
      [123, 0],
    ]);
  });

  it('escalates to SIGKILL when the child survives SIGTERM', async () => {
    const signals: Array<[number, ProcessSignal]> = [];
    const registry = new ProcessRegistry({
      platform: 'darwin',
      escalationDelayMs: 50,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        return true;
      },
    });
    await registry.killTree(55);
    expect(signals).toEqual([
      [-55, 'SIGTERM'],
      [55, 0],
      [-55, 'SIGKILL'],
    ]);
  });

  it('falls back to the direct pid when the process group does not exist', async () => {
    const signals: Array<[number, ProcessSignal]> = [];
    const registry = new ProcessRegistry({
      platform: 'linux',
      escalationDelayMs: 50,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid < 0) return false;
        return true;
      },
    });
    await registry.killTree(88);
    expect(signals).toEqual([
      [-88, 'SIGTERM'],
      [88, 'SIGTERM'],
      [88, 0],
      [-88, 'SIGKILL'],
      [88, 'SIGKILL'],
    ]);
  });

  it('killAll kills every registered pid and clears the registry', async () => {
    const execFileImpl = vi.fn().mockResolvedValue(undefined);
    const registry = new ProcessRegistry({ platform: 'win32', execFileImpl });
    registry.register(new FakeChild(1), 'pi:a');
    registry.register(new FakeChild(2), 'tencentdb:core');
    await registry.killAll();
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(registry.pids()).toEqual([]);
  });
});
