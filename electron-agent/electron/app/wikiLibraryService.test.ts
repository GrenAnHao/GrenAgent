import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiFiles, wikiHash } from '../agentData/wikiFiles';
import { WikiLibraryStore, normalizeWikiWorkspace } from '../agentData/wikiLibraryStore';
import { WikiSourceStore } from '../agentData/wikiSourceStore';
import { WikiStore } from '../agentData/wikiStore';
import { JobStore } from '../agentData/jobStore';
import { AuditViewStore } from '../agentData/auditViewStore';
import { WikiLibraryService, type WikiLibraryServiceOptions } from './wikiLibraryService';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(overrides: Partial<WikiLibraryServiceOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-service-'));
  const workspace = join(root, 'project'); mkdirSync(workspace);
  const db = new DatabaseSync(join(root, 'fixture.sqlite'));
  const files = new WikiFiles(join(root, 'buckets'));
  const libraries = new WikiLibraryStore(db, files);
  const sources = new WikiSourceStore(db, files, libraries);
  const pages = new WikiStore(db, files.root, { libraries, sources });
  const jobs = new JobStore(db);
  const library = libraries.create({ name: '知识库', description: '', bindings: [workspace] });
  const runServiceTask = vi.fn(async () => '# Generated');
  const modelLabel = vi.fn(async () => 'fixture/model');
  const service = new WikiLibraryService({ libraries, sources, pages, jobs, runServiceTask, modelLabel, validateProject: async (value) => value, ...overrides });
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, db, files, libraries, library, kbId: library.kbId, sources, pages, jobs, service, runServiceTask, modelLabel };
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('WikiLibraryService', () => {
  it.each(['publish', 'fail', 'skip', 'recover'] as const)('snapshots the library name for actual ingest %s events before library deletion', async (action) => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId);
    if (action === 'fail') f.runServiceTask.mockRejectedValueOnce(new Error('fixture failure'));
    if (action === 'skip') f.sources.suppress(f.kbId, source.sourceId);
    if (action === 'recover') f.service.recover(); else await f.service.runIngest(jobId);
    await f.service.remove({ kind: 'library', kbId: f.kbId }, false);
    f.jobs.remove(jobId);
    const events = new AuditViewStore(f.db).query({ resource: { type: 'wiki', id: f.kbId } }).items;
    expect(events.find((event) => event.action === `wiki.ingest.${action}`)).toMatchObject({ resourceName: '知识库', detail: { resourceName: '知识库' } });
    expect(events.find((event) => event.action === 'job.remove')).toMatchObject({ resourceName: '知识库' });
  });

  it('records retry origin atomically with the resource name and advances counts only at real extraction boundaries', async () => {
    const response = deferred<unknown>(); const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const previous = f.jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: f.kbId }, payload: { kbId: f.kbId, sourceIds: [source.sourceId] } } });
    f.jobs.fail(previous.id, 'fixture previous failure');
    const receipt = await f.service.startIngest(f.kbId, [source.sourceId], undefined, 'fixture/model', previous.id);
    expect(f.jobs.get(receipt.jobId)?.metadata).toMatchObject({ retryOf: previous.id, resourceName: '知识库', stage: '已选择资料', processed: 0, total: 1 });
    expect(f.jobs.audit().find((event) => event.action === 'job.create' && event.detail.id === receipt.jobId)?.detail).toMatchObject({ metadata: { retryOf: previous.id } });
    const run = f.service.runIngest(receipt.jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(f.jobs.get(receipt.jobId)?.metadata).toMatchObject({ stage: '正在生成', processed: 0, total: 1 });
    response.resolve('# Generated'); await run;
    expect(f.jobs.get(receipt.jobId)?.metadata).toMatchObject({ stage: '已完成', processed: 1, total: 1, resourceName: '知识库' });
    expect(f.jobs.audit().filter((event) => event.action === 'job.stage').map((event) => event.detail.stage)).toEqual(expect.arrayContaining(['已选择资料', '正在读取', '正在生成', '正在发布', '已处理', '已完成']));
  });

  it.each(['removed', 'completed', 'retargeted'] as const)('revalidates a retry origin that was %s during the final model lookup', async (change) => {
    const selecting = deferred<string>(); const f = fixture({ modelLabel: () => selecting.promise });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const previous = f.jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: f.kbId }, payload: { kbId: f.kbId, sourceIds: [source.sourceId] } } });
    f.jobs.fail(previous.id, 'fixture failure');
    const receipt = f.service.startIngest(f.kbId, [source.sourceId], undefined, 'fixture/model', previous.id);
    if (change === 'removed') f.jobs.remove(previous.id);
    else if (change === 'completed') f.db.prepare("UPDATE agent_jobs SET state='completed' WHERE id=?").run(previous.id);
    else f.db.prepare('UPDATE agent_jobs SET metadata=? WHERE id=?').run(JSON.stringify({ ...previous.metadata, target: { type: 'wiki', id: 'other-kb' } }), previous.id);
    selecting.resolve('fixture/model');
    await expect(receipt).rejects.toThrow('TASK_RETRY_UNAVAILABLE');
    expect(f.jobs.list().filter((job) => job.id !== previous.id)).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS count FROM wiki_ingest_runs').get()).toEqual({ count: 0 });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('rejects retry sources outside the original payload before granting any permits', async () => {
    const f = fixture();
    const first = await f.service.addSource(f.kbId, { kind: 'manual', name: 'first.md', content: '# First' });
    const second = await f.service.addSource(f.kbId, { kind: 'manual', name: 'second.md', content: '# Second' });
    const previous = f.jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: f.kbId }, payload: { kbId: f.kbId, sourceIds: [first.sourceId] } } });
    f.jobs.cancel(previous.id);
    await expect(f.service.startIngest(f.kbId, [second.sourceId], undefined, 'fixture/model', previous.id)).rejects.toThrow('TASK_RETRY_UNAVAILABLE');
    expect(f.jobs.list()).toHaveLength(1);
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('persists cancellation intent for direct and deletion-triggered requests without premature terminal state', async () => {
    const f = fixture();
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId);
    await f.service.remove({ kind: 'library', kbId: f.kbId }, true);
    expect(f.jobs.get(jobId)).toMatchObject({ state: 'pending', metadata: { cancellationRequested: true } });
    expect(f.jobs.audit().filter((event) => event.action === 'job.cancel_requested')).toHaveLength(1);
    expect(f.service.requestCancel(jobId)).toBe(true);
    expect(f.jobs.audit().filter((event) => event.action === 'job.cancel_requested')).toHaveLength(1);
    await f.service.runIngest(jobId);
    expect(f.jobs.get(jobId)?.state).toBe('cancelled');
    expect(f.runServiceTask).not.toHaveBeenCalled();
  });

  it('creates independent same-name text sources and reindexes without model work', async () => {
    const f = fixture();
    const first = await f.service.addSource(f.kbId, { kind: 'manual', name: 'same.md', content: '# First' });
    const second = await f.service.addSource(f.kbId, { kind: 'upload', name: 'same.md', content: '# Second' });
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(f.sources.readSnapshot(f.kbId, first)).toBe('# First');
    expect(f.sources.readSnapshot(f.kbId, second)).toBe('# Second');
    await expect(f.service.reindex(f.kbId)).resolves.toMatchObject({ pages: 0 });
    expect(f.runServiceTask).not.toHaveBeenCalled();
    expect(f.modelLabel).not.toHaveBeenCalled();
    expect(f.jobs.list()).toEqual([]);
  });

  it('previews a bound project file read-only and rejects changed bytes on import', async () => {
    const f = fixture();
    const path = join(f.workspace, 'notes.md'); writeFileSync(path, '# Before\n');
    const preview = await f.service.previewImport(f.kbId, f.workspace, 'notes.md');
    expect(preview).toEqual({ projectWorkspace: normalizeWikiWorkspace(f.workspace), relativePath: 'notes.md', name: 'notes.md', contentHash: wikiHash('# Before\n'), bytes: 9 });
    expect(f.sources.list(f.kbId)).toEqual([]);
    writeFileSync(path, '# After\n');
    await expect(f.service.addSource(f.kbId, { kind: 'project', projectWorkspace: f.workspace, relativePath: 'notes.md', expectedContentHash: preview.contentHash })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.sources.list(f.kbId)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('# After\n');
    const current = await f.service.previewImport(f.kbId, f.workspace, 'notes.md');
    const imported = await f.service.addSource(f.kbId, { kind: 'project', projectWorkspace: f.workspace, relativePath: 'notes.md', expectedContentHash: current.contentHash });
    expect(f.sources.readSnapshot(f.kbId, imported)).toBe('# After\n');
    expect(f.modelLabel).not.toHaveBeenCalled();
  });

  it('rechecks binding after asynchronous project validation', async () => {
    const validating = deferred<string>();
    const f = fixture({ validateProject: () => validating.promise });
    writeFileSync(join(f.workspace, 'notes.md'), '# Source');
    const preview = f.service.previewImport(f.kbId, f.workspace, 'notes.md');
    f.libraries.update(f.kbId, { name: f.library.name, description: '', bindings: [] }, f.library.revision);
    validating.resolve(f.workspace);
    await expect(preview).rejects.toThrow(/access|bound|binding/i);
    expect(f.sources.list(f.kbId)).toEqual([]);
  });

  it('rejects unbound projects, unsafe paths, and junction escapes without changing originals', async () => {
    const f = fixture();
    const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.md'), '# Original');
    symlinkSync(outside, join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.service.previewImport(f.kbId, outside, 'secret.md')).rejects.toThrow(/access|bound|binding/i);
    for (const path of ['../outside/secret.md', 'linked/secret.md', 'C:secret.md', 'notes.md:stream', 'CON.md', 'source.js']) {
      await expect(f.service.previewImport(f.kbId, f.workspace, path)).rejects.toThrow();
    }
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('# Original');
    expect(f.sources.list(f.kbId)).toEqual([]);
  });

  it('previews actual pending IDs without mutations, then atomically enqueues their snapshots', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    await expect(f.service.previewIngest(f.kbId)).resolves.toEqual({ sourceIds: [source.sourceId], targetCount: 1, model: 'fixture/model' });
    expect(f.jobs.list()).toEqual([]);
    const receipt = await f.service.startIngest(f.kbId, undefined, undefined, 'fixture/model');
    expect(receipt).toMatchObject({ targetCount: 1, model: 'fixture/model' });
    expect(f.jobs.get(receipt.jobId)).toMatchObject({ kind: 'wiki.ingest', workspace: '', state: 'pending', metadata: { target: { type: 'wiki', id: f.kbId }, payload: { kbId: f.kbId, sourceIds: [source.sourceId] } } });
    const run = f.db.prepare('SELECT items,model FROM wiki_ingest_runs WHERE job_id=?').get(receipt.jobId)!;
    expect(JSON.parse(String(run.items))).toMatchObject([{ sourceId: source.sourceId, sourceRevision: 1, contentHash: source.contentHash, permit: { expected: null } }]);
    expect(f.libraries.activeTasks({ kind: 'source', kbId: f.kbId, sourceId: source.sourceId })).toMatchObject([{ taskSource: 'agent_job', taskId: receipt.jobId, canCancel: true }]);
    expect(f.runServiceTask).not.toHaveBeenCalled();
    await expect(f.service.startIngest(f.kbId)).rejects.toThrow(/active|running/i);
  });

  it('rejects unavailable or changed models and zero targets without creating fake jobs', async () => {
    const f = fixture();
    await expect(f.service.startIngest(f.kbId)).rejects.toThrow('NO_PENDING_SOURCES');
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    f.modelLabel.mockResolvedValueOnce('');
    await expect(f.service.startIngest(f.kbId)).rejects.toThrow('MODEL_UNAVAILABLE');
    await expect(f.service.startIngest(f.kbId, [source.sourceId], undefined, 'other/model')).rejects.toThrow('MODEL_CHANGED');
    const foreign = f.libraries.create({ name: 'Other', description: '', bindings: [] });
    await expect(f.service.startIngest(foreign.kbId, [source.sourceId])).rejects.toThrow(/source|belong/i);
    expect(f.jobs.list()).toEqual([]);
    expect(f.runServiceTask).not.toHaveBeenCalled();
  });

  it('rechecks library lifecycle after model selection and rolls back all enqueue writes on failure', async () => {
    const selecting = deferred<string>();
    const f = fixture({ modelLabel: () => selecting.promise });
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const receipt = f.service.startIngest(f.kbId);
    f.libraries.beginDelete({ kind: 'library', kbId: f.kbId });
    selecting.resolve('fixture/model');
    await expect(receipt).rejects.toThrow(/active|delet/i);
    expect(f.jobs.list()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS count FROM wiki_ingest_runs').get()).toEqual({ count: 0 });

    const other = f.libraries.create({ name: 'Other', description: '', bindings: [] });
    const source = await f.service.addSource(other.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    f.sources.suppress(other.kbId, source.sourceId);
    f.db.exec("CREATE TRIGGER reject_wiki_target BEFORE INSERT ON wiki_task_targets BEGIN SELECT RAISE(ABORT, 'fixture target failure'); END");
    await expect(f.service.startIngest(other.kbId, [source.sourceId], [source.sourceId])).rejects.toThrow('fixture target failure');
    expect(f.jobs.list()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS count FROM wiki_ingest_runs').get()).toEqual({ count: 0 });
    expect(f.sources.get(other.kbId, source.sourceId)?.generationSuppressed).toBe(true);
  });

  it('confirms a queued cancellation without invoking a model', async () => {
    const f = fixture();
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId);
    expect(f.service.requestCancel(jobId)).toBe(true);
    expect(f.jobs.get(jobId)?.state).toBe('pending');
    await f.service.runIngest(jobId);
    expect(f.jobs.get(jobId)?.state).toBe('cancelled');
    expect(f.runServiceTask).not.toHaveBeenCalled();
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('releases the actual writer lease even when starting the job throws', async () => {
    const f = fixture();
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId);
    f.db.exec("CREATE TRIGGER reject_job_start BEFORE UPDATE OF state ON agent_jobs WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END");
    await f.service.runIngest(jobId);
    expect(f.jobs.get(jobId)).toMatchObject({ state: 'failed', error: 'fixture start failure' });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
    expect(f.runServiceTask).not.toHaveBeenCalled();
  });

  it('recovers interrupted ingests without model calls while preserving still-active system writer leases', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId);
    f.jobs.start(jobId); f.sources.markProcessing(f.kbId, source.sourceId, source.revision);
    f.db.exec("CREATE TABLE service_tasks (id TEXT PRIMARY KEY,status TEXT NOT NULL); INSERT INTO service_tasks VALUES('recovered-system','running')");
    f.libraries.recordTask({ taskSource: 'service_task', taskId: 'recovered-system', kbId: f.kbId, sourceId: source.sourceId, pageId: source.generatedPageId, active: true, canCancel: false });
    f.service.recover();
    expect(f.jobs.get(jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('WIKI_INGEST_INTERRUPTED') });
    expect(f.sources.get(f.kbId, source.sourceId)).toMatchObject({ status: 'pending' });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toMatchObject([{ taskSource: 'service_task', taskId: 'recovered-system', active: true }]);
    await expect(f.service.startIngest(f.kbId)).rejects.toThrow(/active/i);
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, true)).resolves.toMatchObject({ state: 'waiting' });
    f.db.prepare("UPDATE service_tasks SET status='completed' WHERE id=?").run('recovered-system');
    f.libraries.recoverTasks();
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, true)).resolves.toEqual({ state: 'deleted' });
    expect(f.runServiceTask).not.toHaveBeenCalled();
  });

  it('recovers requested cancellation from persisted runs without changing a newer source revision', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId); f.service.requestCancel(jobId);
    const updated = f.sources.updateText(f.kbId, source.sourceId, '# New revision', source);
    f.service.recover();
    expect(f.jobs.get(jobId)?.state).toBe('cancelled');
    expect(f.sources.get(f.kbId, source.sourceId)).toEqual(updated);
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
    expect(f.runServiceTask).not.toHaveBeenCalled();
  });

  it('runs once per job, records actual system writer leases, and incrementally skips processed sources', async () => {
    const response = deferred<unknown>();
    const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const receipt = await f.service.startIngest(f.kbId);
    const first = f.service.runIngest(receipt.jobId); const second = f.service.runIngest(receipt.jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual(expect.arrayContaining([expect.objectContaining({ taskSource: 'service_task', canCancel: false, sourceId: source.sourceId, pageId: source.generatedPageId })]));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wiki_page_generate', capabilities: ['llm_completion'], input: { kbId: f.kbId, sourceId: source.sourceId, sourceRevision: 1, expectedModel: 'fixture/model', sourcePath: 'notes.md', source: '# Source' } }));
    response.resolve('# Generated'); await Promise.all([first, second]);
    expect(f.jobs.get(receipt.jobId)).toMatchObject({ state: 'completed', progress: 100 });
    expect(f.sources.get(f.kbId, source.sourceId)).toMatchObject({ status: 'succeeded', processedHash: source.contentHash });
    expect(f.service.summary(receipt.jobId)).toEqual({ succeeded: 1, skipped: 0, failed: 0 });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
    await expect(f.service.startIngest(f.kbId)).rejects.toThrow('NO_PENDING_SOURCES');
  });

  it('confirms cancellation only after running generation stops and never publishes its late output', async () => {
    const response = deferred<unknown>(); const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId); const run = f.service.runIngest(jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(f.service.requestCancel(jobId)).toBe(true);
    expect(f.jobs.get(jobId)?.state).toBe('running');
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toHaveLength(2);
    response.resolve('# Late'); await run;
    expect(f.jobs.get(jobId)?.state).toBe('cancelled');
    expect(f.pages.listByLibrary(f.kbId)).toEqual([]);
    expect(f.sources.get(f.kbId, source.sourceId)).toMatchObject({ status: 'pending', processedHash: undefined });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('does not mark a source revision edited during generation as processed', async () => {
    const response = deferred<unknown>(); const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Before' });
    const { jobId } = await f.service.startIngest(f.kbId); const run = f.service.runIngest(jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const updated = f.sources.updateText(f.kbId, source.sourceId, '# After', source);
    response.resolve('# Obsolete'); await run;
    expect(f.sources.get(f.kbId, source.sourceId)).toEqual(updated);
    expect(f.pages.listByLibrary(f.kbId)).toEqual([]);
    expect(f.service.summary(jobId)).toEqual({ succeeded: 0, skipped: 1, failed: 0 });
    expect(f.jobs.get(jobId)?.state).toBe('completed');
  });

  it('does not publish when immutable source bytes are modified during generation', async () => {
    const response = deferred<unknown>(); const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Original' });
    const { jobId } = await f.service.startIngest(f.kbId); const run = f.service.runIngest(jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    writeFileSync(f.files.filePathAt(f.library, source.snapshotPath), '# Tampered');
    response.resolve('# From old snapshot'); await run;
    expect(f.pages.listByLibrary(f.kbId)).toEqual([]);
    expect(f.jobs.get(jobId)?.state).toBe('failed');
    expect(f.sources.get(f.kbId, source.sourceId)?.processedHash).toBeUndefined();
    expect(f.service.summary(jobId)).toEqual({ succeeded: 0, skipped: 0, failed: 1 });
  });

  it('rolls back page publication and success marking if its audit cannot be persisted', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Original' });
    const { jobId } = await f.service.startIngest(f.kbId);
    f.db.exec("CREATE TRIGGER reject_publish_audit BEFORE INSERT ON agent_audit WHEN NEW.action='wiki.ingest.publish' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    await f.service.runIngest(jobId);
    expect(f.pages.listByLibrary(f.kbId)).toEqual([]);
    expect(f.sources.get(f.kbId, source.sourceId)).toMatchObject({ status: 'failed', processedHash: undefined });
    expect(f.service.summary(jobId)).toEqual({ succeeded: 0, skipped: 0, failed: 1 });
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('counts and audits locked skips while leaving changed sources pending for a later unlock', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Before' });
    const first = await f.service.startIngest(f.kbId); await f.service.runIngest(first.jobId);
    const page = f.pages.readById(f.kbId, source.generatedPageId)!;
    f.pages.setLocked(f.kbId, page.pageId, true, page);
    f.sources.updateText(f.kbId, source.sourceId, '# After', source);
    const second = await f.service.startIngest(f.kbId); await f.service.runIngest(second.jobId);
    expect(f.runServiceTask).toHaveBeenCalledTimes(1);
    expect(f.service.summary(second.jobId)).toEqual({ succeeded: 0, skipped: 1, failed: 0 });
    expect(f.sources.pending(f.kbId)).toHaveLength(1);
    expect(f.jobs.audit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'wiki.ingest.skip', detail: expect.objectContaining({ jobId: second.jobId, reason: 'locked' }) })]));
  });

  it('keeps successful pages when another source fails and reports a durable partial summary', async () => {
    const execute = vi.fn().mockResolvedValueOnce('# Success').mockRejectedValueOnce(new Error('fixture generation failure'));
    const f = fixture({ runServiceTask: execute });
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'same.md', content: '# First' });
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'same.md', content: '# Second' });
    const { jobId } = await f.service.startIngest(f.kbId); await f.service.runIngest(jobId);
    expect(f.jobs.get(jobId)?.state).toBe('failed');
    expect(f.pages.listByLibrary(f.kbId)).toHaveLength(1);
    expect(f.service.summary(jobId)).toEqual({ succeeded: 1, skipped: 0, failed: 1 });
    expect(f.sources.pending(f.kbId)).toHaveLength(1);
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toEqual([]);
  });

  it('waits for real writers after deletion begins and prevents late output from reviving the library', async () => {
    const response = deferred<unknown>(); const execute = vi.fn(() => response.promise);
    const f = fixture({ runServiceTask: execute });
    await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    const { jobId } = await f.service.startIngest(f.kbId); const run = f.service.runIngest(jobId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const preview = await f.service.previewDelete({ kind: 'library', kbId: f.kbId });
    expect(preview).toMatchObject({ name: '知识库', sources: 1, pages: 0, bindings: f.library.bindings });
    const result = await f.service.remove({ kind: 'library', kbId: f.kbId }, true);
    expect(result).toMatchObject({ state: 'waiting', tasks: expect.arrayContaining([expect.objectContaining({ taskSource: 'service_task', canCancel: false })]) });
    expect(f.libraries.get(f.kbId)?.lifecycle).toBe('deleting');
    expect(f.jobs.get(jobId)?.state).toBe('running');
    response.resolve('# Late'); await run;
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, true)).resolves.toEqual({ state: 'deleted' });
    expect(f.libraries.get(f.kbId)).toMatchObject({ lifecycle: 'deleted', bindings: [] });
    expect(f.db.prepare('SELECT count(*) AS count FROM wiki_documents WHERE kb_id=?').get(f.kbId)).toEqual({ count: 0 });
  });

  it('only explicitly regenerates suppressed sources and does not clear suppression during preview', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Source' });
    f.sources.suppress(f.kbId, source.sourceId);
    await expect(f.service.previewIngest(f.kbId)).resolves.toMatchObject({ sourceIds: [], targetCount: 0 });
    await expect(f.service.previewIngest(f.kbId, [source.sourceId], [source.sourceId])).resolves.toMatchObject({ sourceIds: [source.sourceId], targetCount: 1 });
    expect(f.sources.get(f.kbId, source.sourceId)?.generationSuppressed).toBe(true);
    const { jobId } = await f.service.startIngest(f.kbId, [source.sourceId], [source.sourceId]);
    await f.service.runIngest(jobId);
    expect(f.sources.get(f.kbId, source.sourceId)).toMatchObject({ generationSuppressed: false, status: 'succeeded' });
  });

  it('requests legacy cancellation only for cancellable user jobs and still waits for their real leases', async () => {
    const cancelJob = vi.fn(); const f = fixture({ cancelJob });
    const legacy = f.jobs.create({ kind: 'wiki.sync', workspace: f.workspace }); f.jobs.start(legacy.id);
    f.libraries.recordTask({ taskSource: 'agent_job', taskId: legacy.id, kbId: f.kbId, active: true, canCancel: true });
    f.libraries.recordTask({ taskSource: 'service_task', taskId: 'system-fixture', kbId: f.kbId, active: true, canCancel: false });
    expect(f.service.requestCancel(legacy.id)).toBe(false);
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, true)).resolves.toMatchObject({ state: 'waiting' });
    expect(cancelJob).toHaveBeenCalledExactlyOnceWith(legacy.id);
    expect(f.jobs.get(legacy.id)?.state).toBe('running');
    expect(f.libraries.activeTasks({ kind: 'library', kbId: f.kbId })).toHaveLength(2);
  });

  it('previews a deleting library from persisted metadata and finalizes after its writer settles', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Original' });
    f.pages.createManual(f.kbId, { title: 'Saved page', content: '# Saved', sourceRefs: [{ sourceId: source.sourceId, revision: source.revision }] });
    const job = f.jobs.create({ kind: 'wiki.sync', workspace: f.workspace });
    f.libraries.recordTask({ taskSource: 'agent_job', taskId: job.id, kbId: f.kbId, active: true, canCancel: true });
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, false)).resolves.toMatchObject({ state: 'waiting' });
    const before = f.libraries.get(f.kbId)!;
    await expect(f.service.previewDelete({ kind: 'library', kbId: f.kbId })).resolves.toMatchObject({ name: f.library.name, revision: before.revision, sources: 1, pages: 1 });
    expect(f.libraries.get(f.kbId)).toEqual(before);
    f.libraries.settleTask('agent_job', job.id);
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, false)).resolves.toEqual({ state: 'deleted' });
  });

  it.each(['source', 'page'] as const)('previews a deleting %s using persisted metadata', async (kind) => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Original' });
    const page = f.pages.createManual(f.kbId, { title: 'Saved page', content: '# Saved', sourceRefs: [{ sourceId: source.sourceId, revision: source.revision }] });
    const target = kind === 'source' ? { kind, kbId: f.kbId, sourceId: source.sourceId } : { kind, kbId: f.kbId, pageId: page.pageId };
    f.libraries.beginDelete(target);
    await expect(f.service.previewDelete(target)).resolves.toMatchObject({ name: kind === 'source' ? source.name : page.title, revision: kind === 'source' ? source.revision : page.revision, sources: 1, pages: 1 });
    await expect(f.service.remove(target, false)).resolves.toEqual({ state: 'deleted' });
  });

  it('can preview and remove a library with damaged Markdown without scanning or changing its index', async () => {
    const f = fixture();
    const source = await f.service.addSource(f.kbId, { kind: 'manual', name: 'notes.md', content: '# Original' });
    const page = f.pages.createManual(f.kbId, { title: 'Saved page', content: '# Saved', sourceRefs: [{ sourceId: source.sourceId, revision: source.revision }] });
    writeFileSync(page.path, '---\nlocked: invalid\n---\nDamaged');
    expect(() => f.pages.readById(f.kbId, page.pageId)).toThrow();
    const before = f.db.prepare('SELECT * FROM wiki_documents WHERE kb_id=?').all(f.kbId);
    await expect(f.service.previewDelete({ kind: 'library', kbId: f.kbId })).resolves.toMatchObject({ name: f.library.name, sources: 1, pages: 1 });
    await expect(f.service.previewDelete({ kind: 'source', kbId: f.kbId, sourceId: source.sourceId })).resolves.toMatchObject({ name: source.name, sources: 1, pages: 1 });
    await expect(f.service.previewDelete({ kind: 'page', kbId: f.kbId, pageId: page.pageId })).resolves.toMatchObject({ name: page.title, revision: page.revision, sources: 1, pages: 1 });
    expect(f.db.prepare('SELECT * FROM wiki_documents WHERE kb_id=?').all(f.kbId)).toEqual(before);
    expect(readFileSync(page.path, 'utf8')).toBe('---\nlocked: invalid\n---\nDamaged');
    await expect(f.service.remove({ kind: 'library', kbId: f.kbId }, false)).resolves.toEqual({ state: 'deleted' });
  });
});
