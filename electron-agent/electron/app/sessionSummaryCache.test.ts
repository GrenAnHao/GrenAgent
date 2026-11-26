import { mkdir, mkdtemp, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from './workspaceService.js';
import { SESSION_SUMMARY_FILENAME } from './sessionSummaryCache.js';

const activity = vi.hoisted(() => ({ active: 0, peak: 0 }));
vi.mock('node:fs/promises', async load => {
  const fs = await load<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    rename: vi.fn(fs.rename),
    readFile: vi.fn(async (...args: Parameters<typeof fs.readFile>) => {
      if (!String(args[0]).endsWith('.jsonl')) return fs.readFile(...args);
      activity.peak = Math.max(activity.peak, ++activity.active);
      try { return await fs.readFile(...args); } finally { activity.active--; }
    }),
  };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
  activity.peak = 0;
});

async function profile() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-summary-cache-'));
  roots.push(dir);
  const sessions = join(dir, 'sessions', 'encoded');
  await mkdir(sessions, { recursive: true });
  const file = (id: string) => join(sessions, id + '.jsonl');
  const write = async (id: string, cwd: string, title: string, extra: unknown[] = []) => {
    await writeFile(file(id), [
      { type: 'session', id, cwd }, { type: 'session_info', name: title },
      { type: 'message', message: { role: 'assistant', content: 'raw reply must stay in JSONL' } }, ...extra,
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return file(id);
  };
  return { dir, cache: join(dir, SESSION_SUMMARY_FILENAME), file, write, restart: () => new WorkspaceService(dir) };
}
const bodyReads = () => vi.mocked(readFile).mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.jsonl'));
const headerOpens = () => vi.mocked(open).mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.jsonl'));

it('checks the remembered source without opening the catalog, then reuses its summary without rewriting the index', async () => {
  const p = await profile();
  const path = await p.write('remembered', p.dir, 'remembered');
  await p.write('unrelated', p.dir, 'another');
  await p.restart().listAllSessions();
  const warm = p.restart();
  vi.clearAllMocks();
  await expect(warm.lookupStartupSession(path)).resolves.toMatchObject({ path, cwd: p.dir });
  expect(bodyReads()).toEqual([path]);
  expect(vi.mocked(readFile).mock.calls.map(([p]) => String(p))).not.toContain(p.cache);
  await warm.listAllSessions();
  expect(bodyReads()).toEqual([path]);
  expect(vi.mocked(rename)).not.toHaveBeenCalled();
});

it('shares bounded source reads across concurrent lists, then restarts with no body or header reads for unchanged files', async () => {
  const p = await profile();
  const paths = await Promise.all(Array.from({ length: 18 }, (_, i) => p.write('s' + i, 'project-' + i % 2, 'title ' + i)));
  const first = p.restart();
  await Promise.all([first.listAllSessions(), first.listSessions('project-0'), first.listAllSessions()]);
  expect(bodyReads().sort()).toEqual(paths.sort());
  expect(activity.peak).toBeLessThanOrEqual(4);
  expect(await readFile(p.cache, 'utf8')).not.toContain('raw reply');

  const warm = p.restart();
  vi.clearAllMocks();
  expect(await warm.listSessions('project-1')).toHaveLength(9);
  expect(await warm.listAllSessions()).toHaveLength(18);
  expect(bodyReads()).toEqual([]);
  expect(headerOpens()).toEqual([]);

  const changed = await p.write('s2', 'new-project', 'renamed to a longer title');
  const added = await p.write('added', 'new-project', 'new');
  await rm(p.file('s3'));
  const next = p.restart();
  const list = await next.listAllSessions();
  expect(list.filter(s => s.cwd === 'new-project').map(s => s.path).sort()).toEqual([added, changed].sort());
  expect(list.some(s => s.path === p.file('s3'))).toBe(false);
  expect(bodyReads().sort()).toEqual([added, changed].sort());
  expect((await readFile(p.cache, 'utf8'))).not.toContain('s3.jsonl');
});

it('recognizes same-size/same-mtime replacement after restart and honors explicit invalidation before the first lookup', async () => {
  const p = await profile();
  const path = await p.write('a', 'project-a', 'old');
  const pinned = new Date('2026-01-01T00:00:00Z');
  await utimes(path, pinned, pinned);
  await p.restart().listAllSessions();
  const replacement = await p.write('b', 'project-b', 'new');
  await utimes(replacement, pinned, pinned);
  await rename(replacement, path);
  vi.clearAllMocks();
  await expect(p.restart().listAllSessions()).resolves.toMatchObject([{ name: 'new', cwd: 'project-b' }]);
  expect(bodyReads()).toEqual([path]);
  const next = p.restart();
  vi.clearAllMocks();
  await next.invalidateSessionRecords([path]);
  await expect(next.listAllSessions()).resolves.toMatchObject([{ name: 'new' }]);
  expect(bodyReads()).toEqual([path]);
});

it('rebuilds missing, malformed and incompatible caches and never follows a cache-supplied path', async () => {
  const p = await profile();
  const other = await profile();
  const a = await p.write('s', 'project-a', 'own');
  const b = await other.write('s', 'project-b', 'other');
  await p.restart().listAllSessions();
  const original = JSON.parse(await readFile(p.cache, 'utf8'));
  const forged = structuredClone(original);
  forged.rows[0].value.info.path = b;
  for (const bad of ['[', JSON.stringify({ ...original, version: -1 }), JSON.stringify(forged)]) {
    await writeFile(p.cache, bad);
    vi.clearAllMocks();
    await expect(p.restart().listAllSessions()).resolves.toMatchObject([{ path: a, name: 'own' }]);
    expect(bodyReads()).toEqual([a]);
  }
  await writeFile(other.cache, JSON.stringify(original));
  vi.clearAllMocks();
  await expect(other.restart().listAllSessions()).resolves.toMatchObject([{ path: b, name: 'other' }]);
  expect(bodyReads()).toEqual([b]);
});

it('preserves explicit oversized titles on disk hits; failed cache writes do not hide history', async () => {
  const p = await profile();
  await p.write('s', 'project', 'old');
  await p.restart().listAllSessions();
  const title = 'L'.repeat(32 * 1024);
  await p.write('s', 'project', title);
  await expect(p.restart().listAllSessions()).resolves.toMatchObject([{ name: title }]);
  vi.clearAllMocks();
  await expect(p.restart().listAllSessions()).resolves.toMatchObject([{ name: title }]);
  expect(bodyReads()).toEqual([]);
  await rm(p.cache);
  await mkdir(p.cache); // deterministic rename failure, even as admin
  await p.write('s', 'project', 'normal');
  await expect(p.restart().listAllSessions()).resolves.toMatchObject([{ name: 'normal' }]);
});

it('does not reread history for warm startup lists, retention and cleanup; confirms real sources before deleting actual or suspected orphans', async () => {
  const p = await profile(), cold = p.restart();
  const active = (await cold.createConversation()).cwd, retained = (await cold.createConversation()).cwd;
  await p.write('active', active, 'active');
  await p.write('moved', 'other-project', 'moved', [{
    type: 'custom', customType: 'session_project_transfer',
    data: { version: 1, operationId: 'op', fromWorkspace: retained, toWorkspace: 'other-project', retentionRoots: [retained] },
  }]);
  await cold.listAllSessions();
  const warm = p.restart();
  vi.clearAllMocks();
  await Promise.all([warm.listAllSessions(), warm.listSessions(active), warm.pruneOrphanConversations([])]);
  expect(await warm.retentionRoots()).toEqual([retained]);
  expect(bodyReads()).toEqual([]);
  // A structurally valid but incorrect display summary must not let prune delete real data.
  const doc = JSON.parse(await readFile(p.cache, 'utf8'));
  for (const row of doc.rows) { row.value.info.cwd = 'wrong'; row.value.retentionRoots = []; }
  await writeFile(p.cache, JSON.stringify(doc));
  const candidate = join(p.dir, 'works', 'true-orphan');
  await mkdir(candidate);
  const next = p.restart();
  next.setSubagentControl({ release: async () => {}, releaseChildForDelete: async () => ({ quiescent: true }) });
  expect(await next.pruneOrphanConversations([])).toBe(1);
  expect(bodyReads().sort()).toEqual([p.file('active'), p.file('moved')].sort());
  await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(active)).isDirectory()).toBe(true);
  expect((await stat(retained)).isDirectory()).toBe(true);
});
