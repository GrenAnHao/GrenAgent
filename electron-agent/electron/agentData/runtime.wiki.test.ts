import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { AgentDataStorage } from './storage';
import { WikiStore } from './wikiStore';
import { JobStore } from './jobStore';
import type { WikiLibraryView, WikiPage, WikiSource } from './wikiContracts';

describe('Wiki project and management boundaries', () => {
  it('keeps stable deleting targets discoverable after their active resource lists stop showing them', async () => {
    let release!: (value: string) => void;
    const execute = vi.fn<() => Promise<string>>().mockResolvedValueOnce('# initial').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', executeServiceTask: execute, wikiModelLabel: async () => 'fixture/model' });
    const host = new AgentDataClient(await runtime.start());
    const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '删除恢复', description: '', bindings: [] });
    const source = await runtime.requestAdmin<WikiSource>('wiki.sources.create', { kbId: kb.kbId, kind: 'manual', name: 'a.md', content: 'A' });
    const first = await runtime.requestAdmin<{ jobId: string }>('wiki.libraries.ingest', { kbId: kb.kbId });
    await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: first.jobId })).toMatchObject({ state: 'completed' }));
    await runtime.requestAdmin('wiki.sources.update', { kbId: kb.kbId, sourceId: source.sourceId, content: 'B', expected: source });
    const next = await runtime.requestAdmin<{ jobId: string }>('wiki.libraries.ingest', { kbId: kb.kbId });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    try {
      await expect(runtime.requestAdmin('wiki.pages.remove', { kbId: kb.kbId, pageId: source.generatedPageId, cancelActive: false })).resolves.toMatchObject({ state: 'waiting' });
      await expect(runtime.requestAdmin('wiki.sources.remove', { kbId: kb.kbId, sourceId: source.sourceId, cancelActive: false })).resolves.toMatchObject({ state: 'waiting' });
      await expect(runtime.requestAdmin('wiki.libraries.read', { kbId: kb.kbId })).resolves.toMatchObject({ deletingTargets: expect.arrayContaining([
        { kind: 'page', kbId: kb.kbId, pageId: source.generatedPageId }, { kind: 'source', kbId: kb.kbId, sourceId: source.sourceId },
      ]) });
    } finally {
      release('# late');
      await vi.waitFor(async () => expect(await host.request('admin.jobs.get', { id: next.jobId })).toMatchObject({ state: 'completed' }));
      await runtime.requestAdmin('wiki.pages.remove', { kbId: kb.kbId, pageId: source.generatedPageId, cancelActive: false });
      await runtime.requestAdmin('wiki.sources.remove', { kbId: kb.kbId, sourceId: source.sourceId, cancelActive: false });
      await host.close(); runtime.close(); await runtime.waitClosed();
    }
  });

  it('does not expose or mutate Wiki jobs through generic project job commands', async () => {
    let release!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', executeServiceTask: execute, wikiModelLabel: async () => 'fixture/model', validateProject: async (p) => p });
    const host = new AgentDataClient(await runtime.start()), project = new AgentDataClient(runtime.agentEndpoint('D:/a'));
    const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '其它库', description: '', bindings: ['D:/b'] });
    await runtime.requestAdmin('wiki.sources.create', { kbId: kb.kbId, kind: 'manual', name: 'source.md', content: 'A' });
    const receipt = await runtime.requestAdmin<{ jobId: string }>('wiki.libraries.ingest', { kbId: kb.kbId, expectedModel: 'fixture/model' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    try {
      await expect(project.request('admin.jobs.cancel', { id: receipt.jobId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const method of ['get', 'markCancelled', 'complete', 'fail', 'progress', 'start', 'remove']) {
        await expect(project.request(`admin.jobs.${method}`, { id: receipt.jobId, error: 'spoof', value: 100 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      await expect(project.request('admin.jobs.clear', { ids: [receipt.jobId] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(project.request('admin.jobs.list')).resolves.toEqual([]);
      await expect(project.request('admin.export')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(project.request('admin.audit.list')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(project.request('admin.jobs.create', { kind: 'wiki.sync', workspace: 'D:/a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(host.request('admin.jobs.get', { id: receipt.jobId })).resolves.toMatchObject({ state: 'running' });
    } finally {
      release('# complete');
      await vi.waitFor(async () => expect(await host.request<{ state: string }>('admin.jobs.get', { id: receipt.jobId })).toMatchObject({ state: expect.stringMatching(/completed|failed|cancelled/) }));
      await project.close(); await host.close(); runtime.close(); await runtime.waitClosed();
    }
  });

  it('recovers interrupted Wiki writers without replaying the model on startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-runtime-recovery-')); const dataPath = join(root, 'data.db');
    const seed = new AgentDataStorage(dataPath); seed.migrate(); const jobs = new JobStore(seed.db);
    const job = jobs.create({ kind: 'wiki.sync', workspace: 'D:/legacy' }); jobs.start(job.id);
    seed.db.prepare('INSERT INTO service_tasks(id,kind,is_system,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('orphan-wiki-worker', 'wiki_page_generate', 1, 'running', JSON.stringify({ source: 'A' }), 1, 1, 1);
    seed.close();
    const execute = vi.fn(async () => '# must not replay');
    const runtime = new AgentDataRuntime({ dataPath, executeServiceTask: execute }); const client = new AgentDataClient(await runtime.start());
    try {
      await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'failed', error: expect.stringContaining('INTERRUPTED') });
      expect(execute).not.toHaveBeenCalled();
    } finally { await client.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('binds access to project credentials and immediately enforces unbinding', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject: async (p) => p });
    const root = new AgentDataClient(await runtime.start());
    let a: AgentDataClient | undefined; let b: AgentDataClient | undefined;
    try {
      expect(runtime).toHaveProperty('agentEndpoint', expect.any(Function));
      a = new AgentDataClient(runtime.agentEndpoint('D:/a')); b = new AgentDataClient(runtime.agentEndpoint('D:/b'));
      const library = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '共享', description: '', bindings: ['D:/a', 'D:/b'] });
      const visible = await a.request<Record<string, unknown>[]>('wiki.libraries.list');
      expect(visible).toHaveLength(1);
      expect(visible[0]).not.toHaveProperty('storageKey'); expect(visible[0]).not.toHaveProperty('location');
      await expect(a.request('wiki.libraries.list', { workspace: 'D:/b' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(a.request('wiki.libraries.create', { name: '伪管理', admin: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(root.request('wiki.libraries.create', { name: 'root socket' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await runtime.requestAdmin('wiki.libraries.update', { kbId: library.kbId, name: library.name, description: '', bindings: ['D:/b'], expectedRevision: library.revision });
      await expect(a.request('wiki.libraries.list')).resolves.toEqual([]);
      await expect(a.request('wiki.pages.list', { kbId: library.kbId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(b.request('wiki.pages.list', { kbId: library.kbId })).resolves.toEqual([]);
    } finally { await a?.close(); await b?.close(); await root.close(); runtime.close(); }
  });

  it('searches only explicitly bound libraries while legacy reads remain empty for an unmapped project', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject: async (p) => p });
    await runtime.start(); let client: AgentDataClient | undefined;
    try {
      expect(runtime).toHaveProperty('requestAdmin', expect.any(Function));
      const a = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '一', description: '', bindings: ['D:/a'] });
      const b = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '二', description: '', bindings: ['D:/a'] });
      const hidden = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '全局管理', description: '', bindings: [] });
      for (const kb of [a, b, hidden]) await runtime.requestAdmin('wiki.pages.create', { kbId: kb.kbId, title: 'guide', content: '# sharedkeyword', sourceRefs: [] });
      client = new AgentDataClient(runtime.agentEndpoint('D:/a'));
      await expect(client.request('wiki.pages.search', { query: 'sharedkeyword' })).resolves.toHaveLength(2);
      await expect(client.request('wiki.search', { query: 'sharedkeyword' })).resolves.toEqual([]);
      await expect(client.request('wiki.list')).resolves.toEqual([]);
      await expect(client.request('wiki.sources.list', { kbId: a.kbId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(client.request('wiki.pages.search', { kbId: hidden.kbId, query: 'sharedkeyword' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await runtime.requestAdmin('wiki.libraries.update', { kbId: a.kbId, name: a.name, description: '', bindings: [], expectedRevision: a.revision });
      await expect(client.request('wiki.pages.search', { query: 'sharedkeyword' })).resolves.toEqual([expect.objectContaining({ kbId: b.kbId })]);
    } finally { await client?.close(); runtime.close(); }
  });

  it('keeps legacy IDs and rejects all legacy operations once that library is unbound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-runtime-legacy-')); const dataPath = join(root, 'data.db'); const wikiRootDir = join(root, 'wiki');
    const seed = new AgentDataStorage(dataPath); seed.migrate();
    new WikiStore(seed.db, wikiRootDir).replacePage({ workspace: 'D:/legacy' }, 'guide', 'Guide', '# legacyword'); seed.close();
    const runtime = new AgentDataRuntime({ dataPath, wikiRootDir, validateProject: async (p) => p });
    await runtime.start(); let client: AgentDataClient | undefined;
    try {
      expect(runtime).toHaveProperty('agentEndpoint', expect.any(Function));
      client = new AgentDataClient(runtime.agentEndpoint('D:/legacy'));
      await expect(client.request('wiki.read', { workspace: 'D:/legacy', page: 'guide' })).resolves.toMatchObject({ page: 'guide', content: '# legacyword' });
      const [library] = await runtime.requestAdmin<WikiLibraryView[]>('wiki.libraries.list');
      await runtime.requestAdmin('wiki.libraries.update', { kbId: library.kbId, name: library.name, description: '', bindings: [], expectedRevision: library.revision });
      for (const method of ['wiki.read', 'wiki.list', 'wiki.search', 'wiki.replace', 'wiki.reindex']) {
        await expect(client.request(method, { workspace: 'D:/legacy', page: 'guide', title: 'x', content: 'x', query: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    } finally { await client?.close(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves version errors for IPC, accepts empty Markdown, and never generates on CRUD', async () => {
    const generate = vi.fn(async () => '# generated');
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject: async (p) => p, executeServiceTask: generate, wikiModelLabel: async () => 'fixture/model' });
    await runtime.start();
    try {
      expect(runtime).toHaveProperty('requestAdmin', expect.any(Function));
      const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '编辑', description: '', bindings: [] });
      const page = await runtime.requestAdmin<WikiPage>('wiki.pages.create', { kbId: kb.kbId, title: '空页', content: '', sourceRefs: [] });
      const changed = await runtime.requestAdmin<WikiPage>('wiki.pages.update', { kbId: kb.kbId, pageId: page.pageId, title: page.title, content: '# new', sourceRefs: [], expected: page });
      await expect(runtime.requestAdmin('wiki.pages.update', { kbId: kb.kbId, pageId: page.pageId, title: page.title, content: 'stale', sourceRefs: [], expected: page })).rejects.toThrow('VERSION_CONFLICT');
      expect(changed.locked).toBe(true);
      const source = await runtime.requestAdmin<WikiSource>('wiki.sources.create', { kbId: kb.kbId, kind: 'manual', name: 'a.md', content: 'A' });
      await runtime.requestAdmin('wiki.sources.update', { kbId: kb.kbId, sourceId: source.sourceId, content: 'B', expected: source });
      await expect(runtime.requestAdmin('wiki.sources.read', { kbId: kb.kbId, sourceId: source.sourceId, revision: 1 })).resolves.toMatchObject({ content: 'A', version: { revision: 1, contentHash: source.contentHash } });
      await runtime.requestAdmin('wiki.libraries.reindex', { kbId: kb.kbId });
      expect(generate).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });
});
