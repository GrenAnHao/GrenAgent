import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import wikiRag from './index.js';
import { WikiClient } from './client.js';
import safety from '../safety/index.js';
import { __resetForTest } from '../_shared/runtime-config.js';

type Tool = Parameters<Parameters<typeof wikiRag>[0]['registerTool']>[0];
type Context = Parameters<Tool['execute']>[4];
const roots: string[] = [];

function tools(): Record<string, Tool> {
  const registered: Record<string, Tool> = {};
  wikiRag({ registerTool: (tool: Tool) => { registered[tool.name] = tool; } } as never);
  return registered;
}

function context(cwd: string, signal?: AbortSignal) {
  const complete = vi.fn(async () => ({
    role: 'assistant', content: [{ type: 'text', text: '# Generated' }], stopReason: 'stop',
    api: 'wiki-test', provider: 'fixture', model: 'fixture', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }));
  return { ctx: { cwd, signal, model: { id: 'fixture', api: 'wiki-test', provider: 'fixture' }, modelRegistry: { complete } } as unknown as Context, complete };
}

beforeEach(() => {
  vi.stubEnv('PI_RUNTIME_CONFIG', '');
  vi.stubEnv('PI_PERMISSION_PROFILE', 'workspace');
  __resetForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetForTest();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('wiki rag extension', () => {
  it('registers wiki tools', () => {
    expect(Object.keys(tools()).sort()).toEqual(['wiki_list', 'wiki_read', 'wiki_reindex', 'wiki_search', 'wiki_update']);
  });

  it('reads and lists pages with exact library IDs in the current project', async () => {
    const page = { kbId: 'bound-kb', pageId: 'guide', title: 'Guide', content: '# Stored Markdown' };
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValueOnce(page).mockResolvedValueOnce([page]);
    const { ctx, complete } = context('/repo');
    const registered = tools();
    expect(registered).toHaveProperty('wiki_read');
    expect(registered).toHaveProperty('wiki_list');

    const read = await registered.wiki_read.execute('read', { kbId: 'bound-kb', pageId: 'guide' }, undefined, undefined, ctx);
    expect(read.content).toEqual([{ type: 'text', text: '# Stored Markdown' }]);
    expect(read.details).toEqual(page);
    await registered.wiki_list.execute('list', { kbId: 'bound-kb', limit: 10 }, undefined, undefined, ctx);
    expect(request).toHaveBeenNthCalledWith(1, 'wiki.pages.read', { workspace: '/repo', kbId: 'bound-kb', pageId: 'guide' });
    expect(request).toHaveBeenNthCalledWith(2, 'wiki.pages.list', { workspace: '/repo', kbId: 'bound-kb', limit: 10 });
    expect(complete).not.toHaveBeenCalled();
  });

  it('searches associated libraries and lists none without falling back to a global scope', async () => {
    const hit = { kbId: 'bound-kb', pageId: 'p-1', title: '指南', snippet: 'text' };
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValueOnce([hit]).mockResolvedValueOnce([]);
    const { ctx, complete } = context('/repo'); const registered = tools();
    const search = await registered.wiki_search.execute('search', { query: '指南' }, undefined, undefined, ctx);
    expect(search.details).toEqual([hit]);
    const list = await registered.wiki_list.execute('list', {}, undefined, undefined, ctx);
    expect(list.details).toEqual([]);
    expect(request).toHaveBeenNthCalledWith(1, 'wiki.pages.search', { workspace: '/repo', query: '指南', limit: 20 });
    expect(request).toHaveBeenNthCalledWith(2, 'wiki.libraries.list', { workspace: '/repo' });
    expect(request).toHaveBeenCalledTimes(2); expect(complete).not.toHaveBeenCalled();
  });

  it.each(['denied', 'blocked'] as const)('does not rebuild indexes when permission is %s', async (status) => {
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValue({ status });
    const { ctx, complete } = context('/repo');
    const registered = tools();
    expect(registered).toHaveProperty('wiki_reindex');

    await registered.wiki_reindex.execute('reindex', {}, undefined, undefined, ctx);
    expect(request).toHaveBeenCalledExactlyOnceWith('permission.authorize', {
      operation: { kind: 'filesystem.write', workspace: '/repo', path: '/repo', toolName: 'wiki_reindex' }, profile: 'workspace',
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('rebuilds indexes without a model request after authorization', async () => {
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValueOnce({ status: 'allowed' }).mockResolvedValueOnce({ pages: 2 });
    const { ctx, complete } = context('/repo');
    const registered = tools();
    expect(registered).toHaveProperty('wiki_reindex');

    const result = await registered.wiki_reindex.execute('reindex', {}, undefined, undefined, ctx);
    expect(result.details).toEqual({ pages: 2 });
    expect(request).toHaveBeenLastCalledWith('wiki.reindex', { workspace: '/repo' });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['denied', 'blocked'] as const)('does not read, generate or write when permission is %s', async (status) => {
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValue({ status });
    const { ctx, complete } = context(join(tmpdir(), 'wiki-missing-source'));

    const result = await tools().wiki_update.execute('id', { page: 'p.md', sourcePath: 'missing.md' }, undefined, undefined, ctx);

    expect(result.details).toEqual({ updated: false });
    expect(result.content).toEqual([{ type: 'text', text: `Wiki update was ${status} by Electron permissions.` }]);
    expect(complete).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith('permission.authorize', {
      operation: { kind: 'filesystem.write', workspace: ctx.cwd, path: ctx.cwd, toolName: 'wiki_update' }, profile: 'workspace',
    });
  });

  it('does not generate or write when the desktop authorizer cannot be reached', async () => {
    vi.spyOn(WikiClient.prototype, 'request').mockRejectedValue(new Error('runtime offline'));
    const { ctx, complete } = context(join(tmpdir(), 'wiki-missing-source'));

    const result = await tools().wiki_update.execute('id', { page: 'p.md', sourcePath: 'missing.md' }, undefined, undefined, ctx);

    expect(result.details).toEqual({ updated: false });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['execution', 'context'] as const)('propagates the %s signal through generation to the real Wiki RPC', async (source) => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-tool-'));
    roots.push(root);
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'source.md'), '# Source');
    const request = vi.spyOn(WikiClient.prototype, 'request').mockImplementation(async <T>(method: string) => (method === 'permission.authorize' ? { status: 'allowed' } : method === 'wiki.read' ? undefined : { state: 'published' }) as T);
    const signal = new AbortController().signal;
    const { ctx, complete } = context(root, source === 'context' ? signal : undefined);

    const result = await tools().wiki_update.execute('id', { page: 'page.md', sourcePath: 'docs/source.md' }, source === 'execution' ? signal : undefined, undefined, ctx);

    expect(result.details).toEqual({ updated: true });
    expect(complete).toHaveBeenCalledWith(ctx.model, expect.any(Object), expect.objectContaining({ signal }));
    expect(request).toHaveBeenLastCalledWith('wiki.replace', { workspace: root, page: 'page.md', title: 'page', content: '# Generated', sourcePath: 'docs/source.md', sourceContent: '# Source', expected: null });
  });

  it('honors context cancellation even when execution also supplies a signal', async () => {
    const request = vi.spyOn(WikiClient.prototype, 'request').mockResolvedValue({ status: 'allowed' });
    const controller = new AbortController();
    controller.abort();
    const { ctx, complete } = context(join(tmpdir(), 'wiki-missing-source'), controller.signal);

    const result = await tools().wiki_update.execute('id', { page: 'p.md', sourcePath: 'missing.md' }, new AbortController().signal, undefined, ctx);

    expect(result.details).toEqual({ updated: false });
    expect(complete).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['wiki_update', 'wiki_reindex'])('%s is blocked by the existing readonly capability gate', async (toolName) => {
    vi.stubEnv('SAFETY_READONLY', '1');
    let onToolCall: (event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>;
    safety({ on: (name: string, handler: typeof onToolCall) => { if (name === 'tool_call') onToolCall = handler; } } as never);

    await expect(onToolCall!({ toolName, input: {} }, { cwd: '/repo', hasUI: false })).resolves.toMatchObject({ block: true });
  });
});
