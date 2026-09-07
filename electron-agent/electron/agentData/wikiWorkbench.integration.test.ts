import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import type { Job } from './jobStore';
import type { WikiImportPreview, WikiIngestPreview, WikiIngestReceipt, WikiLibraryView, WikiPage, WikiReindexResult, WikiSource } from './wikiContracts';

it('manages a shared library end to end without changing project originals or losing history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-workbench-flow-'));
  const a = join(root, 'project-a'), b = join(root, 'project-b'); mkdirSync(a); mkdirSync(b); mkdirSync(join(root, 'app'));
  writeFileSync(join(a, 'README.md'), '# Source A'); writeFileSync(join(b, 'README.md'), '# Source B');
  const generate = vi.fn(async () => '# searchable generated');
  const runtime = new AgentDataRuntime({ dataPath: join(root, 'app', 'data.db'), validateProject: async (p) => p, wikiModelLabel: async () => 'fixture/model', executeServiceTask: generate });
  const host = new AgentDataClient(await runtime.start()), agentA = new AgentDataClient(runtime.agentEndpoint(a)), agentB = new AgentDataClient(runtime.agentEndpoint(b));
  async function finish(jobId: string): Promise<Job> {
    let result: Job | undefined;
    await vi.waitFor(async () => { result = await host.request<Job>('admin.jobs.get', { id: jobId }); expect(['pending', 'running']).not.toContain(result.state); });
    return result!;
  }
  async function ingest(kbId: string, regenerateSourceIds?: string[]) {
    const preview = await runtime.requestAdmin<WikiIngestPreview>('wiki.libraries.previewIngest', { kbId, regenerateSourceIds });
    const receipt = await runtime.requestAdmin<WikiIngestReceipt>('wiki.libraries.ingest', { kbId, sourceIds: preview.sourceIds, regenerateSourceIds, expectedModel: preview.model });
    const job = await finish(receipt.jobId); expect(job.state).toBe('completed'); expect(job.workspace).toBe('');
    expect(job.metadata?.target).toEqual({ type: 'wiki', id: kbId }); return job;
  }
  try {
    const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '共享手册', description: '两项目共用一份正文', bindings: [a, b] });
    const inputs: WikiSource[] = [];
    for (const projectWorkspace of [a, b]) {
      const preview = await runtime.requestAdmin<WikiImportPreview>('wiki.sources.previewImport', { kbId: kb.kbId, projectWorkspace, relativePath: 'README.md' });
      inputs.push(await runtime.requestAdmin<WikiSource>('wiki.sources.create', { kbId: kb.kbId, kind: 'project', projectWorkspace, relativePath: preview.relativePath, expectedContentHash: preview.contentHash }));
    }
    expect(inputs[0].sourceId).not.toBe(inputs[1].sourceId); expect(generate).not.toHaveBeenCalled();
    const first = await ingest(kb.kbId); expect(generate).toHaveBeenCalledTimes(2);
    const pageA = await runtime.requestAdmin<WikiPage>('wiki.pages.read', { kbId: kb.kbId, pageId: inputs[0].generatedPageId });
    const manual = await runtime.requestAdmin<WikiPage>('wiki.pages.update', { kbId: kb.kbId, pageId: pageA.pageId, title: '人工校订', content: '# keep manual', sourceRefs: pageA.sourceRefs, expected: pageA });
    expect(manual.locked).toBe(true);
    const updates = await Promise.all(inputs.map((source) => runtime.requestAdmin<WikiSource>('wiki.sources.update', { kbId: kb.kbId, sourceId: source.sourceId, content: `${source.name} revision2`, expected: source })));
    await ingest(kb.kbId); expect(generate).toHaveBeenCalledTimes(3);
    await expect(runtime.requestAdmin('wiki.pages.read', { kbId: kb.kbId, pageId: manual.pageId })).resolves.toMatchObject({ content: '# keep manual' });
    await runtime.requestAdmin('wiki.libraries.update', { kbId: kb.kbId, name: kb.name, description: kb.description, bindings: [b], expectedRevision: kb.revision });
    await expect(agentA.request('wiki.pages.search', { kbId: kb.kbId, query: 'searchable' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(agentB.request('wiki.pages.search', { query: 'searchable' })).resolves.toHaveLength(1);
    await runtime.requestAdmin('wiki.sources.remove', { kbId: kb.kbId, sourceId: inputs[0].sourceId, cancelActive: false });
    await expect(runtime.requestAdmin('wiki.sources.read', { kbId: kb.kbId, sourceId: inputs[0].sourceId, revision: 1 })).resolves.toMatchObject({ source: { lifecycle: 'deleted' }, content: '# Source A' });
    expect(existsSync(manual.path)).toBe(true);
    await runtime.requestAdmin('wiki.pages.remove', { kbId: kb.kbId, pageId: inputs[1].generatedPageId, cancelActive: false });
    await runtime.requestAdmin('wiki.sources.update', { kbId: kb.kbId, sourceId: updates[1].sourceId, content: 'new after page deletion', expected: updates[1] });
    await expect(runtime.requestAdmin('wiki.libraries.previewIngest', { kbId: kb.kbId })).resolves.toMatchObject({ targetCount: 0 });
    await expect(runtime.requestAdmin('wiki.libraries.ingest', { kbId: kb.kbId })).rejects.toThrow('NO_PENDING_SOURCES');
    const last = await ingest(kb.kbId, [inputs[1].sourceId]); expect(generate).toHaveBeenCalledTimes(4);
    await expect(runtime.requestAdmin('wiki.libraries.remove', { kbId: kb.kbId, cancelActive: false })).resolves.toEqual({ state: 'deleted' });
    await expect(runtime.requestAdmin('wiki.libraries.list')).resolves.toEqual([]);
    expect(existsSync(join(kb.location, 'library.json'))).toBe(true); expect(existsSync(join(kb.location, 'wiki'))).toBe(false);
    expect(readFileSync(join(a, 'README.md'), 'utf8')).toBe('# Source A'); expect(readFileSync(join(b, 'README.md'), 'utf8')).toBe('# Source B');
    await expect(host.request('admin.jobs.get', { id: first.id })).resolves.toMatchObject({ state: 'completed' });
    await expect(host.request('admin.jobs.get', { id: last.id })).resolves.toMatchObject({ state: 'completed' });
    expect((await host.request<unknown[]>('admin.audit.list')).length).toBeGreaterThan(0);
  } finally { await agentA.close(); await agentB.close(); await host.close(); runtime.close(); await runtime.waitClosed(); rmSync(root, { recursive: true, force: true }); }
});

