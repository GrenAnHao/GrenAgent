import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphService } from './codeGraphService';

// 真实 SDK：写线程和读线程各持一个 CodeGraphService（各自一条连接）。用两个实例模拟两个线程，
// 验证调度器依赖的事实：读方 evict 之后写方写库，读方重开就能看到；写方持连接时读方仍可并发读。
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
});
