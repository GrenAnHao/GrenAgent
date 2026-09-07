import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiSyncService, readWorkspaceSource, scanWorkspaceMarkdown, type WikiSyncPageInput, type WikiSyncServiceOptions } from './wikiSyncService';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
    readPage: overrides.readPage,
    onSkip: overrides.onSkip,
    onStage: overrides.onStage,
  });
  return { service, jobs, writes, generate, readSource, scan };
}

describe('WikiSyncService', () => {
  it('carries the confirmed retry model to every generation call for the worker to revalidate', async () => {
    const generate = vi.fn(async () => '# Generated');
    const { service } = deps({ generate });
    await service.run('retry-job', '/repo', 'confirmed/model');
    expect(generate.mock.calls).toEqual([
      ['# source of README.md', 'README.md', '/repo', 'confirmed/model'],
      ['# source of docs/guide.md', 'docs/guide.md', '/repo', 'confirmed/model'],
    ]);
  });

  it('reports real scan/read/generate/publish/complete boundaries without inventing generation progress', async () => {
    let resume!: (value: string) => void; const output = new Promise<string>((resolve) => { resume = resolve; });
    const stages: unknown[][] = [];
    const { service, jobs } = deps({ scan: async () => ['README.md'], generate: () => output,
      onStage: (id, stage, processed, total) => { stages.push([id, stage, processed, total]); } });
    const run = service.run('job-1', '/repo');
    await vi.waitFor(() => expect(stages).toContainEqual(['job-1', '正在生成', 0, 1]));
    expect(jobs.progress).not.toHaveBeenCalled();
    resume('# Generated'); await run;
    expect(stages).toEqual([
      ['job-1', '正在扫描', undefined, undefined], ['job-1', '正在读取', 0, 1], ['job-1', '正在生成', 0, 1],
      ['job-1', '正在发布', 0, 1], ['job-1', '已处理', 1, 1], ['job-1', '已完成', 1, 1],
    ]);
  });

  it.each(['locked', 'changed', 'multi_source'] as const)('counts %s skips and audits each skipped page while continuing the batch', async (reason) => {
    const onSkip = vi.fn(async () => {});
    const writePage = vi.fn().mockResolvedValueOnce({ state: 'skipped', reason }).mockResolvedValueOnce(undefined);
    const { service, jobs } = deps({ writePage, onSkip });
    await expect(service.run('job-1', '/repo')).resolves.toEqual({ succeeded: 1, skipped: 1, failed: 0 });
    expect(onSkip).toHaveBeenCalledExactlyOnceWith({ jobId: 'job-1', workspace: '/repo', page: 'README.md', reason });
    expect(writePage).toHaveBeenCalledTimes(2);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('returns successful and failed counts when a later generation fails', async () => {
    const generate = vi.fn().mockResolvedValueOnce('# First').mockRejectedValueOnce(new Error('fixture failure'));
    const { service } = deps({ generate });
    await expect(service.run('job-1', '/repo')).resolves.toEqual({ succeeded: 1, skipped: 0, failed: 1 });
  });

  it('returns only completed page counts when cancellation is confirmed during generation', async () => {
    let cancelled = false;
    const generate = vi.fn().mockResolvedValueOnce('# First').mockImplementationOnce(async () => { cancelled = true; return '# Late'; });
    const { service, jobs } = deps({ generate });
    jobs.cancelled.mockImplementation(() => cancelled);
    await expect(service.run('job-1', '/repo')).resolves.toEqual({ succeeded: 1, skipped: 0, failed: 0 });
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
  });

  it('carries the pre-generation page version and continues after an optimistic write skip', async () => {
    let revision = 1;
    const writePage = vi.fn(async (_input: WikiSyncPageInput) => ({ state: 'skipped' as const, reason: 'changed' as const }));
    const { service, jobs } = deps({
      readPage: async () => ({ revision, contentHash: `hash-${revision}` }),
      generate: async () => { revision += 1; return '# Generated'; },
      writePage,
    });
    await service.run('job-1', '/repo');
    expect(writePage.mock.calls.map(([input]) => input.expected)).toEqual([{ revision: 1, contentHash: 'hash-1' }, { revision: 2, contentHash: 'hash-2' }]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(jobs.progress.mock.calls).toEqual([['job-1', 50], ['job-1', 100]]);
  });

  it('passes expected null for a page that did not exist before generation', async () => {
    const { service, writes } = deps({ readPage: async () => undefined });
    await service.run('job-1', '/repo');
    expect(writes.map((input) => input.expected)).toEqual([null, null]);
  });

  it('generates one page per markdown file and advances job progress', async () => {
    const { service, jobs, writes, generate } = deps();

    await service.run('job-1', '/repo');

    expect(jobs.start).toHaveBeenCalledWith('job-1');
    expect(writes).toEqual([
      { workspace: '/repo', page: 'README.md', title: 'README', content: '# generated from # source of README.md', sourcePath: 'README.md', sourceContent: '# source of README.md', expected: null },
      { workspace: '/repo', page: 'docs/guide.md', title: 'guide', content: '# generated from # source of docs/guide.md', sourcePath: 'docs/guide.md', sourceContent: '# source of docs/guide.md', expected: null },
    ]);
    expect(jobs.progress.mock.calls).toEqual([['job-1', 50], ['job-1', 100]]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith('# source of README.md', 'README.md', '/repo');
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

  it('fails without replacing a page when the model returns empty output', async () => {
    const { service, jobs, writes } = deps({ generate: vi.fn(async () => '  \n ') });

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(0);
    expect(jobs.fail).toHaveBeenCalledWith('job-1', expect.stringContaining('empty'));
    expect(jobs.complete).not.toHaveBeenCalled();
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

  it.each(['C:inside.md', 'inside.md:stream', 'NUL.md', 'dir/CON.txt', '\\rooted.md'])('rejects Windows path aliases: %s', async (path) => {
    root = await mkdtemp(join(tmpdir(), 'wiki-sync-read-'));
    await expect(readWorkspaceSource(root, path)).rejects.toThrow('sourcePath must stay inside workspace');
  });

  it('rejects linked source directories outside the real workspace', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-sync-read-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'source.md'), '# outside fixture');
    await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readWorkspaceSource(workspace, 'linked/source.md')).rejects.toThrow('sourcePath must stay inside workspace');
  });

  it('allows internal links and safe filenames beginning with two dots', async () => {
    root = await mkdtemp(join(tmpdir(), 'wiki-sync-read-'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'source.md'), '# safe');
    await writeFile(join(root, '..notes.md'), '# notes');
    await symlink(join(root, 'docs'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readWorkspaceSource(root, 'linked/source.md')).resolves.toBe('# safe');
    await expect(readWorkspaceSource(root, '..notes.md')).resolves.toBe('# notes');
  });
});
