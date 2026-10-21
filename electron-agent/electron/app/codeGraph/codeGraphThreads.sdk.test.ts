import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphService } from './codeGraphService';

// 真实 SDK：写线程和读线程各持一个 CodeGraphService（各自一条连接）。用两个实例模拟两个线程，
// 验证调度器依赖的事实：读方 evict 之后写方写库，读方重开就能看到；写方持连接时读方仍可并发读；
// 增量同步进行中读方照常应答，写完 refresh 后看到新数据；FileWatcher 只当事件源；别的进程占锁时报 LockUnavailableError。
let root: string;
let writer: CodeGraphService;
let reader: CodeGraphService;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-sdk-threads-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'export function alpha() { return 1; }\n');
  writer = new CodeGraphService({ listWorkspaces: () => [root] });
  reader = new CodeGraphService({ listWorkspaces: () => [root] });
  await writer.runSync('init', root);
}, 60_000);
afterAll(async () => { await reader?.close(); await writer?.close(); if (root) await rm(root, { recursive: true, force: true }); });

const symbols = async (service: CodeGraphService, query: string) => (await service.search(root, query, 10)).results.map((row) => row.symbol);

describe('CodeGraph read/write on separate connections', () => {
  it('a reader opened after the writer indexed sees the index, while the writer keeps its connection', async () => {
    expect(await symbols(reader, 'alpha')).toContain('alpha');
    expect(await reader.status(root)).toMatchObject({ state: 'indexed', connected: true });
    await expect(writer.plan(root)).resolves.toBe('incremental');
  });

  it('after evict, the reader sees what the writer added by incremental sync', async () => {
    await appendFile(join(root, 'src/a.ts'), 'export function betaAddedByWriter() { return 2; }\n');
    await writeFile(join(root, 'src/b.ts'), 'export function gammaNewFile() { return 3; }\n');
    await reader.evict(root);
    await writer.runSync('inc', root);
    expect(await symbols(reader, 'betaAddedByWriter')).toContain('betaAddedByWriter');
    expect(await symbols(reader, 'gammaNewFile')).toContain('gammaNewFile');
  }, 60_000);

  it('evict waits for an in-flight read and is a no-op when nothing is open', async () => {
    const read = reader.call(root, 'codegraph_search', { query: 'alpha' });
    await reader.evict(root);
    await expect(read).resolves.toMatchObject({ structuredContent: { rows: expect.arrayContaining([expect.objectContaining({ symbol: 'alpha' })]) } });
    await expect(reader.evict(root)).resolves.toBeUndefined();
    expect(await symbols(reader, 'alpha')).toContain('alpha');
  });

  it('the reader keeps answering on its open connection during an incremental sync, and sees the new symbols after refresh', async () => {
    expect(await symbols(reader, 'alpha')).toContain('alpha');
    await mkdir(join(root, 'src/bulk'), { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      await writeFile(join(root, `src/bulk/m${i}.ts`), `import { alpha } from '../a';\nexport function bulkSymbol${i}(input: number) { return alpha() + input + ${i}; }\nexport class BulkClass${i} { run() { return bulkSymbol${i}(${i}); } }\n`);
    }
    let done = false;
    const sync = writer.runSync('bulk', root, undefined, { mode: 'incremental' }).finally(() => { done = true; });
    let readsDuringSync = 0;
    const errors: string[] = [];
    do {
      try {
        const rows = await symbols(reader, 'alpha');
        if (!done) readsDuringSync += 1;
        if (!rows.includes('alpha')) errors.push(`alpha missing: ${rows.join(',')}`);
      } catch (error) { errors.push(String(error)); }
      // 两个实例在同一个线程：读是同步 SQLite 加微任务，不让出宏任务的话 SDK 解析线程的消息永远轮不到。
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (!done);
    await expect(sync).resolves.toMatchObject({ mode: 'incremental', filesChanged: 300 });
    expect(errors).toEqual([]);
    expect(readsDuringSync).toBeGreaterThan(0);
    await reader.refresh(root);
    expect(await symbols(reader, 'bulkSymbol299')).toContain('bulkSymbol299');
    // a.ts、b.ts 加 300 个新文件
    expect(await reader.status(root)).toMatchObject({ connected: true, files: 302 });
  }, 120_000);

  it('a scoped incremental sync reconciles only the given paths', async () => {
    await writeFile(join(root, 'src/scoped.ts'), 'export function scopedOnly() { return 1; }\n');
    await writeFile(join(root, 'src/unlisted.ts'), 'export function notListed() { return 1; }\n');
    await expect(writer.runSync('scoped', root, undefined, { mode: 'incremental', paths: ['src/scoped.ts'] })).resolves.toMatchObject({ filesChanged: 1 });
    await reader.refresh(root);
    expect(await symbols(reader, 'scopedOnly')).toContain('scopedOnly');
    expect(await symbols(reader, 'notListed')).not.toContain('notListed');
    await writer.runSync('rest', root, undefined, { mode: 'incremental' });
  }, 60_000);

  it('the SDK FileWatcher reports a real edit as changed paths without syncing by itself', async () => {
    const changes: Array<string[] | null> = [];
    await expect(writer.watch(root, { debounceMs: 100, onChange: (paths) => changes.push(paths), onDegraded: () => {} })).resolves.toEqual({ active: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await appendFile(join(root, 'src/b.ts'), 'export function deltaFromWatcher() { return 4; }\n');
      const deadline = Date.now() + 15_000;
      while (!changes.some((paths) => paths === null || paths.includes('src/b.ts')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(changes.some((paths) => paths === null || paths.includes('src/b.ts'))).toBe(true);
      // 监听只上报，不替调度器同步
      await reader.refresh(root);
      expect(await symbols(reader, 'deltaFromWatcher')).not.toContain('deltaFromWatcher');
    } finally {
      await writer.unwatch(root);
    }
  }, 30_000);

  it('an incremental sync while another live process holds codegraph.lock fails with LockUnavailableError', async () => {
    const lock = join(root, '.codegraph', 'codegraph.lock');
    await writeFile(lock, String(process.ppid));
    try {
      await expect(writer.runSync('locked', root, undefined, { mode: 'incremental' })).rejects.toMatchObject({ name: 'LockUnavailableError' });
    } finally {
      await unlink(lock).catch(() => undefined);
    }
    await expect(writer.runSync('unlocked', root, undefined, { mode: 'incremental' })).resolves.toMatchObject({ mode: 'incremental' });
  }, 60_000);
});
