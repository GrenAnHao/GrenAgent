import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { askLlm, type AskFn } from './llm.js';

export interface WikiSyncClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

type WikiContext = Pick<ExtensionContext, 'model' | 'modelRegistry' | 'signal'> & { cwd: string };
type AskFactory = (ctx: WikiContext) => AskFn | undefined;

export interface WikiUpdateInput {
  page: string;
  sourcePath: string;
  source: string;
}

const SYSTEM = 'Write a concise Markdown knowledge page from the supplied source. Preserve important names, behavior, and references. Return Markdown only.';

export class WikiSync {
  constructor(private readonly client: WikiSyncClient, private readonly askFactory: AskFactory = defaultAsk) {}

  async update(ctx: WikiContext, input: WikiUpdateInput): Promise<boolean> {
    if (ctx.signal?.aborted) return false;
    const ask = this.askFactory(ctx);
    if (!ask) return false;
    let content: string;
    let expected: { revision: number; contentHash: string } | null;
    try {
      const page = await this.client.request<{ revision: number; contentHash: string } | undefined>('wiki.read', { workspace: ctx.cwd, page: input.page });
      if (page && (!Number.isSafeInteger(page.revision) || typeof page.contentHash !== 'string')) return false;
      expected = page ? { revision: page.revision, contentHash: page.contentHash } : null;
      if (ctx.signal?.aborted) return false;
      content = (await ask(SYSTEM, input.source)).trim();
    } catch {
      return false;
    }
    if (!content || ctx.signal?.aborted) return false;
    const result = await this.client.request<{ state?: string } | undefined>('wiki.replace', {
      workspace: ctx.cwd,
      page: input.page,
      title: titleFromPage(input.page),
      content,
      sourcePath: input.sourcePath,
      sourceContent: input.source,
      expected,
    });
    return result?.state !== 'skipped';
  }
}

export async function readWorkspaceSource(cwd: string, sourcePath: string): Promise<string> {
  if (isAbsolute(sourcePath) || win32.isAbsolute(sourcePath) || /[<>:"|?*\x00-\x1f]/.test(sourcePath) || sourcePath.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('sourcePath must stay inside workspace');
  const root = resolve(cwd);
  const path = resolve(root, sourcePath);
  if (!isInside(root, path)) throw new Error('sourcePath must stay inside workspace');
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!isInside(realRoot, realPath)) throw new Error('sourcePath must stay inside workspace');
  return readFile(realPath, 'utf8');
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function scanWorkspaceMarkdown(cwd: string): Promise<string[]> {
  const root = resolve(cwd);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => (entry.parentPath ? relative(root, resolve(entry.parentPath, entry.name)) : entry.name).replace(/\\/g, '/'))
    .filter((path) => path && !path.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules' || part === '.pi'))
    .sort();
}

function defaultAsk(ctx: WikiContext): AskFn | undefined {
  return ctx.model ? (system, user) => askLlm(ctx, system, user) : undefined;
}

function titleFromPage(page: string): string {
  const name = page.replace(/\\/g, '/').split('/').pop() ?? page;
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}
