import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataClient } from './client';
import { JobStore } from './jobStore';
import { AgentDataRuntime } from './runtime';
import { AgentDataStorage } from './storage';

// 复现 2026-10-16 的现场：上一个进程在同步中途退出，任务停在 running；之后又请求过取消。
// 新进程启动后它必须落定，否则永远显示「正在取消，等待确认」，同一工作区也再建不了同步。
describe('AgentDataRuntime orphaned jobs from a previous process', () => {
  let dir: string | undefined;
  let runtime: AgentDataRuntime | undefined;
  afterEach(async () => { runtime?.close(); await runtime?.waitClosed(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  function seed(): { dataPath: string; cancelled: string; running: string; pending: string; foreign: string } {
    dir = mkdtempSync(join(tmpdir(), 'agent-orphans-'));
    const repoA = join(dir, 'repo-a');
    mkdirSync(repoA);
    const dataPath = join(dir, 'data.db');
    const storage = new AgentDataStorage(dataPath);
    storage.migrate();
    const jobs = new JobStore(storage.db);
    const make = (kind: string, workspace: string) => jobs.create({ kind, workspace, metadata: { target: { type: 'project', id: workspace }, resourceName: workspace } }).id;
    const cancelled = make('codegraph.sync', 'E:/linghoumiaohui-kefu-extract');
    jobs.start(cancelled);
    jobs.recordStage(cancelled, '解析引用', { processed: 130733, total: 264572 });
    jobs.requestCancellation(cancelled);
    const running = make('codegraph.sync', repoA);
    jobs.start(running);
    const pending = make('codegraph.sync', 'D:/repo-b');
    const foreign = make('external.import', 'D:/repo-c');
    jobs.start(foreign);
    storage.close();
    return { dataPath, cancelled, running, pending, foreign };
  }

  it('settles them at startup: cancel-requested → cancelled, others → failed and retryable', async () => {
    const ids = seed();
    const run = vi.fn(async () => {});
    runtime = new AgentDataRuntime({ dataPath: ids.dataPath, jobRunners: { 'codegraph.sync': { run, cancel: vi.fn() } } });
    const client = new AgentDataClient(await runtime.start());
    const state = (id: string) => (runtime!.requestAdmin<{ items: Array<{ ref: { id: string }; status: string; error?: string; cancellationRequested: boolean }> }>('admin.tasks.list', { limit: 50 }))
      .then((page) => page.items.find((item) => item.ref.id === id));
    expect(await state(ids.cancelled)).toMatchObject({ status: 'cancelled', cancellationRequested: false });
    expect(await state(ids.running)).toMatchObject({ status: 'failed', error: 'JOB_INTERRUPTED：任务执行未完成' });
    expect(await state(ids.pending)).toMatchObject({ status: 'failed' });
    // 没有执行器的种类不归本进程管
    expect(await state(ids.foreign)).toMatchObject({ status: 'running' });
    expect(run).not.toHaveBeenCalled();

    // 不再被孤儿占着：同一工作区可以重新同步，失败的那条可以重试预览
    await expect(client.request('admin.jobs.create', { kind: 'codegraph.sync', workspace: 'E:/linghoumiaohui-kefu-extract' })).resolves.toMatchObject({ state: 'pending' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(runtime.requestAdmin('admin.tasks.previewRetry', { source: 'user', id: ids.running })).resolves.toBeTruthy();
    await client.close();

    const db = new DatabaseSync(ids.dataPath, { readOnly: true });
    const actions = db.prepare("SELECT action FROM agent_audit WHERE json_extract(detail,'$.id') IN (?,?) ORDER BY created_at").all(ids.cancelled, ids.running).map((row) => row.action);
    db.close();
    expect(actions).toEqual(expect.arrayContaining(['job.cancel', 'job.fail']));
  });

  it('is a no-op on a clean start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-orphans-'));
    runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db'), jobRunners: { 'codegraph.sync': { run: vi.fn(async () => {}), cancel: vi.fn() } } });
    await runtime.start();
    await expect(runtime.requestAdmin('admin.tasks.list', {})).resolves.toMatchObject({ items: [], activeCount: 0 });
  });
});
