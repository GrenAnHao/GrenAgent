import { describe, expect, it, vi } from 'vitest';
import { CodeGraphJobs } from './codeGraphJobs';

function setup(runSync = vi.fn(async (_id: string, _workspace: string, _progress?: unknown) => {})) {
  const engine = { runSync, cancelSync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const callbacks = { start: vi.fn(async () => {}), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}), cancelled: vi.fn(async () => {}), stage: vi.fn() };
  return { engine, callbacks, jobs: new CodeGraphJobs(engine, callbacks) };
}

describe('CodeGraph SDK jobs', () => {
  it('settles a cancel for a job this process is not running instead of leaving it waiting forever', async () => {
    const { engine, callbacks, jobs } = setup();
    await jobs.cancel('orphan-from-previous-process');
    expect(callbacks.cancelled).toHaveBeenCalledWith('orphan-from-previous-process');
    expect(engine.cancelSync).not.toHaveBeenCalled();
  });

  it('reports unknown or inconsistent SDK totals as a stage without fabricated counts', async () => {
    const { engine, callbacks, jobs } = setup();
    engine.runSync.mockImplementationOnce(async (_id, _workspace, progress) => {
      const emit = progress as (value: unknown) => void;
      emit({ phase: 'scanning', current: 0, total: 0 });
      emit({ phase: 'resolving', current: 6, total: 5 });
    });
    await jobs.run('job', '/repo');
    expect(callbacks.stage).toHaveBeenCalledWith('job', '扫描文件');
    expect(callbacks.stage).toHaveBeenCalledWith('job', '解析引用');
    expect(callbacks.complete).toHaveBeenCalled();
  });
  it('forwards real SDK stages and counts before recording completion', async () => {
    const { engine, callbacks, jobs } = setup();
    engine.runSync.mockImplementationOnce(async (_id, _workspace, progress) => {
      (progress as (value: unknown) => void)({ phase: 'parsing', current: 2, total: 5 });
    });
    await jobs.run('job', '/repo');
    expect(callbacks.stage).toHaveBeenCalledWith('job', '解析代码', 2, 5);
    expect(callbacks.complete).toHaveBeenCalledWith('job');
    expect(callbacks.fail).not.toHaveBeenCalled();
  });

  it('shows a job queued behind another sync of the same workspace as waiting', async () => {
    const { engine, callbacks, jobs } = setup();
    engine.runSync.mockImplementationOnce(async (_id, _workspace, progress) => {
      (progress as (value: unknown) => void)({ phase: 'queued', current: 0, total: 0 });
    });
    await jobs.run('job', '/repo');
    expect(callbacks.stage).toHaveBeenCalledWith('job', '排队等待');
  });

  it('remembers cancellation during the async job-start handshake', async () => {
    const { engine, callbacks, jobs } = setup();
    let started!: () => void;
    callbacks.start.mockImplementationOnce(() => new Promise<void>((resolve) => { started = resolve; }));
    const running = jobs.run('job', '/repo');
    await jobs.cancel('job');
    started();
    await running;
    expect(engine.runSync).not.toHaveBeenCalled();
    expect(callbacks.cancelled).toHaveBeenCalledWith('job');
    expect(callbacks.complete).not.toHaveBeenCalled();
  });

  it('awaits terminal job recording as part of shutdown', async () => {
    const { engine, callbacks, jobs } = setup();
    let release!: () => void;
    callbacks.complete.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const running = jobs.run('job', '/repo');
    await vi.waitFor(() => expect(callbacks.complete).toHaveBeenCalled());
    let closed = false;
    const closing = jobs.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(engine.close).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([running, closing]);
    expect(closed).toBe(true);
  });
});
