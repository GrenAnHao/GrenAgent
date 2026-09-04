import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodeGraphSyncRunner, resolveSyncCommand } from './syncRunner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid?: number };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

describe('resolveSyncCommand', () => {
  it('initializes a bare workspace and syncs an initialized one', () => {
    expect(resolveSyncCommand('/repo', false)).toEqual({ command: 'codegraph', args: ['init', '--path', '/repo'] });
    expect(resolveSyncCommand('/repo', true)).toEqual({ command: 'codegraph', args: ['sync', '--path', '/repo'] });
  });

  it('honours the GREN_CODEGRAPH_COMMAND override', () => {
    expect(resolveSyncCommand('/repo', true, 'node ./cg.js')).toEqual({ command: 'node', args: ['./cg.js', 'sync', '--path', '/repo'] });
  });
});

describe('CodeGraphSyncRunner', () => {
  it('resolves when the CLI exits with zero and reports which command ran', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.emit('close', 0);

    await expect(running).resolves.toEqual({ mode: 'sync' });
  });

  it('rejects with the stderr tail when the CLI fails', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => false, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.stderr.emit('data', 'fatal: cannot parse file\n');
    child.emit('close', 1);

    await expect(running).rejects.toThrow('cannot parse file');
  });

  it('rejects when the CLI is missing entirely', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.emit('error', Object.assign(new Error('spawn codegraph ENOENT'), { code: 'ENOENT' }));

    await expect(running).rejects.toThrow(/codegraph/);
  });

  it('kills the child process when the job is cancelled', async () => {
    const child = fakeChild();
    const killTree = vi.fn(async () => {});
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never), killTree });

    const running = runner.run('job-1', '/repo');
    runner.cancel('job-1');
    child.emit('close', null);

    await expect(running).rejects.toThrow('cancelled');
    expect(killTree).toHaveBeenCalledWith(4242);
  });

  it('ignores cancellation for an unknown job id', () => {
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn() });
    expect(() => runner.cancel('missing')).not.toThrow();
  });
});
