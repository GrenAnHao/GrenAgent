import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { WikiStore, chunkMarkdown } from './wikiStore';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(renameSync).mockReset();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-files-'));
  const db = new DatabaseSync(':memory:');
  roots.push(root);
  databases.push(db);
  return { root, db, store: new WikiStore(db, root) };
}

function legacy(db: DatabaseSync, page = 'guide', content = '# Legacy\nold text') {
  db.prepare('INSERT INTO wiki_pages(workspace,page,title,content,source_path,content_hash,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('/a', page, 'Legacy', content, 'README.md', 'old-hash', 1234);
}

function bucket(root: string, path: string): string {
  return join(root, relative(root, path).split(sep)[0]);
}

describe('WikiStore', () => {
  it('inspects hashes and index metadata without changing SQL, files or rebuilding', () => {
    const { db, store } = fixture();
    const library = store.libraries.create({ name: 'Checks', description: '', bindings: [] });
    const page = store.createManual(library.kbId, { title: 'Guide', content: '# Original', sourceRefs: [] });
    expect(store.inspect(library.kbId)).toEqual([expect.objectContaining({ resource: { type: 'wiki', id: library.kbId }, state: 'ok' })]);
    writeFileSync(page.path, readFileSync(page.path, 'utf8').replace('# Original', '# Changed'));
    const snapshot = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const sqlBefore = snapshot(); const textBefore = readFileSync(page.path, 'utf8');
    const reindex = vi.spyOn(store, 'reindexLibrary'); const register = vi.spyOn(store.sources, 'registerLegacy');
    const result = store.inspect(library.kbId);
    expect(result).toContainEqual(expect.objectContaining({ state: 'action_required', action: 'reindex_wiki', path: page.path }));
    expect(result.some((item) => item.state === 'ok')).toBe(false);
    expect(snapshot()).toEqual(sqlBefore); expect(readFileSync(page.path, 'utf8')).toBe(textBefore);
    expect(reindex).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });

  it('reports a precise malformed Markdown file while still checking other libraries', () => {
    const { store } = fixture();
    const bad = store.libraries.create({ name: 'Bad', description: '', bindings: [] });
    const good = store.libraries.create({ name: 'Good', description: '', bindings: [] });
    const page = store.createManual(bad.kbId, { title: 'Bad', content: 'body', sourceRefs: [] });
    writeFileSync(page.path, '---\nlocked: [broken\n---\n# Body');
    const results = store.inspect();
    expect(results).toContainEqual(expect.objectContaining({ resource: { type: 'wiki', id: bad.kbId }, state: 'action_required', action: 'open_file', path: page.path }));
    expect(results).toContainEqual(expect.objectContaining({ resource: { type: 'wiki', id: good.kbId }, state: 'ok' }));
  });

  it('flags unindexed, removed and metadata-mismatched pages without repairing them', () => {
    const { db, store } = fixture();
    const library = store.libraries.create({ name: 'Checks', description: '', bindings: [] });
    const page = store.createManual(library.kbId, { title: 'Guide', content: '# Guide', sourceRefs: [] });
    db.prepare('UPDATE wiki_documents SET title=? WHERE kb_id=?').run('Stale title', library.kbId);
    expect(store.inspect(library.kbId)).toContainEqual(expect.objectContaining({ state: 'action_required', action: 'reindex_wiki' }));
    db.prepare('DELETE FROM wiki_documents WHERE kb_id=?').run(library.kbId);
    expect(store.inspect(library.kbId)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/未索引/) }));
    store.reindexLibrary(library.kbId);
    rmSync(page.path);
    const missing = store.inspect(library.kbId);
    expect(missing).toContainEqual(expect.objectContaining({ state: 'action_required', action: 'reindex_wiki', message: expect.stringMatching(/已移除/) }));
    expect(missing.some((item) => item.path)).toBe(false);
  });

  it('checks legacy source references without registering missing mappings', () => {
    const { db, store } = fixture();
    store.replacePage({ workspace: '/legacy-inspect' }, 'guide', 'Guide', 'body', 'source.ts', 'source');
    const library = store.libraries.resolveLegacy('/legacy-inspect')!;
    expect(store.inspect(library.kbId)).toEqual([expect.objectContaining({ state: 'ok' })]);
    db.prepare('DELETE FROM wiki_legacy_source_map WHERE kb_id=?').run(library.kbId);
    const register = vi.spyOn(store.sources, 'registerLegacy');
    expect(store.inspect(library.kbId)).toContainEqual(expect.objectContaining({ state: 'action_required' }));
    expect(register).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS count FROM wiki_legacy_source_map').get()).toMatchObject({ count: 0 });
  });

  it('does not report missing or deleting resources or unreadable indexes as healthy', () => {
    const { db, store } = fixture();
    expect(store.inspect('unknown')).toEqual([expect.objectContaining({ state: 'unchecked' })]);
    const library = store.libraries.create({ name: 'Checks', description: '', bindings: [] });
    store.libraries.beginDelete({ kind: 'library', kbId: library.kbId });
    expect(store.inspect(library.kbId)).toEqual([expect.objectContaining({ state: 'unchecked' })]);
    const active = store.libraries.create({ name: 'Active', description: '', bindings: [] });
    db.exec('DROP TABLE wiki_documents');
    expect(store.inspect(active.kbId)).toEqual([expect.objectContaining({ state: 'unchecked' })]);
  });

  it('does not issue open paths for symbolic links outside the storage bucket', () => {
    const { root, store } = fixture();
    const library = store.libraries.create({ name: 'Checks', description: '', bindings: [] });
    const outside = join(root, 'outside-inspect'); mkdirSync(outside);
    writeFileSync(join(outside, 'outside.md'), '---\nlocked: [broken\n---\nbody');
    const wikiDir = store.files.filePathAt(library, 'wiki'); mkdirSync(wikiDir);
    symlinkSync(outside, join(wikiDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const items = store.inspect(library.kbId);
    expect(items).toContainEqual(expect.objectContaining({ state: 'action_required' }));
    expect(items.some((item) => item.action === 'open_file' || item.path)).toBe(false);
  });

  it('retains indexed overview counts and exposes failures instead of reporting a damaged bucket as empty', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# preserved');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(page.path, '---\nlocked: [bad\n---\n# broken');
    expect(store.rebuildIndex().diagnostics.length).toBeGreaterThan(0);
    expect(store.overview({})).toMatchObject({ pages: 1, latestUpdatedAt: expect.any(Number) });
    expect(() => store.listPages({ workspace: '/a' })).toThrow(/scan|parse|invalid/i);
  });

  it('chunks markdown with headings and source lines', () => { const chunks = chunkMarkdown('# Intro\nhello\n## API\nworld', 'README.md'); expect(chunks).toHaveLength(2); expect(chunks[1]).toMatchObject({ title: 'API', startLine: 3, endLine: 4 }); });
  it('replaces and searches pages by workspace', () => { const { store } = fixture(); store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# API\nsearchable'); store.replacePage({ workspace: '/b' }, 'guide', 'Guide', '# API\nsearchable'); expect(store.search({ workspace: '/a' }, 'searchable')).toHaveLength(1); expect(store.search({ workspace: '/c' }, 'searchable')).toHaveLength(0); });
  it('keeps the previous page when the replacement transaction fails', () => {
    const { db, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'old body');
    db.exec('DROP TABLE wiki_fts');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'new body')).toThrow();
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Old', content: 'old body' });
  });

  it('searches every workspace when no workspace is supplied and reports each page origin', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide A', '# API\nsearchable alpha');
    store.replacePage({ workspace: '/b' }, 'guide', 'Guide B', '# API\nsearchable beta');

    const all = store.search({}, 'searchable');
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.workspace).sort()).toEqual(['/a', '/b']);
    expect(store.search({ workspace: '/a' }, 'searchable')).toHaveLength(1);
  });

  it('aggregates the overview across every workspace when scoped globally', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'one', 'One', 'body');
    store.replacePage({ workspace: '/b' }, 'two', 'Two', 'body');

    expect(store.overview({})).toMatchObject({ pages: 2 });
    expect(store.overview({ workspace: '/a' })).toMatchObject({ pages: 1 });
  });

  it('stores frontmatter Markdown and an exact source snapshot without a SQL body copy', () => {
    const { db, root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'docs/guide.md', 'Guide: "quoted"', '# Guide\nsearchable', 'src/source.ts', 'export const source = 1;');
    const page = store.readPage({ workspace: '/a' }, 'docs/guide.md')!;
    expect(page).toMatchObject({ workspace: '/a', page: 'docs/guide.md', title: 'Guide: "quoted"', content: '# Guide\nsearchable', sourcePath: 'src/source.ts', locked: false });
    expect(page.path.endsWith('.md')).toBe(true);
    const text = readFileSync(page.path, 'utf8');
    expect(text).toMatch(/^---\r?\n/);
    expect(text).toContain('workspace: /a');
    expect(text).toContain('page: docs/guide.md');
    expect(page.sources).toHaveLength(1);
    expect(readFileSync(join(bucket(root, page.path), page.sources![0]), 'utf8')).toBe('export const source = 1;');
    expect(db.prepare('SELECT count(*) AS count FROM wiki_pages').get()).toMatchObject({ count: 0 });
  });

  it('reads manual Markdown edits immediately and honors locked pages', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Original', '# Original');
    const before = store.readPage({ workspace: '/a' }, 'guide')!;
    const manual = readFileSync(before.path, 'utf8').replace('locked: false', 'locked: true').replaceAll('Original', 'Manual');
    writeFileSync(before.path, manual);
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Manual', content: '# Manual', locked: true });
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Generated', '# Generated')).toThrow(/locked/i);
    expect(readFileSync(before.path, 'utf8')).toBe(manual);
  });

  it('finds a moved locked file even before rebuilding its index', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# Original');
    const before = store.readPage({ workspace: '/a' }, 'guide')!;
    const moved = before.path.replace(/\.md$/, '-moved.md');
    writeFileSync(before.path, readFileSync(before.path, 'utf8').replace('locked: false', 'locked: true'));
    renameSync(before.path, moved);
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ path: moved, locked: true });
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Generated', '# Generated')).toThrow(/locked/i);
  });

  it('honors newly authored locked Markdown when no metadata index row exists', () => {
    const { db, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# Original');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(page.path, readFileSync(page.path, 'utf8').replace('locked: false', 'locked: true'));
    db.exec('DELETE FROM wiki_documents; DELETE FROM wiki_fts');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Generated', '# Generated')).toThrow(/locked/i);
    expect(store.readPage({ workspace: '/a' }, 'guide')?.content).toBe('# Original');
  });

  it('does not mislabel an old snapshot as the source of a different sourcePath', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# One', 'one.md', '# source one');
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# Two', 'two.md');
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ sourcePath: 'two.md', sources: [] });
  });

  it('supports full YAML metadata and reports malformed frontmatter during reindex', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'body');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(page.path, '---\r\nworkspace: /a\r\npage: guide\r\ntitle: |\r\n  Multi-line\r\n  title\r\nsources: ["raw/sources/a.md"]\r\nlocked: true\r\nupdatedAt: 2026-01-01T00:00:00.000Z\r\n---\r\n\r\n# Body');
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Multi-line\ntitle\n', content: '# Body', locked: true });
    writeFileSync(page.path, '---\nworkspace: [unclosed\n---\n\nbody');
    const result = store.rebuildIndex();
    expect(result.pages).toBe(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('rebuilds search from edited files and removes deleted file entries', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'oldword');
    store.replacePage({ workspace: '/b' }, 'other', 'Other', 'otherword');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(page.path, readFileSync(page.path, 'utf8').replace('oldword', 'newword'));
    expect(store.rebuildIndex({ workspace: '/a' })).toMatchObject({ pages: 1 });
    expect(store.search({ workspace: '/a' }, 'oldword')).toEqual([]);
    expect(store.search({ workspace: '/a' }, 'newword')).toHaveLength(1);
    expect(store.search({ workspace: '/b' }, 'otherword')).toHaveLength(1);
    rmSync(page.path);
    expect(store.rebuildIndex()).toMatchObject({ pages: 1 });
    expect(store.readPage({ workspace: '/a' }, 'guide')).toBeUndefined();
    expect(store.listPages({ workspace: '/a' })).toEqual([]);
  });

  it('lists newly authored Markdown files without requiring an index rebuild', () => {
    const { root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'body');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(join(bucket(root, page.path), 'wiki', 'notes.md'), '# Notes\n\nManual file');
    expect(store.listPages({ workspace: '/a' }).map((entry) => entry.page).sort()).toEqual(['guide', 'notes.md']);
  });

  it('exports legacy bodies once, keeps ID collisions distinct, and preserves the SQL backup', () => {
    const { db, root } = fixture();
    legacy(db, 'guide', 'first legacy body');
    legacy(db, 'guide.md', 'second legacy body');
    const store = new WikiStore(db, root);
    const a = store.readPage({ workspace: '/a' }, 'guide')!;
    const b = store.readPage({ workspace: '/a' }, 'guide.md')!;
    expect(a.content).toBe('first legacy body');
    expect(b.content).toBe('second legacy body');
    expect(a.path).not.toBe(b.path);
    expect(a.sources).toEqual([]);
    expect(existsSync(join(bucket(root, a.path), 'raw', 'sources'))).toBe(false);
    expect(db.prepare('SELECT content FROM wiki_pages ORDER BY page').all()).toEqual([{ content: 'first legacy body' }, { content: 'second legacy body' }]);
    rmSync(a.path);
    db.exec('DROP TABLE wiki_documents; DROP TABLE wiki_fts');
    const restored = new WikiStore(db, root);
    expect(restored.readPage({ workspace: '/a' }, 'guide')).toBeUndefined();
    expect(restored.readPage({ workspace: '/a' }, 'guide.md')?.content).toBe('second legacy body');
  });

  it('never overwrites an existing manually authored page during legacy export', () => {
    const { db, root } = fixture();
    legacy(db);
    const workspaceDir = join(root, createHash('sha256').update('/a').digest('hex'));
    mkdirSync(join(workspaceDir, 'wiki'), { recursive: true });
    writeFileSync(join(workspaceDir, 'workspace.json'), JSON.stringify({ version: 1, workspace: '/a', legacyExported: [] }));
    const path = join(workspaceDir, 'wiki', 'manual.md');
    const text = '---\nworkspace: /a\npage: guide\ntitle: Manual\nsources: []\nlocked: true\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Manual page';
    writeFileSync(path, text);
    const store = new WikiStore(db, root);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Manual', content: '# Manual page', path, locked: true });
    const backups = readdirSync(join(workspaceDir, 'legacy-backup'));
    expect(backups).toHaveLength(1);
    const backup = readFileSync(join(workspaceDir, 'legacy-backup', backups[0]), 'utf8');
    expect(backup).toContain('title: Legacy');
    expect(backup).toContain('sourcePath: README.md');
    expect(backup).toContain('1970-01-01T00:00:01.234Z');
    expect(backup.endsWith('# Legacy\nold text')).toBe(true);
    expect(store.listPages({ workspace: '/a' })).toHaveLength(1);
    new WikiStore(db, root);
    expect(readdirSync(join(workspaceDir, 'legacy-backup'))).toEqual(backups);
  });

  it.each(['mapping', 'page'] as const)('preserves the old index when %s data cannot be scanned reliably', (broken) => {
    const { db, root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'oldword');
    store.replacePage({ workspace: '/b' }, 'other', 'Other', 'otherword');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    const target = broken === 'mapping' ? join(bucket(root, page.path), 'workspace.json') : page.path;
    writeFileSync(target, broken === 'mapping' ? '{broken' : '---\nworkspace: [broken\n---\n\nbody');
    const result = store.rebuildIndex();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT title FROM wiki_documents WHERE workspace=? AND page=?').get('/a', 'guide')).toEqual({ title: 'Guide' });
    expect(db.prepare('SELECT count(*) AS count FROM wiki_fts WHERE workspace=? AND wiki_fts MATCH ?').get('/a', 'oldword')).toEqual({ count: 1 });
    expect(store.search({ workspace: '/b' }, 'otherword')).toHaveLength(1);
  });

  it.each(['quoted lock', 'unclosed frontmatter'] as const)('rejects unsafe %s metadata instead of treating it as unlocked', (broken) => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# Original');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    const invalid = broken === 'quoted lock'
      ? readFileSync(page.path, 'utf8').replace('locked: false', 'locked: "true"')
      : '---\npage: guide\nlocked: true\n\n# Missing closing delimiter';
    writeFileSync(page.path, invalid);
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Generated', '# Generated')).toThrow(/frontmatter|lock/i);
    expect(store.rebuildIndex().diagnostics.length).toBeGreaterThan(0);
    expect(readFileSync(page.path, 'utf8')).toBe(invalid);
  });

  it('discovers the same workspaces and pages after losing the entire search database', () => {
    const { root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'recoverable');
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const rebuilt = new WikiStore(db, root);
    expect(rebuilt.search({}, 'recoverable')).toHaveLength(1);
    expect(rebuilt.listPages({})).toMatchObject([{ workspace: '/a', page: 'guide' }]);
  });

  it('keeps the previous file and index when atomic file publication fails', () => {
    const { store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'oldword');
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('fixture publish failure'); });
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'newword')).toThrow('fixture publish failure');
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Old', content: 'oldword' });
    expect(store.search({}, 'oldword')).toHaveLength(1);
    expect(store.search({}, 'newword')).toEqual([]);
  });

  it('does not reuse a source snapshot whose bytes were changed manually', () => {
    const { root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'oldword', 'README.md', 'original raw');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    writeFileSync(join(bucket(root, page.path), page.sources[0]), 'different raw');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'newword', 'README.md', 'original raw')).toThrow(/snapshot/i);
    expect(store.readPage({ workspace: '/a' }, 'guide')?.content).toBe('oldword');
  });

  it('restores the prior file if SQL commit fails after publication', () => {
    const { db, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'oldword');
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => { if (sql === 'COMMIT') throw new Error('fixture commit failure'); return exec(sql); });
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'newword')).toThrow('fixture commit failure');
    expect(store.readPage({ workspace: '/a' }, 'guide')).toMatchObject({ title: 'Old', content: 'oldword' });
  });

  it('recovers the prior file without allocating disk space after SQL commit fails', () => {
    const { db, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'oldword');
    const path = store.readPage({ workspace: '/a' }, 'guide')!.path;
    const exec = db.exec.bind(db);
    let diskFull = false;
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') { diskFull = true; throw new Error('SQLITE_FULL fixture'); }
      return exec(sql);
    });
    const originalWrite = vi.mocked(writeFileSync).getMockImplementation()!;
    vi.mocked(writeFileSync).mockImplementation((...args) => {
      if (diskFull) throw new Error('ENOSPC fixture');
      return originalWrite(...args);
    });
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'newword')).toThrow('SQLITE_FULL fixture');
    expect(readFileSync(path, 'utf8')).toContain('oldword');
    expect(store.readPage({ workspace: '/a' }, 'guide')?.title).toBe('Old');
  });

  it.each(['../escape', '/escape', 'C:\\escape', 'C:relative', 'docs/../../escape', 'docs/CON.md', 'file:ads', 'trailing.', 'docs/NUL/file.md', 'bad?.md'])('rejects unsafe page paths: %s', (page) => {
    const { store } = fixture();
    expect(() => store.replacePage({ workspace: '/a' }, page, 'Unsafe', 'body')).toThrow(/path/i);
  });

  it('rejects outside directory links for both generated pages and source snapshots', () => {
    const { root, store } = fixture();
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'old body');
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    const workspaceDir = bucket(root, page.path);
    const outside = join(root, 'outside-fixture');
    mkdirSync(outside);
    symlinkSync(outside, join(workspaceDir, 'wiki', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.replacePage({ workspace: '/a' }, 'linked/escape', 'Unsafe', 'body')).toThrow(/path|link/i);
    mkdirSync(join(workspaceDir, 'raw'));
    symlinkSync(outside, join(workspaceDir, 'raw', 'sources'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Unsafe', 'body', 'README.md', 'raw body')).toThrow(/path|link/i);
    expect(store.readPage({ workspace: '/a' }, 'guide')?.content).toBe('old body');
  });

  it('rejects a storage root that has been replaced by an external directory link', () => {
    const { root, db } = fixture();
    const outside = join(root, 'outside');
    const linkedRoot = join(root, 'linked-root');
    mkdirSync(outside);
    symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new WikiStore(db, linkedRoot)).toThrow(/path|link/i);
  });

  it('rejects storage access after a root ancestor is replaced by an outside link', () => {
    const { root, db } = fixture();
    const parent = join(root, 'parent');
    const outside = join(root, 'outside');
    const store = new WikiStore(db, join(parent, 'wiki-root'));
    mkdirSync(join(outside, 'wiki-root'), { recursive: true });
    renameSync(parent, `${parent}-original`);
    symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'Guide', 'body')).toThrow(/path|link/i);
  });

  it('deletes workspace files and indexes without deleting or resurrecting legacy backup rows', () => {
    const { db, root } = fixture();
    legacy(db);
    const store = new WikiStore(db, root);
    const page = store.readPage({ workspace: '/a' }, 'guide')!;
    store.deleteWorkspace({ workspace: '/a' });
    expect(existsSync(page.path)).toBe(false);
    expect(store.search({ workspace: '/a' }, 'Legacy')).toEqual([]);
    expect(db.prepare('SELECT count(*) AS count FROM wiki_pages').get()).toMatchObject({ count: 1 });
    expect(new WikiStore(db, root).listPages({ workspace: '/a' })).toEqual([]);
  });
});
