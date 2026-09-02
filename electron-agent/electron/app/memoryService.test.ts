import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../agentData/memoryStore';
import { EventBus } from './appServer/eventBus';
import { MemoryService } from './memoryService';

const scope = { userId: 'u', projectId: 'project-A', workspace: '/repo-a' };

function setup() {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: Array<Record<string, unknown>> = [];
  const queue = { enqueue: vi.fn((input: Record<string, unknown>) => {
    tasks.push(input);
    return Promise.resolve({ id: input.id, ...input, status: 'queued' });
  }) };
  const bus = new EventBus();
  const service = new MemoryService({ store, queue, eventBus: bus });
  return { db, store, tasks, queue, bus, service };
}

describe('MemoryService', () => {
  it('returns only current project and global memory by default', async () => {
    const { db, store, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 1, content: 'shared global' });
    store.upsert(scope, { level: 1, content: 'project A fact' });
    store.upsert({ ...scope, projectId: 'project-B', workspace: '/repo-b' }, { level: 1, content: 'project B fact' });

    const result = await service.search({ ...scope, query: 'shared' });
    expect(result.map((item) => item.content)).toEqual(['shared global']);
    expect(result[0]).toMatchObject({ scope: 'global', sourceProjectId: undefined });
    expect(await service.search({ ...scope, query: 'fact' })).toEqual([expect.objectContaining({ content: 'project A fact', sourceProjectId: 'project-A', scope: 'project' })]);
    expect(await service.search({ ...scope, query: 'shared' })).toHaveLength(1);
    db.close();
  });

  it('includes other projects only when explicitly enabled and annotates their source', async () => {
    const { db, store, service } = setup();
    store.upsert({ ...scope, projectId: 'project-B', workspace: '/repo-b' }, { level: 1, content: 'shared project fact' });

    const result = await service.search({ ...scope, query: 'shared', includeOtherProjects: true });
    expect(result).toEqual([expect.objectContaining({ sourceProjectId: 'project-B', scope: 'project' })]);
    db.close();
  });

  it('creates a pending capture and memory_extract task without writing final memories', async () => {
    const { db, store, tasks, service } = setup();
    const result = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: remember this', fingerprint: 'fp1' });

    expect(result).toMatchObject({ changed: true, delta: 'user: remember this' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'memory_extract', system: true, sourceProjectId: 'project-A' });
    expect(store.search(scope, 'remember')).toHaveLength(0);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: remember this' });
    db.close();
  });

  it('validates system worker output before committing and emits memory.updated', async () => {
    const { db, bus, service } = setup();
    const events: unknown[] = [];
    bus.subscribe((event) => events.push(event));
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: remember this', fingerprint: 'fp1' });

    expect(service.completeExtraction(capture.taskId!, { l1: { preference: 'dark' } })).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ type: 'memory.updated', projectId: 'project-A' })]);
    expect(() => service.completeExtraction('missing', { l1: {} })).toThrow('memory capture task not found');
    const retry = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: validate this', fingerprint: 'fp2' });
    expect(() => service.completeExtraction(retry.taskId!, 'invalid')).toThrow('memory extraction output is invalid');
    db.close();
  });
});
