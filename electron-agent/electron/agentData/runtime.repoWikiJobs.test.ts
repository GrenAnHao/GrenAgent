import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleAgentData, type AssembledAgentData } from '../agentDataProcess/assemble';
import { AgentDataClient } from './client';
import { JobStore, type Job } from './jobStore';
import { AgentDataStorage } from './storage';
import type { TaskDetail } from './operationsContracts';

const payload = { projectId: 'project-a', language: 'zh', target: 'wiki' as const, force: false, confirmExternal: true as const };

describe('Repo Wiki durable AgentData generation jobs', () => {
  const dirs: string[] = [];
  const hosts: AssembledAgentData[] = [];
  afterEach(async () => {
    for (const host of hosts.reverse()) await host.close();
    hosts.length = 0;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'repo-wiki-jobs-'));
    dirs.push(dir);
    const workspace = join(dir, 'repo');
    mkdirSync(workspace);
    return { dataPath: join(dir, 'data.db'), workspace };
  }

  async function start(dataPath: string, failFirst = false) {
    const started: Array<{ id: string; workspace: string; payload: unknown }> = [];
    const cancelled: Array<{ id: string; pause?: boolean }> = [];
    const releases = new Map<string, (result: { cancelled?: boolean }) => void>();
    const host = assembleAgentData({
      dataPath,
      model: { describe: async () => 'provider/model', complete: async () => 'unused' },
      codeGraph: { projects: () => [], status: async () => ({}) as never, search: async () => ({}) as never, call: async () => ({}) as never, runSync: async () => {}, cancelSync: async () => {}, close: async () => {} },
      resolveSession: async () => true,
      methods: {
        'turn.start': async () => null,
        'permission.authorize': async () => null,
        'mcp.state.publish': async () => null,
        'repoWiki.run': async (p) => {
          started.push(p as typeof started[number]);
          if (failFirst && started.length === 1) throw new Error('MODEL_UNAVAILABLE: test provider is offline');
          return new Promise<{ cancelled?: boolean }>((resolve) => releases.set(String(p.id), resolve));
        },
        'repoWiki.cancel': async (p) => {
          cancelled.push(p as typeof cancelled[number]);
          releases.get(String(p.id))?.({ cancelled: true });
          return null;
        },
      },
    });
    hosts.push(host);
    await host.runtime.start();
    return { ...host, started, cancelled, finish: (id: string) => releases.get(id)?.({}) };
  }

  async function state(host: AssembledAgentData, id: string) {
    return host.runtime.requestAdmin<Job>('admin.jobs.get', { id });
  }

  // Losing payload fields, starting twice, or accepting a socket-created job must fail this test.
  it('persists confirmed parameters before dispatch and deduplicates the same namespace', async () => {
    const paths = directory(), host = await start(paths.dataPath);
    const job = await host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    const duplicate = await host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    expect(duplicate.id).toBe(job.id);
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('running'));
    expect(host.started).toEqual([{ id: job.id, workspace: paths.workspace, payload }]);
    expect((await state(host, job.id)).metadata).toMatchObject({ payload, target: { type: 'repoWiki', id: paths.workspace } });
    const client = new AgentDataClient(host.runtime.getEndpoint()!);
    await expect(client.request('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } })).rejects.toThrow(/only through the application/);
    await expect(client.request('repoWiki.run', { id: 'rogue', workspace: paths.workspace, payload })).rejects.toThrow(/unknown method/);
    await client.close();
    host.finish(job.id);
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('completed'));
  });

  // Restart must reuse the stored task ID and retain its last progress, while terminal jobs stay terminal.
  it('resumes unfinished jobs after shutdown without replaying completed work', async () => {
    const paths = directory(), first = await start(paths.dataPath);
    const completed = await first.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    await vi.waitFor(async () => expect((await state(first, completed.id)).state).toBe('running'));
    first.finish(completed.id);
    await vi.waitFor(async () => expect((await state(first, completed.id)).state).toBe('completed'));
    const active = await first.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    await vi.waitFor(async () => expect((await state(first, active.id)).state).toBe('running'));
    await first.runtime.requestAdmin('admin.jobs.stage', { id: active.id, stage: '正在生成', progress: 42, currentPage: 'architecture.md', message: '已生成 2 / 5 页', processed: 2, total: 5 });
    await first.close();
    expect(first.cancelled).toEqual([{ id: active.id, pause: true }]);

    const second = await start(paths.dataPath);
    await vi.waitFor(() => expect(second.started).toHaveLength(1));
    expect(second.started[0]).toEqual({ id: active.id, workspace: paths.workspace, payload });
    expect(await state(second, active.id)).toMatchObject({ state: 'running', progress: 42, metadata: { currentPage: 'architecture.md', processed: 2, total: 5 } });
    const detail = await second.runtime.requestAdmin<TaskDetail>('admin.tasks.read', { source: 'user', id: active.id });
    expect(detail).toMatchObject({ label: 'Repo Wiki 文档生成', progress: 42, currentPage: 'architecture.md', message: '已生成 2 / 5 页', resource: { type: 'repoWiki', id: paths.workspace }, capabilities: { cancel: true } });
    expect(detail.inputSummary).toMatchObject({ projectId: 'project-a', language: 'zh', target: 'wiki' });
    expect((await state(second, completed.id)).state).toBe('completed');
    second.finish(active.id);
    await vi.waitFor(async () => expect((await state(second, active.id)).state).toBe('completed'));
  });

  // A persisted cancellation intent must never restart the model on application recovery.
  it('restores a cancellation request without restarting generation', async () => {
    const paths = directory(), storage = new AgentDataStorage(paths.dataPath);
    storage.migrate();
    const jobs = new JobStore(storage.db);
    const job = jobs.create({ kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    jobs.start(job.id);
    jobs.requestCancellation(job.id);
    storage.close();
    const host = await start(paths.dataPath);
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('cancelled'));
    expect(host.started).toEqual([]);
    expect(host.cancelled).toEqual([{ id: job.id }]);
    expect(await host.runtime.requestAdmin('admin.tasks.read', { source: 'user', id: job.id })).toMatchObject({ cancellationRequested: false, capabilities: { cancel: false, retry: true, remove: true } });
  });

  // Retry must retain the original generation contract, instead of creating a job with only workspace.
  it('retries a failed generation with the original payload and a model-aware preview', async () => {
    const paths = directory(), host = await start(paths.dataPath, true);
    const job = await host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload: { ...payload, target: 'cards', force: true } } });
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('failed'));
    expect(await host.runtime.requestAdmin('admin.tasks.previewRetry', { source: 'user', id: job.id })).toMatchObject({ callsModel: true, model: 'provider/model' });
    await expect(host.runtime.requestAdmin('admin.tasks.retry', { source: 'user', id: job.id })).rejects.toThrow('MODEL_CONFIRMATION_REQUIRED');
    await expect(host.runtime.requestAdmin('admin.tasks.retry', { source: 'user', id: job.id, expectedModel: 'other/model' })).rejects.toThrow('MODEL_CHANGED');
    expect(host.started).toHaveLength(1);
    const retried = await host.runtime.requestAdmin<TaskDetail>('admin.tasks.retry', { source: 'user', id: job.id, expectedModel: 'provider/model' });
    await vi.waitFor(() => expect(host.started).toHaveLength(2));
    expect(host.started[1].payload).toEqual({ ...payload, target: 'cards', force: true });
    expect(await state(host, retried.ref.id)).toMatchObject({ metadata: { retryOf: job.id, payload: { ...payload, target: 'cards', force: true } } });
    host.finish(retried.ref.id);
    await vi.waitFor(async () => expect((await state(host, retried.ref.id)).state).toBe('completed'));
  });

  // Cancellation must end the durable task only after the execution callback confirms it stopped.
  it('cancels a running job and keeps its last page progress visible', async () => {
    const paths = directory(), host = await start(paths.dataPath);
    const job = await host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('running'));
    await host.runtime.requestAdmin('admin.jobs.stage', { id: job.id, stage: '正在生成', progress: 30, currentPage: 'overview.md' });
    await host.runtime.requestAdmin('admin.jobs.cancel', { id: job.id });
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('cancelled'));
    expect(host.cancelled).toEqual([{ id: job.id }]);
    expect(await host.runtime.requestAdmin('admin.tasks.read', { source: 'user', id: job.id })).toMatchObject({ status: 'cancelled', progress: 30, currentPage: 'overview.md', cancellationRequested: false, capabilities: { retry: true, remove: true } });
  });

  // A cancellation submitted before the main execution callback exists must prevent its later dispatch.
  it('does not dispatch a job cancelled while its executor is starting', async () => {
    const paths = directory(), host = await start(paths.dataPath);
    const creating = host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    const [saved] = await host.runtime.requestAdmin<Job[]>('admin.jobs.list');
    await host.runtime.requestAdmin('admin.jobs.cancel', { id: saved.id });
    await creating;
    await vi.waitFor(async () => expect((await state(host, saved.id)).state).toBe('cancelled'));
    expect(host.started).toEqual([]);
    await host.close();
    const restarted = await start(paths.dataPath);
    expect(restarted.started).toEqual([]);
    expect((await state(restarted, saved.id)).state).toBe('cancelled');
  });

  // App shutdown must not turn a user's in-flight cancel request into automatic model work on startup.
  it('preserves cancellation intent when application shutdown overlaps cancellation', async () => {
    const paths = directory(), first = await start(paths.dataPath);
    const job = await first.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    await vi.waitFor(() => expect(first.started).toHaveLength(1));
    const cancelling = first.runtime.requestAdmin('admin.jobs.cancel', { id: job.id });
    await Promise.all([cancelling, first.close()]);
    const second = await start(paths.dataPath);
    await vi.waitFor(async () => expect((await state(second, job.id)).state).toBe('cancelled'));
    expect(second.started).toEqual([]);
  });

  // Closing the app during executor setup pauses the request instead of starting a late main-process run.
  it('pauses startup dispatch on shutdown and resumes the same request on the next start', async () => {
    const paths = directory(), first = await start(paths.dataPath);
    const creating = first.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload } });
    const [saved] = await first.runtime.requestAdmin<Job[]>('admin.jobs.list');
    await first.close();
    await creating;
    expect(first.started).toEqual([]);
    const second = await start(paths.dataPath);
    await vi.waitFor(() => expect(second.started).toHaveLength(1));
    expect(second.started[0].id).toBe(saved.id);
    second.finish(saved.id);
    await vi.waitFor(async () => expect((await state(second, saved.id)).state).toBe('completed'));
  });

  // Distinct content targets and languages must never inherit another task's identity.
  it('keeps Wiki, cards, and other language tasks isolated', async () => {
    const paths = directory(), host = await start(paths.dataPath);
    const ids: string[] = [];
    for (const input of [payload, { ...payload, target: 'cards' }, { ...payload, language: 'en' }]) {
      const job = await host.runtime.requestAdmin<Job>('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload: input } });
      ids.push(job.id);
    }
    expect(new Set(ids).size).toBe(3);
    await vi.waitFor(() => expect(host.started).toHaveLength(3));
    const cards = await host.runtime.requestAdmin<TaskDetail>('admin.tasks.read', { source: 'user', id: ids[1] });
    expect(cards.label).toBe('Repo Wiki 卡片生成');
    expect((await state(host, ids[2])).metadata?.target).toEqual({ type: 'repoWiki', id: paths.workspace, language: 'en' });
    expect(await host.runtime.requestAdmin('admin.tasks.read', { source: 'user', id: ids[2] })).toMatchObject({ resource: { type: 'repoWiki', id: paths.workspace, language: 'en' } });
    for (const id of ids) host.finish(id);
    await vi.waitFor(async () => expect((await host.runtime.requestAdmin<Job[]>('admin.jobs.list')).every((job) => job.state === 'completed')).toBe(true));
  });

  // A missing confirmation is invalid both for newly submitted and old persisted records.
  it('never dispatches generation without persisted external-generation confirmation', async () => {
    const paths = directory(), storage = new AgentDataStorage(paths.dataPath);
    storage.migrate();
    const jobs = new JobStore(storage.db);
    const job = jobs.create({ kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload: { ...payload, confirmExternal: false } as never } });
    jobs.start(job.id);
    storage.close();
    const host = await start(paths.dataPath);
    await vi.waitFor(async () => expect((await state(host, job.id)).state).toBe('failed'));
    expect(host.started).toEqual([]);
    await expect(host.runtime.requestAdmin('admin.jobs.create', { kind: 'repoWiki.generate', workspace: paths.workspace, metadata: { payload: { ...payload, confirmExternal: false } } })).rejects.toThrow(/confirm|确认|INVALID/i);
  });
});
