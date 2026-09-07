import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WikiStore } from '../agentData/wikiStore';
import { AgentDataDiagnostics } from './agentDataDiagnostics';
import { CodeGraphService } from './codeGraph/codeGraphService';

const fixtures: Array<{ db: DatabaseSync; root: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, root } of fixtures.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-diagnostics-')); const db = new DatabaseSync(':memory:');
  fixtures.push({ db, root });
  const wiki = new WikiStore(db, root); const libraries = wiki.libraries;
  const library = libraries.create({ name: 'Diagnostics', description: '', bindings: [] });
  const page = wiki.createManual(library.kbId, { title: 'Guide', content: 'body', sourceRefs: [] });
  return { db, root, wiki, libraries, library, page };
}

describe('AgentDataDiagnostics', () => {
  it('checks existing metadata only and leaves SQL and Markdown unchanged', async () => {
    const f = fixture();
    const status = vi.fn(() => ({ indexed: true, connected: true, files: 2, nodes: 3, edges: 1 }));
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [{ workspace: '/known', indexed: true }], codeStatus: status });
    const snapshot = () => Object.fromEntries((f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]));
    const rows = snapshot(); const text = readFileSync(f.page.path, 'utf8');
    const rebuild = vi.spyOn(f.wiki, 'reindexLibrary'); const register = vi.spyOn(f.wiki.sources, 'registerLegacy');
    const report = await service.check();
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: '/known' }, state: 'ok' }));
    expect(report.checkedAt).toEqual(expect.any(Number)); expect(status).toHaveBeenCalledExactlyOnceWith('/known');
    expect(snapshot()).toEqual(rows); expect(readFileSync(f.page.path, 'utf8')).toBe(text);
    expect(rebuild).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });

  it('distinguishes a known missing CLI from unknown counters or connection failures', async () => {
    const f = fixture();
    const statuses = {
      '/missing': { indexed: true, connected: false, state: 'cli_missing' },
      '/unknown': { indexed: true, connected: true, state: 'indexed' },
      '/disconnected': { indexed: true, connected: false, state: 'unavailable' },
      '/unindexed': { indexed: false, connected: false, state: 'unavailable' },
    };
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => Object.keys(statuses).map((workspace) => ({ workspace })), codeStatus: (workspace) => statuses[workspace as keyof typeof statuses] });
    const report = await service.check();
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: '/missing' }, state: 'action_required', action: 'configure_codegraph' }));
    for (const workspace of ['/unknown', '/disconnected', '/unindexed']) expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: workspace }, state: 'unchecked' }));
    expect(report.items.filter((item) => item.resource?.type === 'project' && item.state === 'ok')).toHaveLength(0);
  });

  it('reports SDK loading failures without attempting CLI installation or indexing', async () => {
    const f = fixture();
    const loadSdk = vi.fn(async () => { throw new Error('platform package is absent'); });
    const code = new CodeGraphService({ listWorkspaces: () => [f.root], loadSdk });
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => code.projects(), codeStatus: (workspace) => code.status(workspace) });
    const report = await service.check();
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: f.root }, state: 'action_required', message: expect.stringContaining('SDK') }));
    expect(loadSdk).toHaveBeenCalledOnce();
    await code.close();
  });

  it('awaits SDK status and does not call an incomplete index healthy', async () => {
    const f = fixture();
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [{ workspace: '/partial' }],
      codeStatus: async () => ({ indexed: true, connected: true, files: 2, nodes: 3, edges: 1, state: 'partial' }) });
    const item = (await service.check()).items.find((entry) => entry.resource?.id === '/partial');
    expect(item?.state).toBe('action_required');
  });

  it('reports absent code projects as unchecked without a status probe', async () => {
    const f = fixture(); const status = vi.fn();
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [], codeStatus: status });
    const report = await service.check();
    expect(report.items).toContainEqual(expect.objectContaining({ id: 'code:unchecked', state: 'unchecked' }));
    expect(status).not.toHaveBeenCalled();
  });

  it('isolates failed status checks and damaged Wiki libraries from healthy ones', async () => {
    const f = fixture(); const healthy = f.libraries.create({ name: 'Healthy', description: '', bindings: [] });
    writeFileSync(f.page.path, '---\nlocked: [broken\n---\nbody');
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [{ workspace: '/failed' }, { workspace: '/healthy' }], codeStatus: (workspace) => {
      if (workspace === '/failed') throw new Error('cached status inaccessible');
      return { connected: true, indexed: true, files: 0, nodes: 0, edges: 0 };
    } });
    const report = await service.check();
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'wiki', id: f.library.kbId }, state: 'action_required', path: f.page.path }));
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'wiki', id: healthy.kbId }, state: 'ok' }));
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: '/failed' }, state: 'unchecked' }));
    expect(report.items).toContainEqual(expect.objectContaining({ resource: { type: 'project', id: '/healthy' }, state: 'ok' }));
  });

  it('resolves only issued diagnostic IDs and revalidates the library before opening', async () => {
    const f = fixture(); writeFileSync(f.page.path, '---\nlocked: [broken\n---\nbody');
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [], codeStatus: () => ({}) });
    await expect(service.resolveOpenPath(f.page.path)).rejects.toThrow('INVALID_DIAGNOSTIC: invalid diagnostic ID');
    const report = await service.check(); const issue = report.items.find((item) => item.action === 'open_file')!;
    await expect(service.resolveOpenPath(issue.id)).resolves.toBe(f.page.path);
    await expect(service.resolveOpenPath(`${issue.id}-forged`)).rejects.toThrow('INVALID_DIAGNOSTIC: invalid diagnostic ID');
    f.libraries.beginDelete({ kind: 'library', kbId: f.library.kbId });
    await expect(service.resolveOpenPath(issue.id)).rejects.toThrow('INVALID_DIAGNOSTIC:');
  });

  it('rejects a known path after its parent is replaced by an outside junction', async () => {
    const f = fixture(); writeFileSync(f.page.path, '---\nlocked: [broken\n---\nbody');
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [], codeStatus: () => ({}) });
    const issue = (await service.check()).items.find((item) => item.action === 'open_file')!;
    const wikiDir = dirname(f.page.path); const outside = join(f.root, 'outside'); mkdirSync(outside);
    renameSync(wikiDir, `${wikiDir}-original`);
    symlinkSync(outside, wikiDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.resolveOpenPath(issue.id)).rejects.toThrow('INVALID_DIAGNOSTIC:');
  });

  it('does not publish open-file actions or paths outside the registered library', async () => {
    const f = fixture(); const outside = join(f.root, 'outside.md'); writeFileSync(outside, 'private');
    vi.spyOn(f.wiki, 'inspect').mockReturnValue([{ id: 'external', resource: { type: 'wiki', id: f.library.kbId }, checkedAt: 1, state: 'action_required', message: 'unsafe', action: 'open_file', path: outside }]);
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [], codeStatus: () => ({}) });
    const report = await service.check(); const issue = report.items.find((item) => item.id === 'external')!;
    expect(issue.path).toBeUndefined(); expect(issue.action).toBeUndefined();
    await expect(service.resolveOpenPath(issue.id)).rejects.toThrow(/diagnostic|诊断/i);
  });

  it('suppresses an open action if the diagnostic has no validated path', async () => {
    const f = fixture();
    vi.spyOn(f.wiki, 'inspect').mockReturnValue([{ id: 'missing-path', resource: { type: 'wiki', id: f.library.kbId }, checkedAt: 1, state: 'action_required', message: 'missing file', action: 'open_file' }]);
    const service = new AgentDataDiagnostics({ ...f, codeProjects: () => [], codeStatus: () => ({}) });
    expect((await service.check()).items.find((item) => item.id === 'missing-path')?.action).toBeUndefined();
  });
});
