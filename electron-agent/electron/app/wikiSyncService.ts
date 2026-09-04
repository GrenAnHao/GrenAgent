import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

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

export interface WikiSyncPageInput { workspace: string; page: string; title: string; content: string; sourcePath: string }

export interface WikiSyncServiceOptions {
  jobs: WikiSyncJobPort;
  /** 枚举工作区内的 Markdown 相对路径。 */
  scan: (workspace: string) => Promise<string[]>;
  /** 读取工作区内某个相对路径的内容。 */
  readSource: (workspace: string, relativePath: string) => Promise<string>;
  /** 调用系统 worker 生成页面 Markdown。 */
  generate: (source: string, relativePath: string) => Promise<string>;
  /** 写入 Agent Data Runtime（wiki.replace）。 */
  writePage: (input: WikiSyncPageInput) => Promise<void>;
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

  async run(jobId: string, workspace: string): Promise<void> {
    const { jobs } = this.options;
    jobs.start(jobId);
    try {
      const files = await this.options.scan(workspace);
      // 扫描结束后立刻再看一次：空列表走 complete 之前也能停。
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return; }
      for (const [index, file] of files.entries()) {
        // 检查点一：不开始处理下一个文件。
        if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return; }
        const source = await this.options.readSource(workspace, file);
        const content = await this.options.generate(source, file);
        // 检查点二：生成期间被取消时，这一页也不写入。
        // 少了这一步就会出现"状态已取消但仍在写文件"的竞态（生成是耗时调用，窗口很大）。
        if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return; }
        await this.options.writePage({ workspace, page: file, title: titleFromPage(file), content, sourcePath: file });
        jobs.progress(jobId, ((index + 1) / files.length) * 100);
      }
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return; }
      await jobs.complete(jobId);
    } catch (error) {
      if (jobs.cancelled(jobId)) { await jobs.markCancelled(jobId); return; }
      await jobs.fail(jobId, error instanceof Error ? error.message : String(error));
    }
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
  const root = resolve(workspace);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('sourcePath must stay inside workspace');
  return readFile(target, 'utf8');
}

function titleFromPage(page: string): string {
  const name = page.replace(/\\/g, '/').split('/').pop() ?? page;
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}