it('reports damaged Markdown without changing it, erasing the old index, or calling a model', async () => {
  const generate = vi.fn(async () => '# unused'); const runtime = new AgentDataRuntime({ dataPath: ':memory:', executeServiceTask: generate }); await runtime.start();
  try {
    const kb = await runtime.requestAdmin<WikiLibraryView>('wiki.libraries.create', { name: '诊断', description: '', bindings: [] });
    const page = await runtime.requestAdmin<WikiPage>('wiki.pages.create', { kbId: kb.kbId, title: '保留索引', content: '# searchable', sourceRefs: [] });
    const damaged = '---\nlocked: [broken\n---\n\n# damaged'; writeFileSync(page.path, damaged);
    const result = await runtime.requestAdmin<WikiReindexResult>('wiki.libraries.reindex', { kbId: kb.kbId });
    expect(result.pages).toBe(0); expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'PAGE_PARSE_FAILED', path: page.path })]);
    await expect(runtime.requestAdmin('wiki.libraries.read', { kbId: kb.kbId })).resolves.toMatchObject({ pageCount: 1 });
    await expect(runtime.requestAdmin('wiki.pages.read', { kbId: kb.kbId, pageId: page.pageId })).rejects.toThrow();
    expect(readFileSync(page.path, 'utf8')).toBe(damaged); expect(generate).not.toHaveBeenCalled();
  } finally { runtime.close(); await runtime.waitClosed(); }
});
