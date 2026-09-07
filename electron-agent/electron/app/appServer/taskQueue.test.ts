import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataStorage } from '../../agentData/storage';
import { ServiceTaskRegistry } from './serviceTaskRegistry';
import { TaskQueue } from './taskQueue';

function setup() {
  const storage = new AgentDataStorage(':memory:'); storage.migrate();
  const registry = new ServiceTaskRegistry();
  registry.register({ kind: 'test', inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) }, outputSchema: {}, timeoutMs: 1000, maxAttempts: 2, capabilities: [] });
  return { storage, registry };
}

describe('TaskQueue', () => {
  it('settles queued waiters on stop without cancelling durable work or the active executor', async () => {
    const { storage, registry } = setup(); let release!: () => void;
    const execute = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const queue = new TaskQueue({ storage, registry, execute });
    const active = queue.enqueue({ id: 'active', kind: 'test', system: true, input: {} });
    const waiting = queue.enqueue({ id: 'waiting', kind: 'test', system: true, input: {} });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    queue.stop(); let idle = false; const drained = queue.whenIdle().then(() => { idle = true; });
    try {
      expect(queue.get('waiting')?.status).toBe('queued');
      expect(queue.get('active')?.status).toBe('running'); expect(idle).toBe(false);
      await expect(queue.enqueue({ id: 'after-stop', kind: 'test', input: {} })).rejects.toThrow('stopped');
    } finally { release(); await active; await drained; storage.close(); }
    await expect(waiting).resolves.toMatchObject({ status: 'queued' });
    expect(idle).toBe(true); expect(execute).toHaveBeenCalledOnce();
  });

  it('notifies persisted terminal states including tasks recovered without an enqueue waiter', async () => {
    const { storage, registry } = setup();
    const settled: string[] = [];
    const queue = new TaskQueue({ storage, registry, execute: async () => { throw new Error('offline'); }, onSettled: (task) => {
      expect(queue.get(task.id)?.status).toBe(task.status);
      settled.push(`${task.id}:${task.status}`);
    } });
    const now = Date.now();
    storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('recovered', 'test', 'running', '{}', 1, now, now);
    queue.recoverRunning();
    await vi.waitFor(() => expect(queue.get('recovered')?.status).toBe('failed'));
    expect(settled).toEqual(['recovered:failed']);
    storage.close();
  });

  it('isolates terminal notification errors without changing completion or retrying execution', async () => {
    const { storage, registry } = setup();
    const execute = vi.fn(async () => ({ ok: true }));
    const onSettled = vi.fn(() => { throw new Error('notification failed'); });
    const queue = new TaskQueue({ storage, registry, execute, onSettled });
    await expect(queue.enqueue({ id: 'a', kind: 'test', input: {} })).resolves.toMatchObject({ status: 'completed' });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a', status: 'completed' }));
    expect(execute).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    storage.close();
  });

  it('serializes tasks for the same thread and persists them', async () => {
    const { storage, registry } = setup();
    let active = 0; let maxActive = 0; let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const queue = new TaskQueue({ storage, registry, execute: async () => { active += 1; maxActive = Math.max(maxActive, active); await first; active -= 1; return { ok: true }; } });
    const a = queue.enqueue({ id: 'a', kind: 'test', threadId: 'thread-1', input: {} });
    const b = queue.enqueue({ id: 'b', kind: 'test', threadId: 'thread-1', input: {} });
    await Promise.resolve(); await Promise.resolve(); expect(maxActive).toBe(1); release();
    await expect(a).resolves.toMatchObject({ status: 'completed' }); await expect(b).resolves.toMatchObject({ status: 'completed' });
    expect(storage.db.prepare('SELECT count(*) as count FROM service_tasks').get()).toMatchObject({ count: 2 });
  });

  it('cancels queued tasks and recovers running tasks after restart', async () => {
    const { storage, registry } = setup(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new TaskQueue({ storage, registry, execute: async () => { await gate; return null; } });
    const running = queue.enqueue({ id: 'running', kind: 'test', system: true, input: {} });
    const queued = queue.enqueue({ id: 'queued', kind: 'test', system: true, input: {} });
    await Promise.resolve();
    expect(queue.cancel('queued')).toMatchObject({ status: 'cancelled' });
    expect(queue.recoverRunning()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'running', status: 'queued' })]));
    release(); await running.catch(() => {}); await queued.catch(() => {});
  });

  it('automatically executes recovered tasks without another enqueue', async () => {
    const { storage, registry } = setup();
    const execute = vi.fn(async () => ({ recovered: true }));
    const now = Date.now();
    storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('crashed', 'test', 'running', '{}', 1, now, now);
    const queue = new TaskQueue({ storage, registry, execute });

    const recovered = queue.recoverRunning();

    expect(recovered).toEqual([expect.objectContaining({ id: 'crashed', status: 'queued' })]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queue.get('crashed')).toMatchObject({ status: 'completed', output: { recovered: true } }));
  });

  it('resumes tasks that were already queued before restart', async () => {
    const { storage, registry } = setup();
    const execute = vi.fn(async () => ({ resumed: true }));
    const now = Date.now();
    storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('queued-before-restart', 'test', 'queued', '{}', 0, now, now);
    const queue = new TaskQueue({ storage, registry, execute });

    expect(queue.recoverRunning()).toEqual([]);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queue.get('queued-before-restart')).toMatchObject({ status: 'completed', output: { resumed: true } }));
  });

  it('finds matching durable queued or running tasks but not terminal tasks', () => {
    const { storage, registry } = setup();
    const insert = storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    insert.run('failed', 'test', 'failed', '{"fingerprint":"same"}', 1, 1, 1);
    insert.run('running', 'test', 'running', '{"fingerprint":"same"}', 1, 2, 2);
    insert.run('queued', 'test', 'queued', '{"fingerprint":"other"}', 0, 3, 3);
    const queue = new TaskQueue({ storage, registry, execute: async () => ({}) });
    expect(queue.findPending('test', (task) => (task.input as { fingerprint: string }).fingerprint === 'same')).toMatchObject({ id: 'running' });
    expect(queue.findPending('test', (task) => (task.input as { fingerprint: string }).fingerprint === 'other')).toMatchObject({ id: 'queued' });
    expect(queue.findPending('memory_extract', () => true)).toBeUndefined();
    storage.close();
  });
});
