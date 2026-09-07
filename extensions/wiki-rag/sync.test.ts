import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from '@earendil-works/pi-ai/compat';
import { readWorkspaceSource, scanWorkspaceMarkdown, WikiSync, type WikiSyncClient } from './sync.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 只用 model.id 与 modelRegistry，按真实参数类型收敛，不复制 pi 的完整结构。
type WikiUpdateContext = Parameters<WikiSync['update']>[0];
const roots: string[] = [];
const providers: Array<{ unregister(): void }> = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.unregister();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wiki-sync-'));
  roots.push(root);
  return root;
}

function modelContext(stopReason: AssistantMessage['stopReason'] = 'stop', signal?: AbortSignal) {
  const provider = registerFauxProvider({ api: 'wiki-test-api', provider: 'wiki-test-provider', models: [{ id: 'fixture' }] });
  providers.push(provider);
  const model = provider.getModel();
  const response = fauxAssistantMessage('# Generated\n\nSummary', { stopReason });
  provider.setResponses([response]);
  const complete = vi.fn(async () => response);
  const ctx = { cwd: '/repo', model, signal, modelRegistry: { find: () => model, complete } } as unknown as WikiUpdateContext;
  return { ctx, complete };
}

function client() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const value: WikiSyncClient = {
    async request<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return null as T;
    },
  };
  return { value, calls };
}

describe('WikiSync', () => {
  it.each([{ revision: 3, contentHash: 'before' }, null])('publishes with the version observed before deferred generation: %j', async (initial) => {
    let finish!: (content: string) => void;
    const ask = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let current = initial;
    const request = vi.fn(async (method: string, _params: Record<string, unknown>) => method === 'wiki.read' ? current : { state: 'skipped', reason: 'changed' });
    const sync = new WikiSync({ request } as WikiSyncClient, () => ask);
    const run = sync.update({ cwd: '/repo' } as WikiUpdateContext, { page: 'page.md', sourcePath: 'source.md', source: '# Source' });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    current = { revision: 4, contentHash: 'manual edit' };
    finish('# Generated');
    await expect(run).resolves.toBe(false);
    expect(request).toHaveBeenLastCalledWith('wiki.replace', expect.objectContaining({ expected: initial, sourceContent: '# Source' }));
  });

  it('does not generate or report success when the pre-generation page read fails', async () => {
    const ask = vi.fn(async () => '# Generated');
    const request = vi.fn(async () => { throw new Error('read failed'); });
    const sync = new WikiSync({ request }, () => ask);
    await expect(sync.update({ cwd: '/repo' } as WikiUpdateContext, { page: 'page.md', sourcePath: 'source.md', source: '# Source' })).resolves.toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('scans workspace Markdown while excluding runtime directories', async () => {
    const root = await fixture();
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.md'), '# Ignored');
    await expect(scanWorkspaceMarkdown(root)).resolves.toEqual(['README.md', 'docs/guide.md']);
  });

  it('generates a page with the current model and writes source metadata', async () => {
    const c = client();
    const ask = vi.fn(async () => {
      return '# Generated\n\nSummary';
    });
    const sync = new WikiSync(c.value, (ctx) => {
      expect(ctx.model).toEqual({ id: 'current' });
      return ask;
    });
    await sync.update({ cwd: '/repo', model: { id: 'current' }, modelRegistry: {}, signal: undefined } as unknown as WikiUpdateContext, {
      page: 'docs/overview.md', sourcePath: 'README.md', source: '# Source\n\nDetails',
    });
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0].method).toBe('wiki.read');
    expect(c.calls[1].method).toBe('wiki.replace');
    expect(c.calls[1].params.content).toContain('# Generated');
    expect(c.calls[1].params.sourcePath).toBe('README.md');
    expect(c.calls[1].params.expected).toBeNull();
  });

  it('keeps the existing page when generation fails', async () => {
    const c = client();
    const sync = new WikiSync(c.value, () => async () => { throw new Error('offline'); });
    await expect(sync.update({ cwd: '/repo', model: { id: 'current' }, modelRegistry: {}, signal: undefined } as unknown as WikiUpdateContext, {
      page: 'docs/overview.md', sourcePath: 'README.md', source: 'new source',
    })).resolves.toBe(false);
    expect(c.calls.map((call) => call.method)).toEqual(['wiki.read']);
  });

  it('uses the authenticated model registry and passes the context abort signal', async () => {
    const c = client();
    const { ctx, complete } = modelContext('stop', new AbortController().signal);

    await expect(new WikiSync(c.value).update(ctx, { page: 'p.md', sourcePath: 's.md', source: '# source' })).resolves.toBe(true);

    expect(complete).toHaveBeenCalledWith(ctx.model, expect.objectContaining({ messages: expect.any(Array) }), expect.objectContaining({ signal: ctx.signal }));
    expect(c.calls[1].params.content).toBe('# Generated\n\nSummary');
  });

  it.each(['error', 'aborted', 'length'] as const)('does not replace a page with %s partial output', async (reason) => {
    const c = client();
    const { ctx } = modelContext(reason);

    await expect(new WikiSync(c.value).update(ctx, { page: 'p.md', sourcePath: 's.md', source: '# source' })).resolves.toBe(false);
    expect(c.calls.map((call) => call.method)).toEqual(['wiki.read']);
  });

  it('does not start generation for an already cancelled context', async () => {
    const c = client();
    const controller = new AbortController();
    controller.abort();
    const ask = vi.fn(async () => '# Generated');

    await expect(new WikiSync(c.value, () => ask).update({ cwd: '/repo', signal: controller.signal } as WikiUpdateContext, { page: 'p.md', sourcePath: 's.md', source: '# source' })).resolves.toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(c.calls).toHaveLength(0);
  });

  it('never writes if generation finishes after cancellation', async () => {
    const c = client();
    const controller = new AbortController();
    const sync = new WikiSync(c.value, () => async () => { controller.abort(); return '# Partial'; });

    await expect(sync.update({ cwd: '/repo', signal: controller.signal } as WikiUpdateContext, { page: 'p.md', sourcePath: 's.md', source: '# source' })).resolves.toBe(false);
    expect(c.calls.map((call) => call.method)).toEqual(['wiki.read']);
  });
});

describe('readWorkspaceSource', () => {
  it.each(['C:inside.md', 'inside.md:stream', 'NUL.md', 'dir/CON.txt', '\\rooted.md'])('rejects Windows path aliases: %s', async (path) => {
    const root = await fixture();
    await expect(readWorkspaceSource(root, path)).rejects.toThrow('sourcePath must stay inside workspace');
  });

  it('rejects a directory link whose real target is outside the workspace', async () => {
    const root = await fixture();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'source.md'), '# outside fixture');
    await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readWorkspaceSource(workspace, 'linked/source.md')).rejects.toThrow('sourcePath must stay inside workspace');
  });

  it('allows links that stay inside the workspace and names beginning with two dots', async () => {
    const root = await fixture();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', '..notes.md'), '# safe');
    await symlink(join(root, 'docs'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readWorkspaceSource(root, 'linked/..notes.md')).resolves.toBe('# safe');
    await expect(readWorkspaceSource(root, 'docs/../docs/..notes.md')).resolves.toBe('# safe');
    await writeFile(join(root, '..notes.md'), '# root notes');
    await expect(readWorkspaceSource(root, '..notes.md')).resolves.toBe('# root notes');
  });
});
