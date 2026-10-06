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

function setup(
  layerSchedule: MemoryServiceOptions['layerSchedule'] = { delayMs: 0, minIntervalMs: 0 },
  extractCadence: MemoryServiceOptions['extractCadence'] = { everyN: 1, warmup: false },
) {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: QueueInput[] = [];
  const queue: MemoryTaskQueue & { enqueue: ReturnType<typeof vi.fn<(input: QueueInput) => Promise<ServiceTask>>> } = {
    enqueue: vi.fn((input: QueueInput) => {
      tasks.push(input);
      return Promise.resolve(taskResult(input));
    }),
  };
  const service = new MemoryService({ store, queue, layerSchedule, extractCadence });
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
    const validated = new MemoryService({ store, queue, validateProject, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
    const record = await validated.create({ userId: 'u', draft });
    expect(validateProject).toHaveBeenCalledWith('requested');
    expect(record).toMatchObject({ sourceProjectId: 'canonical', sourceWorkspace: 'canonical' });
    expect(draft.owner).toEqual({ scope: 'project', projectId: 'requested' });
    db.close();
  });

  it('rejects failed project validation with a safe error before writing anything', async () => {
    const { db, store, queue, layerSchedule } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error('secret filesystem path'); }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
    const draft: MemoryDraft = { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'missing' } };
    await expect(service.create({ userId: 'u', draft })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'invalid memory project' });
    expect(store.list({ userId: 'u', filter: { scope: 'all' } }).items).toEqual([]);
    db.close();
  });

  it.each(['TEMPORARY_PROJECT_NOT_ALLOWED', 'PROJECT_NOT_DIRECTORY', 'PROJECT_REQUIRED', 'project directory not available'])('preserves the safe project validation reason %s', async (reason) => {
    const { db, store, queue, layerSchedule } = setup();
    const service = new MemoryService({ store, queue, validateProject: async () => { throw new Error(reason); }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
    await expect(service.create({ userId: 'u', draft: { content: 'manual', level: 1, owner: { scope: 'project', projectId: 'requested' } } })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: reason });
    db.close();
  });

  it('allows edits under a historical missing owner but requires validation when moving projects', async () => {
    const { db, store, queue, service, layerSchedule } = setup();
    const draft: MemoryDraft = { content: 'old', level: 1, owner: { scope: 'project', projectId: 'gone' } };
    const record = store.create({ userId: 'u', draft });
    expect((await service.update({ userId: 'u', id: record.id, expectedRevision: 1, draft: { ...draft, content: 'edited' } })).revision).toBe(2);
    const validateProject = vi.fn(async () => 'new-project');
    const validated = new MemoryService({ store, queue, validateProject, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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
    const service = new MemoryService({ store, queue, validateProject: () => new Promise<string>((done) => { resolve = done; }), layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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
    const service = new MemoryService({ store, queue, validateProject, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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

  it('抽取任务带上背景消息、上一情境和 mode，delta 原样留作游标', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '旧事实', type: 'work_fact', scene_name: '团队在围绕旧议题推进' }) });
    store.capture(scope, 'session:s1', 'user: first', 'fp0');
    store.commitCapture(scope, 'session:s1', 'fp0');
    await service.capture({ ...scope, source: 'session:s1', transcript: 'user: first\nuser: second', fingerprint: 'fp1' });
    expect(tasks[0].input).toMatchObject({
      delta: 'user: second',
      newMessages: [expect.objectContaining({ id: 'm0', role: 'user', content: 'second' })],
      backgroundMessages: [expect.objectContaining({ id: 'b0', role: 'user', content: 'first' })],
      previousSceneName: '团队在围绕旧议题推进',
      mode: 'work',
    });
    expect(tasks[0].input).not.toHaveProperty('background');
    db.close();
  });

  it('工具输出不进抽取消息', async () => {
    const { db, tasks, service } = setup();
    await service.capture({ ...scope, source: 'session:s1', transcript: 'user: 查日志\nassistant: 我看看\ntoolResult: HUGE_TOOL_OUTPUT\nassistant: 磁盘满了', fingerprint: 'fp1' });
    const input = tasks[0].input as { newMessages: Array<{ role: string; content: string }> };
    expect(input.newMessages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: '查日志' },
      { role: 'assistant', content: '我看看\n\n磁盘满了' },
    ]);
    expect(JSON.stringify(input.newMessages)).not.toContain('HUGE_TOOL_OUTPUT');
    db.close();
  });

  it('新增内容只有工具输出时不入队，直接提交游标，也不去读历史', async () => {
    const { db, store, tasks, service } = setup();
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, {});
    const pendingCapture = vi.spyOn(store, 'pendingCapture');
    const second = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi\ntoolResult: x', fingerprint: 'fp2' });
    expect(second).toMatchObject({ changed: true, extraction: 'skipped' });
    expect(second.taskId).toBeUndefined();
    expect(tasks).toHaveLength(1);
    expect(pendingCapture).not.toHaveBeenCalled();
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    // 游标确实推过了被跳过的那段：新任务的 delta 不再包含 toolResult。
    const third = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi\ntoolResult: x\nuser: more', fingerprint: 'fp3' });
    expect(third).toMatchObject({ extraction: 'queued', delta: 'user: more' });
    expect(tasks).toHaveLength(2);
    expect(tasks[1].input).toMatchObject({
      delta: 'user: more',
      newMessages: [expect.objectContaining({ role: 'user', content: 'more' })],
      backgroundMessages: [expect.objectContaining({ role: 'user', content: 'hi' })],
    });
    db.close();
  });

  it('入队时回执带 extraction: queued', async () => {
    const { db, service } = setup();
    expect(await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi', fingerprint: 'fp1' })).toMatchObject({ extraction: 'queued' });
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
    expect(second).toMatchObject({ extraction: 'queued' });
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
    } }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
    const second = await reopened.capture(input);
    expect(second.taskId).toBe(first.taskId);
    expect(second).toMatchObject({ extraction: 'queued' });
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
    } }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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
    }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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
    } }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
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

  it('每条新记录只召回一次候选，判断和组装用同一份结果，没候选的记录走空列表', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
    const search = vi.spyOn(store, 'searchL1ByTerms');
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    await service.completeExtraction(captured.taskId!, { l1: [
      { content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 },
      { content: '发布窗口定在周五下午', type: 'work_task', priority: 60 },
    ] });

    expect(search).toHaveBeenCalledTimes(2);
    const input = tasks[1].input as { matches: Array<{ newMemory: { record_id: string }; candidates: unknown[] }> };
    expect(input.matches.map((match) => [match.newMemory.record_id, match.candidates.length > 0])).toEqual([['r0', true], ['r1', false]]);
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
      extractCadence: { everyN: 1, warmup: false },
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

describe('MemoryService 抽取节奏', () => {
  function cadenceSetup(options: MemoryServiceOptions['extractCadence'] = {}) {
    const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = [];
    const setTimer = (callback: () => void, ms: number) => {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    };
    const base = setup(undefined, { setTimer, ...options });
    const live = () => timers.filter((timer) => !timer.cancelled);
    return { ...base, timers, live };
  }
  const turn = (n: number) => ({
    ...scope, sessionId: 's', source: 'session:s',
    transcript: Array.from({ length: n }, (_, i) => `user: turn ${i}`).join('\n'), fingerprint: `fp${n}`,
  });

  it('预热阈值 1→2→4→5：第 1 轮立刻抽，之后第 3、7、12 轮才抽', async () => {
    const { db, tasks, service } = cadenceSetup();
    const fired: number[] = [];
    for (let n = 1; n <= 12; n++) {
      const result = await service.capture(turn(n));
      if (result.taskId) {
        fired.push(n);
        service.completeExtraction(result.taskId, {});
      } else {
        expect(result.extraction).toBe('deferred');
      }
    }
    expect(fired).toEqual([1, 3, 7, 12]);
    expect(tasks).toHaveLength(4);
    db.close();
  });

  it('不预热时每 everyN 轮抽一次', async () => {
    const { db, service } = cadenceSetup({ everyN: 3, warmup: false });
    const fired: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const result = await service.capture(turn(n));
      if (result.taskId) { fired.push(n); service.completeExtraction(result.taskId, {}); }
    }
    expect(fired).toEqual([3, 6]);
    db.close();
  });

  it('没到阈值时空闲 idleMs 后补抽，新一轮会重置空闲计时', async () => {
    const { db, tasks, service, live } = cadenceSetup({ everyN: 5, warmup: false, idleMs: 600_000 });
    await service.capture(turn(1));
    await service.capture(turn(2));
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(600_000);
    live()[0].callback();
    await Promise.resolve();
    expect(tasks).toHaveLength(1);
    expect((tasks[0].input as { newMessages: unknown[] }).newMessages).toHaveLength(2);
    db.close();
  });

  it('任务进行中到来的轮数照样计数，任务结束后够阈值就接着抽，不够就等空闲', async () => {
    const { db, tasks, service, live } = cadenceSetup({ everyN: 2, warmup: false });
    await service.capture(turn(1));
    const first = await service.capture(turn(2));
    expect(first.taskId).toBeDefined();
    await service.capture(turn(3));
    service.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(1);
    expect(live()).toHaveLength(1);
    await service.capture(turn(4));
    expect(tasks).toHaveLength(2);
    db.close();
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const from = (name: string, n: number, extra: { extract?: boolean } = {}) => ({ ...turn(n), sessionId: name, source: `session:${name}`, ...extra });
  const sourceOf = (task: { input: unknown }) => (task.input as { source: string }).source;

  it('启动补抽：见过开着开关的 capture 后，延迟 recoverDelayMs 对有 pending 的来源各入队一次', async () => {
    const { db, store, tasks, service, live } = cadenceSetup({ everyN: 5, warmup: false, recoverDelayMs: 60_000 });
    store.capture({ ...scope, sessionId: 's1' }, 'session:s1', 'user: left over', 'fp1');
    store.capture({ ...scope, sessionId: 's2' }, 'session:s2', 'user: also left', 'fp2');
    // 开关状态只能从 capture 带来的 extract 标志得知：先来一次开着的 capture（另一个来源，没到阈值，只会延后）。
    await service.capture(from('other', 1));
    service.recoverPendingCaptures();
    expect(tasks).toHaveLength(0);
    const recover = live().filter((timer) => timer.ms === 60_000);
    expect(recover).toHaveLength(1);
    recover[0].callback();
    await tick();
    expect(tasks.map(sourceOf).sort()).toEqual(['session:other', 'session:s1', 'session:s2']);
    db.close();
  });

  it('收到 extract:false 后，之前挂的空闲回调触发也不入队，所有来源的空闲计时都被取消', async () => {
    const { db, tasks, service, live } = cadenceSetup({ everyN: 5, warmup: false });
    await service.capture(turn(1));
    expect(live()).toHaveLength(1);
    const idle = live()[0].callback;
    await service.capture(from('off', 1, { extract: false }));
    expect(live()).toHaveLength(0);
    idle();
    await tick();
    expect(tasks).toHaveLength(0);
    // 开关重新打开后空闲补抽恢复。
    await service.capture(turn(2));
    expect(live()).toHaveLength(1);
    live()[0].callback();
    await tick();
    expect(tasks).toHaveLength(1);
    expect((tasks[0].input as { newMessages: unknown[] }).newMessages).toHaveLength(2);
    db.close();
  });

  it('请求补抽后第一次 capture 是 extract:false：补抽计时器不挂；之后来一次开着的再挂并执行', async () => {
    const { db, store, tasks, service, live } = cadenceSetup({ everyN: 1, warmup: false, recoverDelayMs: 60_000 });
    store.capture({ ...scope, sessionId: 's1' }, 'session:s1', 'user: left over', 'fp1');
    service.recoverPendingCaptures();
    expect(live()).toHaveLength(0);
    await service.capture(from('off', 1, { extract: false }));
    expect(live()).toHaveLength(0);
    const on = await service.capture(from('on', 1));
    service.completeExtraction(on.taskId!, {});
    expect(live().map((timer) => timer.ms)).toEqual([60_000]);
    live()[0].callback();
    await tick();
    expect(tasks.map(sourceOf)).toEqual(['session:on', 'session:s1']);
    db.close();
  });

  it('补抽计时器挂着时收到 extract:false 会取消并保留请求，开关重开后再挂，执行过一次就不再挂', async () => {
    const { db, store, tasks, timers, service, live } = cadenceSetup({ everyN: 1, warmup: false, recoverDelayMs: 60_000 });
    const recoverTimers = () => timers.filter((timer) => timer.ms === 60_000).length;
    store.capture({ ...scope, sessionId: 's1' }, 'session:s1', 'user: left over', 'fp1');
    service.completeExtraction((await service.capture(from('on', 1))).taskId!, {});
    service.recoverPendingCaptures();
    expect(live().map((timer) => timer.ms)).toEqual([60_000]);
    await service.capture(from('off', 1, { extract: false }));
    expect(live()).toHaveLength(0);
    service.completeExtraction((await service.capture(from('on', 2))).taskId!, {});
    expect(live().map((timer) => timer.ms)).toEqual([60_000]);
    live()[0].callback();
    await tick();
    expect(tasks.map(sourceOf)).toContain('session:s1');
    // 请求已执行过：再来开着的 capture 不会再创建补抽计时器（触发过的计时器仍留在 timers 里，所以比数量）。
    const armed = recoverTimers();
    service.completeExtraction((await service.capture(from('on', 3))).taskId!, {});
    expect(recoverTimers()).toBe(armed);
    db.close();
  });

  it('窗口为空被跳过时不推进预热阈值，也取消该来源的空闲计时', async () => {
    const { db, tasks, service, live } = cadenceSetup();
    const send = (transcript: string, n: number) => service.capture({ ...scope, sessionId: 's', source: 'session:s', transcript, fingerprint: `fp${n}` });
    const first = await send('user: hi', 1);
    expect(first.extraction).toBe('queued');
    service.completeExtraction(first.taskId!, {});
    expect((await send('user: hi\ntoolResult: x', 2)).extraction).toBe('deferred');
    expect(live()).toHaveLength(1);
    // 第 2 轮到阈值（2），但新增内容里只有工具输出：跳过，阈值不翻倍。
    expect((await send('user: hi\ntoolResult: x\ntoolResult: y', 3)).extraction).toBe('skipped');
    expect(live()).toHaveLength(0);
    expect((await send('user: hi\ntoolResult: x\ntoolResult: y\nuser: a', 4)).extraction).toBe('deferred');
    // 阈值还是 2：这一轮才入队。如果跳过时翻倍成 4，这里还会是 deferred。
    expect((await send('user: hi\ntoolResult: x\ntoolResult: y\nuser: a\nuser: b', 5)).extraction).toBe('queued');
    expect(tasks).toHaveLength(2);
    db.close();
  });

  it('dispose 取消所有节奏计时器', async () => {
    const { db, service, live } = cadenceSetup({ everyN: 5, warmup: false });
    await service.capture(turn(1));
    expect(live()).toHaveLength(1);
    service.dispose();
    expect(live()).toHaveLength(0);
    db.close();
  });

  it('dispose 之后 completeExtraction 触发的后继不入队、不挂计时器', async () => {
    const { db, tasks, service, timers } = cadenceSetup({ everyN: 2, warmup: false });
    await service.capture(turn(1));
    const first = await service.capture(turn(2));
    expect(first.taskId).toBeDefined();
    await service.capture(turn(3));
    service.dispose();
    const before = timers.length;
    service.completeExtraction(first.taskId!, {});
    await tick();
    expect(tasks).toHaveLength(1);
    expect(timers).toHaveLength(before);
    db.close();
  });

  it('dispose 之后 armIdle、recoverPendingCaptures、flushSource 都不再动作', async () => {
    const { db, tasks, service, timers } = cadenceSetup({ everyN: 5, warmup: false });
    await service.capture(turn(1));
    const idle = timers[0].callback;
    service.dispose();
    const before = timers.length;
    idle();
    await tick();
    expect(tasks).toHaveLength(0);
    service.recoverPendingCaptures();
    await service.capture(turn(2));
    expect(timers).toHaveLength(before);
    expect(tasks).toHaveLength(0);
    db.close();
  });

  it('任务进行中另一个来源带来 extract:false 后，任务结束不再接着抽', async () => {
    const { db, tasks, service } = cadenceSetup({ everyN: 1, warmup: false });
    const first = await service.capture(from('a', 1));
    await service.capture(from('a', 2));
    await service.capture(from('b', 1, { extract: false }));
    service.completeExtraction(first.taskId!, {});
    await tick();
    expect(tasks).toHaveLength(1);
    db.close();
  });

  it('listPendingCaptures 新的优先，默认最多 20 条，limit 可调', () => {
    const { db, store } = setup();
    for (let i = 0; i < 25; i++) store.capture({ ...scope, sessionId: `s${i}` }, `session:s${i}`, `user: ${i}`, `fp${i}`);
    db.exec("UPDATE memory_captures SET updated_at = 1000 + CAST(substr(session_id, 2) AS INTEGER)");
    const all = store.listPendingCaptures();
    expect(all).toHaveLength(20);
    expect(all[0]).toMatchObject({ sessionId: 's24', source: 'session:s24' });
    expect(all[19].sessionId).toBe('s5');
    expect(store.listPendingCaptures(3).map((row) => row.sessionId)).toEqual(['s24', 's23', 's22']);
    expect(store.listPendingCaptures(100)).toHaveLength(25);
    store.commitCapture({ ...scope, sessionId: 's24' }, 'session:s24', 'fp24');
    expect(store.listPendingCaptures(1)[0].sessionId).toBe('s23');
    db.close();
  });

  it('补抽失败不静默：flushSource 和补抽循环都 console.warn 错误消息', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { db, store, service, live } = cadenceSetup({ everyN: 5, warmup: false, recoverDelayMs: 60_000 });
      await service.capture(turn(1));
      const idle = live()[0].callback;
      vi.spyOn(store, 'pendingCapture').mockImplementation(() => { throw new Error('db closed'); });
      idle();
      await tick();
      expect(warn).toHaveBeenCalledWith('[memory] 补抽失败', 'db closed');
      warn.mockClear();
      vi.spyOn(store, 'listPendingCaptures').mockImplementation(() => { throw new Error('no table'); });
      service.recoverPendingCaptures();
      live().find((timer) => timer.ms === 60_000)!.callback();
      await tick();
      expect(warn).toHaveBeenCalledWith('[memory] 补抽失败', 'no table');
      db.close();
    } finally {
      warn.mockRestore();
    }
  });

});

