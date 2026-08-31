import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { askLlm, resolveModel, type AskFn } from './llm.js';

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
    const ask = this.askFactory(ctx);
    if (!ask) return false;
    let content: string;
    try {
      content = (await ask(SYSTEM, input.source)).trim();
    } catch {
      return false;
    }
    if (!content) return false;
    await this.client.request('wiki.replace', {
      workspace: ctx.cwd,
      page: input.page,
      title: titleFromPage(input.page),
      content,
      sourcePath: input.sourcePath,
    });
    return true;
  }
}

export async function readWorkspaceSource(cwd: string, sourcePath: string): Promise<string> {
  const root = resolve(cwd);
  const path = resolve(root, sourcePath);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('sourcePath must stay inside workspace');
  return readFile(path, 'utf8');
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
  const model = resolveModel(ctx.model as never, (ctx.modelRegistry ?? { find: () => undefined }) as never, undefined);
  return model ? (system, user) => askLlm(model, system, user, ctx.signal) : undefined;
}

function titleFromPage(page: string): string {
  const name = page.replace(/\\/g, '/').split('/').pop() ?? page;
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}
