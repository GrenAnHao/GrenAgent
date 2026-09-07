import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { WikiIngestSummary, WikiPublishResult, WikiVersion } from '../agentData/wikiContracts';

export interface WikiSyncJobPort {
  start(id: string): unknown;
  progress(id: string, value: number): unknown;
  complete(id: string): unknown | Promise<unknown>;
  fail(id: string, error: string): unknown | Promise<unknown>;
  /** 编排器确认已停止后，由它把 job 状态落定为 cancelled。 */
  markCancelled(id: string): unknown | Promise<unknown>;
  /** 该 job 是否已被请求取消（协作式取消的检查点）。 */
  cancelled(id: string): boolean;
}

export interface WikiSyncPageInput { workspace: string; page: string; title: string; content: string; sourcePath: string; sourceContent: string; expected: WikiVersion | null }
export interface WikiSyncSkipInput { jobId: string; workspace: string; page: string; reason: Extract<WikiPublishResult, { state: 'skipped' }>['reason'] }

export interface WikiSyncServiceOptions {
  jobs: WikiSyncJobPort;
  /** 枚举工作区内的 Markdown 相对路径。 */
  scan: (workspace: string) => Promise<string[]>;
  /** 读取工作区内某个相对路径的内容。 */
  readSource: (workspace: string, relativePath: string) => Promise<string>;
  readPage?: (workspace: string, page: string) => Promise<WikiVersion | undefined>;
  /** 调用系统 worker 生成页面 Markdown。 */
  generate: (source: string, relativePath: string, workspace?: string, expectedModel?: string) => Promise<string>;
  /** 写入 Agent Data Runtime（wiki.replace）。 */
  writePage: (input: WikiSyncPageInput) => Promise<void | WikiPublishResult>;
  onSkip?: (input: WikiSyncSkipInput) => void | Promise<void>;
  onStage?: (jobId: string, stage: string, processed?: number, total?: number) => void | Promise<void>;
}

/**
 * Wiki 同步编排器。
 *
 * 刻意不 import extensions/wiki-rag：系统 worker 加载零扩展（PI_SYSTEM_WORKER=1），
 * 扩展里的工具在这条链路上不可达；而且两个包本来就不能互相引用。
 * 扫描逻辑与 extensions/wiki-rag/sync.ts 的 scanWorkspaceMarkdown 行为对齐。
 */
export class WikiSyncService {
  constructor(private readonly options: WikiSyncServiceOptions) {}

  async run(jobId: string, workspace: string, expectedModel?: string): Promise<WikiIngestSummary> {
    const { jobs } = this.options;
    const summary: WikiIngestSummary = { succeeded: 0, skipped: 0, failed: 0 };
    jobs.start(jobId);
    try {
      await this.options.onStage?.(jobId, '正在扫描');
      const files = await this.options.scan(workspace);
      // 扫描结束后立刻再看一次：空列表走 complete 之前也能停。
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
      for (const [index, file] of files.entries()) {
        // 检查点一：不开始处理下一个文件。
        if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
        await this.options.onStage?.(jobId, '正在读取', index, files.length);
        const source = await this.options.readSource(workspace, file);
        const version = await this.options.readPage?.(workspace, file);
        const expected = version ? { revision: version.revision, contentHash: version.contentHash } : null;
        if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
        await this.options.onStage?.(jobId, '正在生成', index, files.length);
        const generated = expectedModel === undefined ? await this.options.generate(source, file, workspace)
          : await this.options.generate(source, file, workspace, expectedModel);
        const content = generated.trim();
        if (!content) throw new Error('Wiki generation returned empty content');
        // 检查点二：生成期间被取消时，这一页也不写入。
        // 少了这一步就会出现"状态已取消但仍在写文件"的竞态（生成是耗时调用，窗口很大）。
        if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
        await this.options.onStage?.(jobId, '正在发布', index, files.length);
        const result = await this.options.writePage({ workspace, page: file, title: titleFromPage(file), content, sourcePath: file, sourceContent: source, expected });
        if (result?.state === 'skipped') {
          await this.options.onSkip?.({ jobId, workspace, page: file, reason: result.reason });
          summary.skipped += 1;
        } else summary.succeeded += 1;
        await this.options.onStage?.(jobId, '已处理', index + 1, files.length);
        jobs.progress(jobId, ((index + 1) / files.length) * 100);
      }
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
      await this.options.onStage?.(jobId, '已完成', files.length, files.length);
      await jobs.complete(jobId);
    } catch (error) {
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return summary; }
      summary.failed += 1;
      await jobs.fail(jobId, error instanceof Error ? error.message : String(error));
    }
    return summary;
  }
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.pi']);

/** 枚举工作区内的 Markdown 相对路径（POSIX 分隔符，已排序）。遇到 SKIPPED_DIRECTORIES 直接不下降。 */
export async function scanWorkspaceMarkdown(workspace: string): Promise<string[]> {
  const root = resolve(workspace);
  const files: string[] = [];
  await walk(root, '');
  return files.sort();

  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const nextRel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        await walk(join(dir, entry.name), nextRel);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      files.push(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
    }
  }
}

/** 读取工作区内的源文件，拒绝越出工作区边界的路径。 */
export async function readWorkspaceSource(workspace: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath) || /[<>:"|?*\x00-\x1f]/.test(relativePath) || relativePath.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('sourcePath must stay inside workspace');
  const root = resolve(workspace);
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error('sourcePath must stay inside workspace');
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isInside(realRoot, realTarget)) throw new Error('sourcePath must stay inside workspace');
  return readFile(realTarget, 'utf8');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function titleFromPage(page: string): string {
  const name = page.replace(/\\/g, '/').split('/').pop() ?? page;
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}
