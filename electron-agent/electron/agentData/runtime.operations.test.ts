import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { AgentDataStorage } from './storage';
import type { TaskPage, TaskView, DiagnosticReport, WorkbenchOverview, AuditPage } from './operationsContracts';
import type { WikiLibraryView, WikiPage, WikiSource } from './wikiContracts';

describe('operations management integration', () => {
  it('rechecks the old Code task inside creation after the last asynchronous target lookup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operations-late-retry-')); mkdirSync(join(root, 'project'));
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', jobRunners: { 'codegraph.sync': { run: async () => { throw new Error('fixture'); }, cancel: () => {} } } });
    const host = new AgentDataClient(await runtime.start()); let release!: (target: { exists: boolean; busy: boolean }) => void;
    try {
      const old = await host.request<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: join(root, 'project') });
      await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: old.id })).toMatchObject({ state: 'failed' }));
      const internals = runtime as unknown as { readTaskTarget: (job: unknown) => Promise<{ exists: boolean; busy: boolean }> };
      const original = internals.readTaskTarget.bind(runtime); let calls = 0;
      vi.spyOn(internals, 'readTaskTarget').mockImplementation((job) => ++calls === 4 ? new Promise((resolve) => { release = resolve; }) : original(job));
      const retry = runtime.requestAdmin('admin.tasks.retry', { source: 'user', id: old.id });
      const rejected = expect(retry).rejects.toThrow('TASK_RETRY_UNAVAILABLE');
      await vi.waitFor(() => expect(calls).toBe(4));
      await host.request('admin.jobs.remove', { id: old.id }); release({ exists: true, busy: false }); await rejected;
      await expect(host.request('admin.jobs.list')).resolves.toEqual([]);
    } finally { await host.close(); runtime.close(); await runtime.waitClosed(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); }
  });

  it('aggregates same-ID user/system tasks only in process and keeps system rows read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operations-runtime-'));
    const runtime = new AgentDataRuntime({ dataPath: join(root, 'data.db') }); const host = new AgentDataClient(await runtime.start());
    try {
      const job = await host.request<{ id: string }>('admin.jobs.create', { kind: 'unknown', workspace: '/repo' });
      const seed = new AgentDataStorage(join(root, 'data.db'));
      seed.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(job.id, 'memory_extract', 'queued', JSON.stringify({ transcript: 'private capture' }), 0, 1, 1); seed.close();
      const tasks = await runtime.requestAdmin<TaskPage>('admin.tasks.list', {});
      expect(tasks.items.map((task) => task.key).sort()).toEqual([`system:${job.id}`, `user:${job.id}`]);
      const system = await runtime.requestAdmin<TaskView>('admin.tasks.read', { source: 'system', id: job.id });
      expect(system).toMatchObject({ capabilities: { cancel: false, retry: false, remove: false } }); expect(system.progress).toBeUndefined();
      expect(JSON.stringify(system)).not.toContain('private capture');
      await expect(runtime.requestAdmin('admin.tasks.retry', { source: 'system', id: job.id })).rejects.toThrow();
      for (const name of ['admin.tasks.list', 'admin.tasks.read', 'admin.tasks.retry', 'admin.audit.query', 'admin.audit.export', 'admin.diagnostics.check', 'admin.overview']) {
        await expect(host.request(name, { admin: true })).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
      }
    } finally { await host.close(); runtime.close(); await runtime.waitClosed(); rmSync(root, { recursive: true, force: true }); }
  });

  it('retries Code with a new ID and original target, without a model preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'operations-code-')); const project = join(root, 'project'); mkdirSync(project);
    const run = vi.fn(async () => { throw new Error('fixture failure'); }); const model = vi.fn(async () => 'fixture/model');
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', wikiModelLabel: model, jobRunners: { 'codegraph.sync': { run, cancel: () => {} } } });
    const host = new AgentDataClient(await runtime.start());
    try {
      const job = await host.request<{ id: string }>('admin.jobs.create', { kind: 'codegraph.sync', workspace: project });
      await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: job.id })).toMatchObject({ state: 'failed' }));
      const preview = await runtime.requestAdmin('admin.tasks.previewRetry', { source: 'user', id: job.id }); expect(preview).toMatchObject({ callsModel: false });
      const retry = await runtime.requestAdmin<TaskView>('admin.tasks.retry', { source: 'user', id: job.id, kind: 'attack', workspace: '/else' });
      expect(retry.ref.id).not.toBe(job.id); expect(retry.retryOf).toBe(job.id); expect(retry.workspace).toBe(project);
      await expect(host.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'failed' });
      expect(run).toHaveBeenLastCalledWith(retry.ref.id, project, undefined); expect(model).not.toHaveBeenCalled();
    } finally { await host.close(); runtime.close(); await runtime.waitClosed(); rmSync(root, { recursive: true, force: true }); }
  });

  it('checks Wiki and builds a partial overview without rewriting files, SQL or invoking a model', async () => {
    const model = vi.fn(async () => 'fixture/model'), execute = vi.fn(async () => '# generated');
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', wikiModelLabel: model, executeServiceTask: execute }); await runtime.start();
    try {
      const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: 'Inspect', description: '', bindings: [] });
      const page = await runtime.requestAdmin<WikiPage>('wiki.pages.create', { kbId: kb.kbId, title: 'Guide', content: '# Original', sourceRefs: [] });
      const changed = readFileSync(page.path, 'utf8').replace('Original', 'External'); writeFileSync(page.path, changed);
      const report = await runtime.requestAdmin<DiagnosticReport>('admin.diagnostics.check');
      expect(report.items.some((item) => item.resource?.id === kb.kbId && item.state === 'action_required')).toBe(true);
      expect(readFileSync(page.path, 'utf8')).toBe(changed);
      const overview = await runtime.requestAdmin<WorkbenchOverview>('admin.overview', { userId: 'local' });
      expect(overview.libraries).toMatchObject({ total: 1, pages: 1 });
      expect(overview.recentPages[0]).toMatchObject({ kbId: kb.kbId, pageId: page.pageId });
      expect(model).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    } finally { runtime.close(); await runtime.waitClosed(); }
  });

  it('confirms the Wiki retry model and excludes newly added or deleted sources', async () => {
    const execute = vi.fn(async () => '# done');
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', wikiModelLabel: async () => 'fixture/model', executeServiceTask: execute });
    const host = new AgentDataClient(await runtime.start());
    try {
      const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: 'Retry', description: '', bindings: [] });
      const source = await runtime.requestAdmin<WikiSource>('wiki.sources.create', { kbId: kb.kbId, kind: 'manual', name: 'old.md', content: 'old' });
      const receipt = await runtime.requestAdmin<{ jobId: string }>('wiki.libraries.ingest', { kbId: kb.kbId });
      await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: receipt.jobId })).toMatchObject({ state: 'completed' }));
      await runtime.requestAdmin('wiki.sources.update', { kbId: kb.kbId, sourceId: source.sourceId, content: 'new', expected: source });
      // Seed a historical failed user task without running any publisher.
      const failed = await host.request<{ id: string }>('admin.jobs.create', { kind: 'unknown', workspace: '/seed' });
      await host.request('admin.jobs.fail', { id: failed.id, error: 'fixture' });
      const db = (runtime as unknown as { storage: AgentDataStorage }).storage.db;
      db.prepare('UPDATE agent_jobs SET kind=?,workspace=?,metadata=? WHERE id=?').run('wiki.ingest', '', JSON.stringify({ target: { type: 'wiki', id: kb.kbId }, payload: { kbId: kb.kbId, sourceIds: [source.sourceId] } }), failed.id);
      await runtime.requestAdmin('wiki.sources.create', { kbId: kb.kbId, kind: 'manual', name: 'later.md', content: 'later' });
      await expect(runtime.requestAdmin('admin.tasks.previewRetry', { source: 'user', id: failed.id })).resolves.toMatchObject({ sourceIds: [source.sourceId], targetCount: 1, model: 'fixture/model' });
      await expect(runtime.requestAdmin('admin.tasks.retry', { source: 'user', id: failed.id })).rejects.toThrow('MODEL_CONFIRMATION_REQUIRED');
      const retried = await runtime.requestAdmin<TaskView>('admin.tasks.retry', { source: 'user', id: failed.id, expectedModel: 'fixture/model' });
      await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: retried.ref.id })).toMatchObject({ state: 'completed' }));
      const list = await runtime.requestAdmin<AuditPage>('admin.audit.query', { resource: { type: 'wiki', id: kb.kbId } });
      expect(list.items.length).toBeGreaterThan(0); expect(execute).toHaveBeenCalledTimes(2);
    } finally { await host.close(); runtime.close(); await runtime.waitClosed(); }
  });
});
