import { describe, expect, it, vi } from 'vitest';
import { SystemWorkerManager } from './systemWorkerManager';

function fakeClient() {
  return { send: vi.fn(async () => ({ result: 'ok' })), respondUi: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('SystemWorkerManager', () => {
  it('starts on demand, reuses the worker, and closes after idle timeout', async () => {
    vi.useFakeTimers(); const clients = [fakeClient()]; const open = vi.fn(() => clients[0]);
    const manager = new SystemWorkerManager({ processCommand: { command: 'pi', args: ['agent'] }, idleTimeoutMs: 100, createClient: open });
    await manager.run({ id: 'a', kind: 'memory_extract', input: { text: 'a' } });
    await manager.run({ id: 'b', kind: 'memory_extract', input: { text: 'b' } });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('__system__', expect.anything(), expect.objectContaining({ profile: 'automation' }));
    vi.advanceTimersByTime(100); await Promise.resolve();
    expect(clients[0].close).toHaveBeenCalledOnce(); vi.useRealTimers();
  });

  it('requeues a crashed task until max attempts then fails', async () => {
    const manager = new SystemWorkerManager({ processCommand: { command: 'pi', args: [] }, createClient: vi.fn(() => { throw new Error('spawn failed'); }), maxAttempts: 2 });
    await expect(manager.run({ id: 'a', kind: 'memory_extract', input: {} })).rejects.toThrow('spawn failed');
    expect(manager.taskState('a')).toMatchObject({ status: 'failed', attempts: 2 });
  });
});
