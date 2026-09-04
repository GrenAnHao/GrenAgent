import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiSyncService, readWorkspaceSource, scanWorkspaceMarkdown, type WikiSyncPageInput, type WikiSyncServiceOptions } from './wikiSyncService';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function deps(overrides: Partial<WikiSyncServiceOptions> = {}) {
  const jobs = {
    start: vi.fn(),
    progress: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    markCancelled: vi.fn(),
    cancelled: vi.fn<(id: string) => boolean>(() => false),
  };
  const writes: WikiSyncPageInput[] = [];
  const scan = overrides.scan ?? vi.fn(async () => ['README.md', 'docs/guide.md']);
  const readSource = overrides.readSource ?? vi.fn(async (_workspace: string, path: string) => `# source of ${path}`);
  const generate = overrides.generate ?? vi.fn(async (source: string) => `# generated from ${source}`);
  const writePage = overrides.writePage ?? vi.fn(async (input: WikiSyncPageInput) => { writes.push(input); });
  const service = new WikiSyncService({
    jobs,
    scan,
    readSource,
    generate,
    writePage,
  });
  return { service, jobs, writes, generate, readSource, scan };
}

describe('WikiSyncService', () => {
  it('generates one page per markdown file and advances job progress', async () => {
    const { service, jobs, writes } = deps();

    await service.run('job-1', '/repo');

    expect(jobs.start).toHaveBeenCalledWith('job-1');
    expect(writes).toEqual([
      { workspace: '/repo', page: 'README.md', title: 'README', content: '# generated from # source of README.md', sourcePath: 'README.md' },
      { workspace: '/repo', page: 'docs/guide.md', title: 'guide', content: '# generated from # source of docs/guide.md', sourcePath: 'docs/guide.md' },
    ]);
    expect(jobs.progress.mock.calls).toEqual([['job-1', 50], ['job-1', 100]]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('completes immediately when the workspace has no markdown', async () => {
    const { service, jobs, writes } = deps({ scan: vi.fn(async () => []) });

    await service.run('job-1', '/repo');

    expect(jobs.start).toHaveBeenCalledWith('job-1');
    expect(writes).toEqual([]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.progress).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.markCancelled).not.toHaveBeenCalled();
  });

  it('fails the job and keeps earlier pages when one file cannot be generated', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('# ok')
      .mockRejectedValueOnce(new Error('model offline'));
    const { service, jobs, writes } = deps({ generate });

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(1);
    expect(jobs.fail).toHaveBeenCalledWith('job-1', expect.stringContaining('model offline'));
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it('stops before the next file once the job is cancelled and marks it cancelled', async () => {
    const { service, jobs, writes, generate, readSource } = deps();
    jobs.cancelled.mockImplementation(() => writes.length >= 1);

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('never writes a page after cancellation was requested mid-generation', async () => {
    // 取消发生在第一个文件"已生成、未写入"的窗口内：这一页也不能落盘，
    // 否则会出现"状态已取消但仍在写文件"的竞态。
    let cancelled = false;
    const { service, jobs, writes } = deps({
      generate: vi.fn(async (source: string) => { cancelled = true; return `# generated from ${source}`; }),
    });
    jobs.cancelled.mockImplementation(() => cancelled);

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(0);
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
  });
});

describe('scanWorkspaceMarkdown', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('lists markdown recursively and skips runtime directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-sync-scan-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, '.pi'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.md'), '# Ignored');
    await writeFile(join(root, '.git', 'ignored.md'), '# Ignored');
    await writeFile(join(root, '.pi', 'ignored.md'), '# Ignored');

    await expect(scanWorkspaceMarkdown(root)).resolves.toEqual(['README.md', 'docs/guide.md']);
  });
});

describe('readWorkspaceSource', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('rejects relative escapes and absolute paths outside the workspace', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-sync-read-'));
    await writeFile(join(root, 'inside.md'), '# in');

    await expect(readWorkspaceSource(root, '../secret.md')).rejects.toThrow('sourcePath must stay inside workspace');
    await expect(readWorkspaceSource(root, resolve(root, '..', 'outside.md'))).rejects.toThrow('sourcePath must stay inside workspace');
  });
});