describe('MemoryService L2 预筛', () => {
  const sceneBody = (summary: string) => `-----META-START-----\nsummary: ${summary}\n-----META-END-----\n正文 ${summary}`;

  it('只把相关场景的正文放进 memory_scene，其余只给文件名和摘要', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('提交信息用中文'), source: 'scene:团队记忆-提交规范.md' });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('迁移放启动阶段'), source: 'scene:团队记忆-数据库.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '提交信息统一用中文', type: 'work_method', priority: 80, scene_name: '提交规范' }] });
    const sceneTask = tasks.find((task) => task.kind === 'memory_scene')!;
    const input = sceneTask.input as { scenes: Array<{ filename: string; summary: string; content?: string }> };
    expect(input.scenes).toHaveLength(2);
    expect(input.scenes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: '团队记忆-提交规范.md', content: expect.stringContaining('正文') }),
      { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
    ]));
    db.close();
  });

  it('落库时丢掉对没给正文的已有场景的写入和删除，新建和改相关场景照常', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('提交信息用中文'), source: 'scene:团队记忆-提交规范.md' });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('迁移放启动阶段'), source: 'scene:团队记忆-数据库.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '提交信息统一用中文', type: 'work_method', priority: 80 }] });
    const sceneTask = tasks.find((task) => task.kind === 'memory_scene')!;
    service.completeScene(sceneTask.id, { scenes: [
      { filename: '团队记忆-提交规范.md', action: 'write', content: sceneBody('提交信息用中文，已更新') },
      { filename: '团队记忆-数据库.md', action: 'delete' },
      { filename: '团队记忆-新场景.md', action: 'write', content: sceneBody('新的') },
    ] });
    const sources = db.prepare("SELECT source, content FROM memories WHERE level=2 ORDER BY source").all() as Array<{ source: string; content: string }>;
    expect(sources.map((row) => row.source)).toEqual(['scene:团队记忆-提交规范.md', 'scene:团队记忆-数据库.md', 'scene:团队记忆-新场景.md']);
    expect(sources[0].content).toContain('已更新');
    db.close();
  });

  it('服务重建后从存储的输入还原哪些场景给过正文（带 content 的条目），其余仍不许写和删', async () => {
    const { db, store, tasks, queue, service, layerSchedule } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('提交信息用中文'), source: 'scene:团队记忆-提交规范.md' });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('迁移放启动阶段'), source: 'scene:团队记忆-数据库.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '提交信息统一用中文', type: 'work_method', priority: 80 }] });
    const sceneTask = tasks.find((task) => task.kind === 'memory_scene')!;
    const reopened = new MemoryService({ store, queue: { ...queue, get: (id) => {
      const task = tasks.find((value) => value.id === id);
      return task ? taskResult(task) : undefined;
    } }, layerSchedule, extractCadence: { everyN: 1, warmup: false } });
    reopened.completeScene(sceneTask.id, { scenes: [
      { filename: '团队记忆-提交规范.md', action: 'write', content: sceneBody('提交信息用中文，已更新') },
      { filename: '团队记忆-数据库.md', action: 'delete' },
    ] });
    const rows = db.prepare('SELECT source, content FROM memories WHERE level=2 ORDER BY source').all() as Array<{ source: string; content: string }>;
    expect(rows.map((row) => row.source)).toEqual(['scene:团队记忆-提交规范.md', 'scene:团队记忆-数据库.md']);
    expect(rows[0].content).toContain('已更新');
    db.close();
  });
});
