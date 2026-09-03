import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataStorage } from '../../agentData/storage';
import { EventBus } from './eventBus';
import { ServiceTaskRegistry } from './serviceTaskRegistry';
import { TaskQueue } from './taskQueue';

function setup() {
  const storage = new AgentDataStorage(':memory:'); storage.migrate();
  const registry = new ServiceTaskRegistry();
  registry.register({ kind: 'test', inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) }, outputSchema: {}, timeoutMs: 1000, maxAttempts: 2, capabilities: [] });
  return { storage, registry };
}

describe('TaskQueue', () => {
  it('serializes tasks for the same thread and persists lifecycle events', async () => {
    const { storage, registry } = setup(); const bus = new EventBus();
    let active = 0; let maxActive = 0; let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const queue = new TaskQueue({ storage, registry, eventBus: bus, execute: async () => { active += 1; maxActive = Math.max(maxActive, active); await first; active -= 1; return { ok: true }; } });
    const a = queue.enqueue({ id: 'a', kind: 'test', threadId: 'thread-1', input: {} });
    const b = queue.enqueue({ id: 'b', kind: 'test', threadId: 'thread-1', input: {} });
    await Promise.resolve(); await Promise.resolve(); expect(maxActive).toBe(1); release();
    await expect(a).resolves.toMatchObject({ status: 'completed' }); await expect(b).resolves.toMatchObject({ status: 'completed' });
    expect(storage.db.prepare('SELECT count(*) as count FROM service_tasks').get()).toMatchObject({ count: 2 });
    expect(bus.replay(0)).toMatchObject({ kind: 'events', events: expect.arrayContaining([expect.objectContaining({ type: 'task.queued' }), expect.objectContaining({ type: 'task.completed' })]) });
  });

  it('cancels queued tasks and recovers running tasks after restart', async () => {
    const { storage, registry } = setup(); const bus = new EventBus(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new TaskQueue({ storage, registry, eventBus: bus, execute: async () => { await gate; return null; } });
    const running = queue.enqueue({ id: 'running', kind: 'test', system: true, input: {} });
    const queued = queue.enqueue({ id: 'queued', kind: 'test', system: true, input: {} });
    await Promise.resolve();
    expect(queue.cancel('queued')).toMatchObject({ status: 'cancelled' });
    expect(bus.replay(0)).toMatchObject({ kind: 'events', events: expect.arrayContaining([expect.objectContaining({ type: 'task.cancelled', data: expect.objectContaining({ id: 'queued', status: 'cancelled' }) })]) });
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
});
