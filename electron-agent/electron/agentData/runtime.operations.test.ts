import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { AgentDataStorage } from './storage';
import type { TaskPage, TaskView } from './operationsContracts';

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
});
