import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../agentData/memoryStore';
import { MemoryService, type MemoryTaskQueue } from './memoryService';
import type { ServiceTask } from './appServer/types';
import type { MemoryDraft } from '../agentData/memoryContracts';

const scope = { userId: 'u', projectId: 'project-A', workspace: '/repo-a' };
type QueueInput = Parameters<MemoryTaskQueue['enqueue']>[0];

function taskResult(input: QueueInput, status: ServiceTask['status'] = 'queued'): ServiceTask {
  return { ...input, status, attempts: 0, createdAt: 0, updatedAt: 0 };
}

function setup() {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: QueueInput[] = [];
  const queue = { enqueue: vi.fn((input: QueueInput) => {
    tasks.push(input);
    return Promise.resolve(taskResult(input));
  }) };
  const service = new MemoryService({ store, queue });
  return { db, store, tasks, queue, service };
}

describe('MemoryService', () => {
  it('manages raw and derived memory without queueing extraction or consuming pending captures', async () => {
    const { db, store, service, queue } = setup();
    const draft: MemoryDraft = { content: 'manual', level: 2, owner: { scope: 'global' } };
    store.capture(scope, 'session:s', '  raw\ntranscript  ', 'fp');
    const record = await service.create({ userId: 'u', draft });
    expect((await service.list({ userId: 'u', filter: { scope: 'global' } })).items).toEqual([record]);
    expect(await service.read({ userId: 'u', id: record.id })).toEqual(record);
    const edited = await service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'edited' } });
    expect(edited.revision).toBe(2);
    const conversations = await service.listConversations({ userId: 'u', filter: { scope: 'all' } });
    expect((await service.readConversation({ userId: 'u', id: conversations.items[0].id })).transcript).toBe('  raw\ntranscript  ');
    store.remove(scope, record.id);
    expect(db.prepare('SELECT pending,transcript FROM memory_captures').get()).toEqual({ pending: '  raw\ntranscript  ', transcript: '  raw\ntranscript  ' });
    expect(queue.enqueue).not.toHaveBeenCalled();
    db.close();
  });

  it('requires an explicit validated project for creation and stores the canonical owner', async () => {
    const { db, store, queue, service } = setup();
    const draft: MemoryDraft = { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'requested' } };
    await expect(service.create({ userId: 'u', draft })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const validateProject = vi.fn(async () => 'canonical');
    const validated = new MemoryService({ store, queue, validateProject });
    const record = await validated.create({ userId: 'u', draft });
    expect(validateProject).toHaveBeenCalledWith('requested');
    expect(record).toMatchObject({ sourceProjectId: 'canonical', sourceWorkspace: 'canonical' });
    expect(draft.owner).toEqual({ scope: 'project', projectId: 'requested' });
    db.close();
  });

  it('rejects failed project validation with a safe error before writing anything', async () => {
    const { db, store, queue } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error('secret filesystem path'); } });
    const draft: MemoryDraft = { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'missing' } };
    await expect(service.create({ userId: 'u', draft })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'invalid memory project' });
    expect(store.list({ userId: 'u', filter: { scope: 'all' } }).items).toEqual([]);
    db.close();
  });

  it.each(['TEMPORARY_PROJECT_NOT_ALLOWED', 'PROJECT_NOT_DIRECTORY', 'PROJECT_REQUIRED', 'project directory not available'])('preserves the safe project validation reason %s', async (reason) => {
    const { db, store, queue } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error(reason); } });
    await expect(service.create({ userId: 'u', draft: { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'requested' } } })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: reason });
    db.close();
  });

  it('allows edits under a historical missing owner but requires validation when moving projects', async () => {
    const { db, store, queue, service } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'project', projectId: 'gone' } };
    const record = store.create({ userId: 'u', draft });
    expect((await service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'edited' } })).revision).toBe(2);
    const validateProject = vi.fn(async () => 'new-project');
    const validated = new MemoryService({ store, queue, validateProject });
    await validated.update({ userId: 'u', id: record.id, expectedRevision: 2, draft });
    expect(validateProject).not.toHaveBeenCalled();
    const movedDraft: MemoryDraft = { ...draft, owner: { scope: 'project', projectId: 'new-project' } };
    await expect(service.update({ userId: 'u', id: record.id, expectedRevision: 3, draft: movedDraft })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const moved = await validated.update({ userId: 'u', id: record.id, expectedRevision: 3, draft: movedDraft });
    expect(moved).toMatchObject({ sourceProjectId: 'new-project', sourceWorkspace: 'gone', revision: 4 });
    expect(validateProject).toHaveBeenCalledOnce();
    await validated.update({ userId: 'u', id: record.id, expectedRevision: 4, draft: { ...draft, owner: { scope: 'global' } } });
    expect(validateProject).toHaveBeenCalledOnce();
    db.close();
  });

  it('rechecks revision after async validation and never overwrites the concurrent edit', async () => {
    const { db, store, queue } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'global' } };
    const record = store.create({ userId: 'u', draft });
    let resolve!: (project: string) => void;
    const service = new MemoryService({ store, queue, validateProject: () => new Promise<string>((done) => { resolve = done; }) });
    const pending = service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, owner: { scope: 'project', projectId: 'new' } } });
    const concurrent = store.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'concurrent' } });
    resolve('new');
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(store.read({ userId: 'u', id: record.id })).toEqual(concurrent);
    db.close();
  });

  it('does not validate a project for unauthorized or missing records', async () => {
    const { db, store, queue } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'project', projectId: 'new' } };
    const record = store.create({ userId: 'u', draft });
    const validateProject = vi.fn(async () => 'new');
    const service = new MemoryService({ store, queue, validateProject });
    for (const id of [record.id, 'missing']) await expect(service.update({ userId: 'other', id, expectedRevision: 1, draft })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'memory not found' });
    expect(validateProject).not.toHaveBeenCalled();
    db.close();
  });

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

  it('writes L1 into the source project but L2/L3 into global scope', async () => {
    const { db, service } = setup();
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: prefer dark mode', fingerprint: 'fp1' });

    service.completeExtraction(capture.taskId!, { l1: { preference: 'dark' }, l2: 'scenario text', l3: 'persona text' });

    const rows = db.prepare('SELECT level, memory_scope as scope, project_id as projectId FROM memories ORDER BY level').all() as Array<{ level: number; scope: string; projectId: string }>;
    expect(rows).toEqual([
      { level: 1, scope: 'project', projectId: 'project-A' },
      { level: 2, scope: 'global', projectId: 'project-A' },
      { level: 3, scope: 'global', projectId: 'project-A' },
    ]);

    // 另一个项目的作用域也能读到这两层（全局），但读不到 L1（项目私有）。
    const other = { userId: 'u', projectId: 'project-B', workspace: '/repo-b' };
    expect((await service.search({ ...other, query: 'scenario' })).map((r) => r.level)).toEqual([2]);
    expect(await service.search({ ...other, query: 'preference' })).toHaveLength(0);
    db.close();
  });

  it('validates system worker output before committing', async () => {
    const { db, service } = setup();
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: remember this', fingerprint: 'fp1' });

    expect(service.completeExtraction(capture.taskId!, { l1: { preference: 'dark' } })).toHaveLength(1);
    expect(() => service.completeExtraction('missing', { l1: {} })).toThrow('memory capture task not found');
    const retry = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: validate this', fingerprint: 'fp2' });
    expect(() => service.completeExtraction(retry.taskId!, 'invalid')).toThrow('memory extraction output is invalid');
    db.close();
  });

  it('reuses the pending task when the same capture is submitted again', async () => {
    const { db, tasks, service } = setup();
    const input = { ...scope, sessionId: 's', source: 'session:s', transcript: 'user: duplicate', fingerprint: 'same' };
    const first = await service.capture(input);
    const second = await service.capture(input);
    expect(second.taskId).toBe(first.taskId);
    expect(tasks).toHaveLength(1);
    db.close();
  });

  it('deduplicates against durable queued tasks after service recreation', async () => {
    const { db, store, tasks, queue, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: persisted', fingerprint: 'fp' };
    const first = await service.capture(input);
    const reopened = new MemoryService({ store, queue: { ...queue, findPending: (kind, matches) => {
      const task = taskResult(tasks[0]);
      return task.kind === kind && matches(task) ? task : undefined;
    } } });
    expect((await reopened.capture(input)).taskId).toBe(first.taskId);
    expect(tasks).toHaveLength(1);
    db.close();
  });

  it('retries a failed task with the prior pending text plus the new suffix', async () => {
    const { db, tasks, queue, service } = setup();
    queue.enqueue.mockImplementationOnce(async (input) => { tasks.push(input); return taskResult(input, 'failed'); });
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: first\nuser: second' });
    db.close();
  });

  it('can requeue an unchanged capture after its extraction task fails', async () => {
    const { db, tasks, queue, service } = setup();
    queue.enqueue.mockImplementationOnce(async (input) => { tasks.push(input); return taskResult(input, 'failed'); });
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    const second = await service.capture(input);
    expect(second.taskId).not.toBe(first.taskId);
    expect(tasks).toHaveLength(2);
    db.close();
  });

  it.each([{}, { l1: {}, l2: ' ', l3: '' }, { l1: [] }])('commits valid empty extraction output %j without creating memory rows', async (output) => {
    const { db, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: hello', fingerprint: 'fp' };
    const capture = await service.capture(input);
    expect(service.completeExtraction(capture.taskId!, output)).toEqual([]);
    expect(await service.capture(input)).toMatchObject({ changed: false });
    db.close();
  });

  it('does not mistake an unrelated JSON object for a valid empty extraction', async () => {
    const { db, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: remember this', fingerprint: 'fp' };
    const capture = await service.capture(input);
    expect(() => service.completeExtraction(capture.taskId!, { result: 'bad schema' })).toThrow('memory extraction output is invalid');
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: input.transcript });
    db.close();
  });

  it('captures raw conversations without enqueueing when extraction is disabled', async () => {
    const { db, store, tasks, service } = setup();
    await service.capture({ ...scope, source: 'session:s', transcript: 'user: raw only', fingerprint: 'fp', extract: false });
    expect(tasks).toHaveLength(0);
    expect(store.searchConversations(scope, 'raw only')).toHaveLength(1);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    db.close();
  });

  it('coalesces rapid turns and extracts only the remaining suffix after the active task completes', async () => {
    const { db, tasks, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    await service.capture({ ...input, transcript: 'user: first\nuser: second\nuser: third', fingerprint: 'fp3' });
    expect(tasks).toHaveLength(1);
    service.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: second\nuser: third', fingerprint: 'fp3' });
    service.completeExtraction(tasks[1].id, {});
    expect(tasks).toHaveLength(2);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    db.close();
  });

  it('retains newer input after failure but stops automatic retries without further input', async () => {
    const { db, tasks, queue, service } = setup();
    let fail!: (task: ServiceTask) => void;
    queue.enqueue.mockImplementationOnce((input) => { tasks.push(input); return new Promise((resolve) => { fail = resolve; }); });
    queue.enqueue.mockImplementation(async (input) => { tasks.push(input); return taskResult(input, 'failed'); });
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    expect((await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' })).taskId).toBe(first.taskId);
    fail(taskResult(tasks[0], 'failed'));
    await vi.waitFor(() => expect(tasks).toHaveLength(2));
    expect(tasks[1].input).toMatchObject({ delta: 'user: first\nuser: second' });
    await Promise.resolve(); await Promise.resolve();
    expect(tasks).toHaveLength(2);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: first\nuser: second' });
    db.close();
  });

  it('resumes a coalesced suffix after the service is recreated during extraction', async () => {
    const { db, store, tasks, queue, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    const reopened = new MemoryService({ store, queue: { ...queue, get: (id) => {
      const task = tasks.find((value) => value.id === id);
      return task ? taskResult(task) : undefined;
    } } });
    reopened.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: second', fingerprint: 'fp2' });
    reopened.completeExtraction(tasks[1].id, {});
    expect(tasks).toHaveLength(2);
    db.close();
  });

  it('coalesces a new fingerprint into a recovered source and excludes its still-running task when continuing', async () => {
    const { db, store, tasks, queue, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    const reopened = new MemoryService({ store, queue: {
      ...queue,
      get: (id) => { const task = tasks.find((value) => value.id === id); return task ? taskResult(task, 'running') : undefined; },
      findPending: (kind, matches) => tasks.map((task) => taskResult(task, 'running')).find((task) => task.kind === kind && matches(task)),
    } });
    const next = await reopened.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    expect(next.taskId).toBe(first.taskId);
    expect(tasks).toHaveLength(1);
    // TaskQueue persists completed only after this callback returns.
    reopened.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: second', fingerprint: 'fp2' });
    reopened.completeExtraction(tasks[1].id, {});
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    db.close();
  });

  it('continues a recovered failed task from durable newer input without looping on the next failure', async () => {
    const { db, store, tasks, queue, service } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    const reopened = new MemoryService({ store, queue: { ...queue, get: (id) => {
      const task = tasks.find((value) => value.id === id);
      return task ? taskResult(task, 'failed') : undefined;
    } } });
    reopened.taskSettled(taskResult(tasks[0], 'failed'));
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: first\nuser: second', fingerprint: 'fp2' });
    reopened.taskSettled(taskResult(tasks[1], 'failed'));
    expect(tasks).toHaveLength(2);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: first\nuser: second' });
    db.close();
  });
});
