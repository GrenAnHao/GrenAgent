import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../agentData/memoryStore';
import { MemoryService, type MemoryServiceOptions, type MemoryTaskQueue } from './memoryService';
import type { ServiceTask } from './appServer/types';
import type { MemoryDraft } from '../agentData/memoryContracts';

const scope = { userId: 'u', projectId: 'project-A', workspace: '/repo-a' };
type QueueInput = Parameters<MemoryTaskQueue['enqueue']>[0];

function taskResult(input: QueueInput, status: ServiceTask['status'] = 'queued'): ServiceTask {
  return { ...input, status, attempts: 0, createdAt: 0, updatedAt: 0 };
}

function setup(layerSchedule: MemoryServiceOptions['layerSchedule'] = { delayMs: 0, minIntervalMs: 0 }) {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: QueueInput[] = [];
  const queue: MemoryTaskQueue & { enqueue: ReturnType<typeof vi.fn<(input: QueueInput) => Promise<ServiceTask>>> } = {
    enqueue: vi.fn((input: QueueInput) => {
      tasks.push(input);
      return Promise.resolve(taskResult(input));
    }),
  };
  const service = new MemoryService({ store, queue, layerSchedule });
  return { db, store, tasks, queue, service, layerSchedule };
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
    const { db, store, queue, service, layerSchedule } = setup();
    const draft: MemoryDraft = { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'requested' } };
    await expect(service.create({ userId: 'u', draft })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const validateProject = vi.fn(async () => 'canonical');
    const validated = new MemoryService({ store, queue, validateProject, layerSchedule });
    const record = await validated.create({ userId: 'u', draft });
    expect(validateProject).toHaveBeenCalledWith('requested');
    expect(record).toMatchObject({ sourceProjectId: 'canonical', sourceWorkspace: 'canonical' });
    expect(draft.owner).toEqual({ scope: 'project', projectId: 'requested' });
    db.close();
  });

  it('rejects failed project validation with a safe error before writing anything', async () => {
    const { db, store, queue, layerSchedule } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error('secret filesystem path'); }, layerSchedule });
    const draft: MemoryDraft = { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'missing' } };
    await expect(service.create({ userId: 'u', draft })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'invalid memory project' });
    expect(store.list({ userId: 'u', filter: { scope: 'all' } }).items).toEqual([]);
    db.close();
  });

  it.each(['TEMPORARY_PROJECT_NOT_ALLOWED', 'PROJECT_NOT_DIRECTORY', 'PROJECT_REQUIRED', 'project directory not available'])('preserves the safe project validation reason %s', async (reason) => {
    const { db, store, queue, layerSchedule } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error(reason); }, layerSchedule });
    await expect(service.create({ userId: 'u', draft: { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'requested' } } })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: reason });
    db.close();
  });

  it('allows edits under a historical missing owner but requires validation when moving projects', async () => {
    const { db, store, queue, service, layerSchedule } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'project', projectId: 'gone' } };
    const record = store.create({ userId: 'u', draft });
    expect((await service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'edited' } })).revision).toBe(2);
    const validateProject = vi.fn(async () => 'new-project');
    const validated = new MemoryService({ store, queue, validateProject, layerSchedule });
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
    const { db, store, queue, layerSchedule } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'global' } };
    const record = store.create({ userId: 'u', draft });
    let resolve!: (project: string) => void;
    const service = new MemoryService({ store, queue, validateProject: () => new Promise<string>((done) => { resolve = done; }), layerSchedule });
    const pending = service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, owner: { scope: 'project', projectId: 'new' } } });
    const concurrent = store.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'concurrent' } });
    resolve('new');
    await expect(pending).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(store.read({ userId: 'u', id: record.id })).toEqual(concurrent);
    db.close();
  });

  it('does not validate a project for unauthorized or missing records', async () => {
    const { db, store, queue, layerSchedule } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'project', projectId: 'new' } };
    const record = store.create({ userId: 'u', draft });
    const validateProject = vi.fn(async () => 'new');
    const service = new MemoryService({ store, queue, validateProject, layerSchedule });
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

  it('抽取任务带上背景对话、上一情境和 mode', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '旧事实', type: 'work_fact', scene_name: '团队在围绕旧议题推进' }) });
    store.capture(scope, 'session:s1', 'user: first', 'fp0');
    store.commitCapture(scope, 'session:s1', 'fp0');
    await service.capture({ ...scope, source: 'session:s1', transcript: 'user: first\nuser: second', fingerprint: 'fp1' });
    expect(tasks[0].input).toMatchObject({
      delta: 'user: second',
      background: 'user: first',
      previousSceneName: '团队在围绕旧议题推进',
      mode: 'work',
    });
    db.close();
  });

  it('completeExtraction 接受上游 scene 数组', async () => {
    const { db, store, service } = setup();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    const writes = service.completeExtraction(captured.taskId!, [{
      scene_name: '团队在围绕抽取对齐',
      message_ids: ['m0'],
      memories: [{ content: '团队决定对齐上游输出', type: 'work_method', priority: 90, source_message_ids: ['m0'] }],
    }]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(store.search(scope, '对齐上游')[0].content)).toMatchObject({
      type: 'work_method',
      scene_name: '团队在围绕抽取对齐',
    });
    db.close();
  });

  it('writes L1 into the source project then enqueues memory_scene instead of envelope L2/L3', async () => {
    const { db, tasks, service } = setup();
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: prefer dark mode', fingerprint: 'fp1' });

    const writes = service.completeExtraction(capture.taskId!, {
      l1: [{ content: 'prefer dark mode', type: 'work_fact', priority: 80 }],
      l2: 'scenario text',
      l3: 'persona text',
    });

    expect(writes.every((row) => row.level === 1)).toBe(true);
    expect(db.prepare('SELECT level FROM memories').all()).toEqual([{ level: 1 }]);
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_scene']);
    expect(tasks[1].input).toMatchObject({
      memories: [expect.objectContaining({ content: 'prefer dark mode', type: 'work_fact' })],
      maxScenes: 15,
      mode: 'work',
    });
    db.close();
  });

  it('把 L1 记录数组逐条落库，而不是整包字符串', async () => {
    const { db, store, service } = setup();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, {
      l1: [
        { content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 },
        { content: '后端需在周五前完成表结构设计', type: 'work_task', priority: 85 },
      ],
    });
    const rows = store.search(scope, '团队决定');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toMatchObject({ type: 'work_method', priority: 90 });
    expect(store.search(scope, '表结构')).toHaveLength(1);
    db.close();
  });

  it('validates system worker output before committing', async () => {
    const { db, service } = setup();
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: remember this', fingerprint: 'fp1' });

    expect(service.completeExtraction(capture.taskId!, { l1: [{ content: 'remember this', type: 'work_fact', priority: 80 }] })).toHaveLength(1);
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
    const { db, store, tasks, queue, service, layerSchedule } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: persisted', fingerprint: 'fp' };
    const first = await service.capture(input);
    const reopened = new MemoryService({ store, queue: { ...queue, findPending: (kind, matches) => {
      const task = taskResult(tasks[0]);
      return task.kind === kind && matches(task) ? task : undefined;
    } }, layerSchedule });
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

  it.each([{}, { l2: ' ', l3: '' }, { l1: [] }])('commits valid empty extraction output %j without creating memory rows', async (output) => {
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
    const { db, store, tasks, queue, service, layerSchedule } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    const reopened = new MemoryService({ store, queue: { ...queue, get: (id) => {
      const task = tasks.find((value) => value.id === id);
      return task ? taskResult(task) : undefined;
    } }, layerSchedule });
    reopened.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: second', fingerprint: 'fp2' });
    reopened.completeExtraction(tasks[1].id, {});
    expect(tasks).toHaveLength(2);
    db.close();
  });

  it('coalesces a new fingerprint into a recovered source and excludes its still-running task when continuing', async () => {
    const { db, store, tasks, queue, service, layerSchedule } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    const first = await service.capture(input);
    const reopened = new MemoryService({ store, queue: {
      ...queue,
      get: (id) => { const task = tasks.find((value) => value.id === id); return task ? taskResult(task, 'running') : undefined; },
      findPending: (kind, matches) => tasks.map((task) => taskResult(task, 'running')).find((task) => task.kind === kind && matches(task)),
    }, layerSchedule });
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
    const { db, store, tasks, queue, service, layerSchedule } = setup();
    const input = { ...scope, source: 'session:s', transcript: 'user: first', fingerprint: 'fp1' };
    await service.capture(input);
    await service.capture({ ...input, transcript: 'user: first\nuser: second', fingerprint: 'fp2' });
    const reopened = new MemoryService({ store, queue: { ...queue, get: (id) => {
      const task = tasks.find((value) => value.id === id);
      return task ? taskResult(task, 'failed') : undefined;
    } }, layerSchedule });
    reopened.taskSettled(taskResult(tasks[0], 'failed'));
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({ delta: 'user: first\nuser: second', fingerprint: 'fp2' });
    reopened.taskSettled(taskResult(tasks[1], 'failed'));
    expect(tasks).toHaveLength(2);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: first\nuser: second' });
    db.close();
  });

  it('有候选项时先入队 memory_deduplicate，且不立即提交 capture', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: '团队决定 L1 只保留高层类型' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }] });

    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_deduplicate']);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: a' });
    const input = tasks[1].input as { matches: Array<{ newMemory: { record_id: string }; candidates: Array<{ id: string; type?: string; level?: number }> }> };
    expect(input.matches).toHaveLength(1);
    expect(input.matches[0].newMemory.record_id).toBe('r0');
    expect(input.matches[0].candidates.length).toBeGreaterThan(0);
    expect(input.matches[0].candidates.every((hit) => hit.type === 'work_method')).toBe(true);
    db.close();
  });

  it('completeDedup 找不到任务时抛出 memory capture task not found', async () => {
    const { db, service } = setup();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [{ content: 'x', type: 'work_fact' }] });
    expect(() => service.completeDedup('missing', [])).toThrow('memory capture task not found');
    db.close();
  });

  it('completeDedup 按决策写入并提交 capture，有新 L1 时再入队 memory_scene', async () => {
    const { db, store, tasks, service } = setup();
    const existing = store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, {
      l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }],
    });
    const dedup = tasks.find((task) => task.kind === 'memory_deduplicate');
    expect(dedup).toBeDefined();

    const writes = service.completeDedup(dedup!.id, [{
      record_id: 'r0',
      action: 'merge',
      target_ids: [existing.id],
      merged_content: '团队决定 L1 只保留高层类型并提升优先级',
      merged_type: 'work_method',
      merged_priority: 95,
    }]);

    expect(writes.some((row) => row.level === 1 && JSON.parse(row.content).content === '团队决定 L1 只保留高层类型并提升优先级')).toBe(true);
    expect(store.search(scope, '提升优先级')).toHaveLength(1);
    expect(store.search(scope, '提升优先级')[0].id).not.toBe(existing.id);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_deduplicate', 'memory_scene']);
    db.close();
  });

  it('completeDedup 忽略不在候选池里的 target_ids', async () => {
    const { db, store, tasks, service } = setup();
    const existing = store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    const unrelated = store.upsert(scope, { level: 1, content: JSON.stringify({ content: '无关的发布窗口', type: 'work_task', priority: 60 }) });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }] });
    const dedup = tasks.find((task) => task.kind === 'memory_deduplicate');
    service.completeDedup(dedup!.id, [{
      record_id: 'r0',
      action: 'merge',
      target_ids: [existing.id, unrelated.id],
      merged_content: '合并后的工作方法',
      merged_type: 'work_method',
      merged_priority: 95,
    }]);
    expect(store.search(scope, '合并后的工作方法')).toHaveLength(1);
    expect(store.search(scope, '无关的发布窗口')).toHaveLength(1);
    expect(store.search(scope, '无关的发布窗口')[0].id).toBe(unrelated.id);
    db.close();
  });

  it('completeDedup 非法 output 时不提交 capture，pending 仍在', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }] });
    const dedup = tasks.find((task) => task.kind === 'memory_deduplicate');
    expect(dedup).toBeDefined();

    expect(() => service.completeDedup(dedup!.id, { not: 'an array' })).toThrow('memory dedup output is invalid');
    expect(() => service.completeDedup(dedup!.id, [{ action: 'store' }])).toThrow('memory dedup output is invalid');
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: a' });
    expect(store.search(scope, '团队决定')).toHaveLength(1);
    expect(JSON.parse(store.search(scope, '团队决定')[0].content)).toMatchObject({ priority: 80 });
    expect(() => service.completeDedup(dedup!.id, [{ record_id: 'r0', action: 'skip' }])).not.toThrow();
    db.close();
  });

  it('memory_deduplicate 失败时不提交 capture，也不写入新 L1', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }] });
    const dedup = tasks.find((task) => task.kind === 'memory_deduplicate');
    expect(dedup).toBeDefined();
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: a' });

    service.taskSettled({ id: dedup!.id, kind: 'memory_deduplicate', status: 'failed', input: dedup!.input, attempts: 0, createdAt: 0, updatedAt: 0 });

    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: a' });
    const rows = store.search(scope, '团队决定');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toMatchObject({ priority: 80 });
    db.close();
  });

  it('completeScene 按 filename 落 global L2，无 L3 时再入队 memory_persona', async () => {
    const { db, store, tasks, service } = setup();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    expect(scene).toBeDefined();
    const writes = service.completeScene(scene!.id, {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '-----META-START-----\nsummary: sop\nheat: 1\n-----META-END-----\n\n## 核心 SOP\n先对齐抽取协议。' }],
    });
    expect(writes[0]).toMatchObject({ level: 2, scope: 'global', source: 'scene:团队记忆-SOP与禁忌.md' });
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_scene', 'memory_persona']);
    const persona = tasks.find((task) => task.kind === 'memory_persona');
    const l3 = service.completePersona(persona!.id, { content: '# Team Operating Doctrine\n\n- 先对齐协议再落库' });
    expect(l3).toMatchObject({ level: 3, source: 'persona.md', scope: 'global' });
    const other = { userId: 'u', projectId: 'project-B', workspace: '/repo-b' };
    expect((await service.search({ ...other, query: '核心 SOP' })).map((row) => row.level)).toEqual([2]);
    expect((await service.search({ ...other, query: 'Operating Doctrine' })).map((row) => row.level)).toEqual([3]);
    expect(store.search(scope, '对齐抽取协议').some((row) => row.level === 1)).toBe(true);
    db.close();
  });

  it('completeScene 非法输出不回滚已提交的 L1', async () => {
    const { db, store, tasks, service } = setup();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    expect(() => service.completeScene(scene!.id, [])).toThrow('memory scene output is invalid');
    expect(store.search(scope, '对齐抽取协议')).toHaveLength(1);
    expect(store.list({ userId: 'u', filter: { scope: 'global' }, level: 2 }).items).toHaveLength(0);
    db.close();
  });

  it('已有 L3 且无 persona_update_request 时不入队 memory_persona', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 3, content: '# Team Operating Doctrine', source: 'persona.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    service.completeScene(scene!.id, {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\n先对齐' }],
    });
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_scene']);
    db.close();
  });

  it('persona_update_request 在已有 L3 时仍入队 memory_persona', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 3, content: '# Team Operating Doctrine', source: 'persona.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    service.completeScene(scene!.id, {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\n先对齐' }],
      persona_update_request: 'SOP 已跨场景稳定',
    });
    const persona = tasks.find((task) => task.kind === 'memory_persona');
    expect(persona?.input).toMatchObject({ generation: 'incremental', triggerInfo: 'SOP 已跨场景稳定' });
    db.close();
  });

  function setupClock() {
    let now = 1_000_000;
    const timers: Array<{ at: number; cb: () => void }> = [];
    const base = setup({
      delayMs: 10_000,
      minIntervalMs: 900_000,
      now: () => now,
      setTimer: (cb, ms) => {
        const entry = { at: now + ms, cb };
        timers.push(entry);
        return { cancel: () => {
          const index = timers.indexOf(entry);
          if (index >= 0) timers.splice(index, 1);
        } };
      },
    });
    const advance = async (ms: number) => {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        timer.cb();
      }
      await Promise.resolve();
    };
    return { ...base, advance, now: () => now };
  }

  it('首次 L1 等待 10s 才入队 memory_scene', async () => {
    const { db, tasks, service, advance } = setupClock();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract']);
    await advance(9_999);
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract']);
    await advance(1);
    expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_scene']);
    expect((tasks[1].input as { memories: Array<{ content: string }> }).memories).toEqual([
      expect.objectContaining({ content: '团队决定对齐抽取协议' }),
    ]);
    db.close();
  });

  it('等待中的新 L1 合并并重新计 10s', async () => {
    const { db, tasks, service, advance } = setupClock();
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
    await advance(5_000);
    const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
    service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
    await advance(9_999);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(0);
    await advance(1);
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    expect((scene!.input as { memories: Array<{ content: string }> }).memories.map((row) => row.content)).toEqual([
      '第一条方法',
      '第二条任务',
    ]);
    db.close();
  });

  it('L2 成功后 15 分钟内不再入队', async () => {
    const { db, tasks, service, advance } = setupClock();
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    await advance(10_000);
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    service.completeScene(scene!.id, {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\n先对齐' }],
    });
    const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
    service.completeExtraction(second.taskId!, { l1: [{ content: '另一条方法', type: 'work_method', priority: 90 }] });
    await advance(899_999);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    await advance(1);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(2);
    db.close();
  });

  it('recoverLayerSchedules 在 fire_at 已过时立刻入队', async () => {
    const { db, store, queue, tasks, service, now } = setupClock();
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
    service.dispose();
    const reopened = new MemoryService({
      store,
      queue,
      layerSchedule: {
        delayMs: 10_000,
        minIntervalMs: 900_000,
        now: () => now() + 11_000,
        setTimer: (cb, ms) => {
          if (ms <= 0) cb();
          return { cancel: () => {} };
        },
      },
    });
    reopened.recoverLayerSchedules();
    await Promise.resolve();
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    reopened.dispose();
    db.close();
  });

  it('已有 queued scene 时新 L1 只更新日程', async () => {
    const { db, tasks, queue, service } = setup({ delayMs: 0, minIntervalMs: 0 });
    queue.findPending = vi.fn((kind, matches) => {
      const task = tasks.map((item) => taskResult(item)).find((item) => item.kind === kind && matches(item));
      return task;
    });
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
    service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    db.close();
  });

  it('scene 未完成时到来的 L1 写入日程，完成后按最小间隔再跑', async () => {
    const { db, tasks, queue, service, advance } = setupClock();
    const completed = new Set<string>();
    queue.findPending = vi.fn((kind, matches) => {
      return tasks
        .filter((item) => !completed.has(item.id))
        .map((item) => taskResult(item, kind === 'memory_scene' ? 'running' : 'queued'))
        .find((item) => item.kind === kind && matches(item));
    });
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
    await advance(10_000);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
    service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    const scene = tasks.find((task) => task.kind === 'memory_scene');
    service.completeScene(scene!.id, {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\nv1' }],
    });
    completed.add(scene!.id);
    await advance(899_999);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
    await advance(1);
    expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(2);
    const secondScene = tasks.filter((task) => task.kind === 'memory_scene')[1];
    expect((secondScene.input as { memories: Array<{ content: string }> }).memories.map((row) => row.content)).toContain('第二条任务');
    db.close();
  });
});
