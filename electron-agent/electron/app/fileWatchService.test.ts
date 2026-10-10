import { EventEmitter } from 'node:events';
import type { FSWatcher, WatchListener } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileService, isListingSkippedName } from './fileService';
import { FileWatchService, type FileChangeBatch } from './fileWatchService';

class FakeWatcher extends EventEmitter {
  closed = false;
  constructor(readonly dir: string, readonly listener: WatchListener<string>) {
    super();
  }
  close(): void {
    this.closed = true;
  }
}

function fakeWatch() {
  const watchers: FakeWatcher[] = [];
  const watchFn = (dir: string, listener: WatchListener<string>) => {
    const watcher = new FakeWatcher(dir, listener);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  };
  const live = (dir: string) => watchers.find((w) => w.dir === dir && !w.closed);
  return { watchers, watchFn, live };
}

const identity = async (_workspace: string, dir: string) => dir;

describe('FileWatchService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replaces the watched set: opens new dirs, closes dropped ones, keeps unchanged ones', async () => {
    const fake = fakeWatch();
    const service = new FileWatchService(identity, () => false, fake.watchFn);
    await service.setDirs('w', '/ws', ['/ws', '/ws/src'], () => {});
    const root = fake.live('/ws');
    await service.setDirs('w', '/ws', ['/ws', '/ws/lib'], () => {});

    expect(service.watchedDirs('w').sort()).toEqual(['/ws', '/ws/lib']);
    expect(fake.live('/ws')).toBe(root);
    expect(fake.watchers.find((w) => w.dir === '/ws/src')?.closed).toBe(true);
  });

  it('batches changes per flush with the changed dirs and file paths, and skips ignored names', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const batches: FileChangeBatch[] = [];
    const service = new FileWatchService(identity, isListingSkippedName, fake.watchFn);
    await service.setDirs('w', '/ws', ['/ws', '/ws/src'], (batch) => batches.push(batch));

    fake.live('/ws')!.listener('rename', 'node_modules');
    fake.live('/ws')!.listener('change', '.git');
    expect(vi.getTimerCount()).toBe(0);

    fake.live('/ws/src')!.listener('change', 'a.ts');
    fake.live('/ws/src')!.listener('change', 'a.ts');
    fake.live('/ws')!.listener('rename', null);
    vi.advanceTimersByTime(200);

    expect(batches).toEqual([{ workspace: '/ws', dirs: ['/ws/src', '/ws'], paths: [join('/ws/src', 'a.ts')] }]);
  });

  it('drops a watcher whose directory errors (deleted on Windows) and reports that dir', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const batches: FileChangeBatch[] = [];
    const service = new FileWatchService(identity, () => false, fake.watchFn);
    await service.setDirs('w', '/ws', ['/ws/gone'], (batch) => batches.push(batch));

    fake.live('/ws/gone')!.emit('error', new Error('EPERM'));
    vi.advanceTimersByTime(200);

    expect(service.watchedDirs('w')).toEqual([]);
    expect(batches[0]?.dirs).toEqual(['/ws/gone']);
  });

  it('skips dirs that fail to resolve and ignores a stale setDirs that finishes late', async () => {
    const fake = fakeWatch();
    let releaseSlow: () => void = () => {};
    const resolveDir = async (_workspace: string, dir: string) => {
      if (dir === '/ws/escape') throw new Error('Path escapes workspace');
      if (dir === '/ws/slow') await new Promise<void>((resolve) => { releaseSlow = resolve; });
      return dir;
    };
    const service = new FileWatchService(resolveDir, () => false, fake.watchFn);

    const stale = service.setDirs('w', '/ws', ['/ws/slow'], () => {});
    await service.setDirs('w', '/ws', ['/ws', '/ws/escape'], () => {});
    releaseSlow();
    await stale;

    expect(service.watchedDirs('w')).toEqual(['/ws']);
  });

  it('clears one key or every key under a sender prefix, and emits nothing after clear', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const emit = vi.fn();
    const service = new FileWatchService(identity, () => false, fake.watchFn);
    await service.setDirs('1:a', '/ws', ['/ws/a'], emit);
    await service.setDirs('1:b', '/ws', ['/ws/b'], emit);
    await service.setDirs('2:a', '/ws', ['/ws/c'], emit);

    fake.live('/ws/a')!.listener('change', 'x');
    service.clear('1:a');
    vi.advanceTimersByTime(200);
    expect(emit).not.toHaveBeenCalled();

    service.clearPrefix('1:');
    expect(service.watchedDirs('1:b')).toEqual([]);
    expect(service.watchedDirs('2:a')).toEqual(['/ws/c']);
    expect(fake.watchers.filter((w) => w.closed).map((w) => w.dir).sort()).toEqual(['/ws/a', '/ws/b']);
  });

  it('reports a real file write inside a watched workspace directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'electron-agent-watch-')));
    try {
      await mkdir(join(root, 'src'));
      const files = new FileService();
      const service = new FileWatchService((ws, dir) => files.resolveExisting(ws, dir), isListingSkippedName);
      const batch = new Promise<FileChangeBatch>((resolve) => {
        void service.setDirs('w', root, [join(root, 'src')], resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(join(root, 'src', 'new.ts'), 'export {};');

      const received = await batch;
      expect(received.dirs).toEqual([join(root, 'src')]);
      expect(received.paths).toContain(join(root, 'src', 'new.ts'));
      service.clear('w');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);
});
