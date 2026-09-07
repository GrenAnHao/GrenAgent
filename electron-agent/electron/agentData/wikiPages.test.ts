import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pageFixture, sourceFixture } from './wikiTestFixture';
import { wikiHash } from './wikiFiles';
import { WikiStore } from './wikiStore';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() { const value = pageFixture(); cleanups.push(value.cleanup); return value; }

describe('Wiki pages v2', () => {
  it('skips automatic publication when externally edited source references name a missing revision', () => {
    const { pages, libraries, library, sources, files } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'A' });
    pages.publishGenerated(libraries.acquirePermit(library.kbId, source.sourceId), 'Original', 'keep body');
    const page = pages.readById(library.kbId, source.generatedPageId)!;
    const invalid = files.renderAt({ ...page, sourceRefs: [{ sourceId: source.sourceId, revision: 999 }] });
    writeFileSync(page.path, invalid);
    const permit = libraries.acquirePermit(library.kbId, source.sourceId);
    expect(pages.reindexLibrary(library.kbId).diagnostics[0].code).toBe('INVALID_SOURCE');
    expect(pages.publishGenerated(permit, 'New', 'must not publish')).toEqual({ state: 'skipped', reason: 'changed' });
    expect(readFileSync(page.path, 'utf8')).toBe(invalid);
  });

  it.each([true, false])('never rolls back an explicitly updated source through a late legacy writer (raw=%s)', (includeRaw) => {
    const { pages, libraries, sources } = fixture();
    pages.replaceLegacyProtected({ workspace: '/legacy-race' }, 'guide', 'Guide', 'original generated', 'README.md', 'raw v1');
    const library = libraries.resolveLegacy('/legacy-race')!;
    const before = pages.readById(library.kbId, 'guide')!;
    const source = sources.get(library.kbId, before.autoSourceId!)!;
    const updated = sources.updateText(library.kbId, source.sourceId, 'explicit raw v2', source);
    expect(pages.replaceLegacyProtected({ workspace: '/legacy-race' }, 'guide', 'Stale', 'late generated v1', 'README.md', includeRaw ? 'raw v1' : undefined, before)).toEqual({ state: 'skipped', reason: 'changed' });
    expect(sources.get(library.kbId, source.sourceId)).toMatchObject({ revision: updated.revision, contentHash: updated.contentHash });
    expect(sources.readSnapshot(library.kbId, updated)).toBe('explicit raw v2');
    expect(pages.readById(library.kbId, 'guide')?.content).toBe('original generated');
  });

  it('creates locked source-less pages and hashes the complete file', () => {
    const { pages, library } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Manual', content: '# Exact', sourceRefs: [] });
    expect(page.locked).toBe(true); expect(page.sourceRefs).toEqual([]);
    expect(page.contentHash).toBe(wikiHash(readFileSync(page.path, 'utf8')));
    expect(readFileSync(page.path, 'utf8')).not.toContain('contentHash:');
    expect(pages.readById(library.kbId, page.pageId)).toMatchObject(page);
    expect(() => pages.setLocked(library.kbId, page.pageId, false, page)).toThrow(/source/i);
  });
  it('uses full-file CAS for dirty metadata and content and keeps manual saves locked', () => {
    const { pages, library, db } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Manual', content: 'oldtoken', sourceRefs: [] });
    const changed = readFileSync(page.path, 'utf8').replace('locked: true', 'locked: false');
    writeFileSync(page.path, changed);
    expect(() => pages.saveManual(library.kbId, page.pageId, { title: 'Changed', content: 'newtoken', sourceRefs: [], expected: page })).toThrow(/changed|conflict/i);
    expect(readFileSync(page.path, 'utf8')).toBe(changed);
    const fresh = pages.readById(library.kbId, page.pageId)!;
    const updated = pages.saveManual(library.kbId, page.pageId, { title: 'Changed', content: 'newtoken', sourceRefs: [], expected: fresh });
    expect(updated.locked).toBe(true); expect(updated.revision).toBe(page.revision + 1);
    expect(db.prepare('SELECT content_hash FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, page.pageId)).toEqual({ content_hash: updated.contentHash });
  });
  it('rejects foreign or nonexistent source revisions', () => {
    const { pages, library, sources, libraries } = fixture();
    const other = libraries.create({ name: 'Other', description: '', bindings: [] });
    const source = sources.createText(other.kbId, { kind: 'manual', name: 'a.md', content: '# A' });
    expect(() => pages.createManual(library.kbId, { title: 'Invalid', content: '', sourceRefs: [{ sourceId: source.sourceId, revision: 1 }] })).toThrow(/source/i);
    const own = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: '# A' });
    expect(() => pages.createManual(library.kbId, { title: 'Invalid', content: '', sourceRefs: [{ sourceId: own.sourceId, revision: 99 }] })).toThrow(/source/i);
  });
  it('publishes with a pre-generation permit and rejects late changed-source results', () => {
    const { pages, library, sources, libraries } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: '# A' });
    const permit = libraries.acquirePermit(library.kbId, source.sourceId);
    const result = pages.publishGenerated(permit, { title: 'Generated', content: '# Generated' });
    expect(result.state).toBe('published');
    if (result.state !== 'published') return;
    expect(result.page).toMatchObject({ pageId: source.generatedPageId, locked: false, autoSourceId: source.sourceId, sourceRefs: [{ sourceId: source.sourceId, revision: source.revision }] });
    const late = libraries.acquirePermit(library.kbId, source.sourceId);
    sources.updateText(library.kbId, source.sourceId, '# B', source);
    expect(pages.publishGenerated(late, { title: 'Stale', content: '# stale' })).toEqual({ state: 'skipped', reason: 'changed' });
    expect(pages.readById(library.kbId, source.generatedPageId)?.title).toBe('Generated');
  });
  it('skips locked, dirty, suppressed, and multi-source generated pages', () => {
    const { pages, library, sources, libraries } = fixture();
    const a = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'a' });
    const b = sources.createText(library.kbId, { kind: 'manual', name: 'b.md', content: 'b' });
    pages.publishGenerated(libraries.acquirePermit(library.kbId, a.sourceId), { title: 'A', content: 'old' });
    const permit = libraries.acquirePermit(library.kbId, a.sourceId);
    const before = pages.readById(library.kbId, a.generatedPageId)!;
    writeFileSync(before.path, readFileSync(before.path, 'utf8').replace('old', 'outside'));
    expect(pages.publishGenerated(permit, { title: 'A', content: 'new' })).toEqual({ state: 'skipped', reason: 'changed' });
    const multi = pages.saveManual(library.kbId, a.generatedPageId, { title: 'Combined', content: 'mine', sourceRefs: [{ sourceId: a.sourceId, revision: 1 }, { sourceId: b.sourceId, revision: 1 }], expected: pages.readById(library.kbId, a.generatedPageId)! });
    expect(pages.publishGenerated(libraries.acquirePermit(library.kbId, a.sourceId), { title: 'A', content: 'new' })).toEqual({ state: 'skipped', reason: 'locked' });
    pages.setLocked(library.kbId, a.generatedPageId, false, multi);
    expect(pages.publishGenerated(libraries.acquirePermit(library.kbId, a.sourceId), { title: 'A', content: 'new' })).toEqual({ state: 'skipped', reason: 'multi_source' });
    sources.suppress(library.kbId, b.sourceId);
    expect(pages.publishGenerated(libraries.acquirePermit(library.kbId, b.sourceId), { title: 'B', content: 'new' })).toEqual({ state: 'skipped', reason: 'suppressed' });
  });
  it('keeps the entire previous bucket index if one page is damaged', () => {
    const { pages, library, files, db } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Old', content: 'indexedtoken', sourceRefs: [] });
    files.writeAt(library, 'wiki/broken.md', '---\nlocked: "false"\n---\n# invalid');
    const result = pages.reindexLibrary(library.kbId);
    expect(result.pages).toBe(0); expect(result.diagnostics[0].path).toContain('broken.md');
    expect(db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, page.pageId)).toEqual({ title: 'Old' });
    expect(pages.searchByLibraries([library.kbId], 'indexedtoken')).toHaveLength(1);
  });
  it('restores page bytes and index after a commit failure', () => {
    const { pages, library, db } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Old', content: 'oldtoken', sourceRefs: [] });
    const before = readFileSync(page.path, 'utf8'); const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => { if (sql === 'COMMIT') throw new Error('fixture commit'); exec(sql); });
    expect(() => pages.saveManual(library.kbId, page.pageId, { title: 'New', content: 'newtoken', sourceRefs: [], expected: page })).toThrow('fixture commit');
    expect(readFileSync(page.path, 'utf8')).toBe(before);
    expect(db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, page.pageId)).toEqual({ title: 'Old' });
  });
  it('protects legacy writes with pre-generation CAS and preserves v2 identity for old readers', () => {
    const { pages, libraries } = fixture();
    expect(pages.replaceLegacyProtected({ workspace: '/legacy' }, 'guide', 'Guide', 'first', 'README.md', 'raw first').state).toBe('published');
    const library = libraries.resolveLegacy('/legacy')!;
    const current = pages.readById(library.kbId, 'guide')!;
    expect(pages.replaceLegacyProtected({ workspace: '/legacy' }, 'guide', 'No baseline', 'unsafe')).toEqual({ state: 'skipped', reason: 'changed' });
    expect(pages.replaceLegacyProtected({ workspace: '/legacy' }, 'guide', 'Next', 'next', 'README.md', 'raw next', current).state).toBe('published');
    const fresh = pages.readById(library.kbId, 'guide')!;
    const manual = pages.saveManual(library.kbId, 'guide', { title: 'Manual', content: 'manual', sourceRefs: fresh.sourceRefs, expected: fresh });
    expect(pages.readPage({ workspace: '/legacy' }, 'guide')).toMatchObject({ page: 'guide', title: 'Manual', content: 'manual', locked: true });
    expect(pages.listPages({ workspace: '/legacy' })[0].page).toBe('guide');
    expect(pages.replaceLegacyProtected({ workspace: '/legacy' }, 'guide', 'Late', 'late', 'README.md', 'raw late', manual)).toEqual({ state: 'skipped', reason: 'locked' });
  });
  it('rolls back its index if external bytes change immediately before rename', () => {
    const { pages, libraries, sources, library, db } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'a' });
    pages.publishGenerated(libraries.acquirePermit(library.kbId, source.sourceId), { title: 'Old', content: 'old' });
    const permit = libraries.acquirePermit(library.kbId, source.sourceId); const page = pages.readById(library.kbId, source.generatedPageId)!;
    const original = pages.files.publishAt.bind(pages.files);
    vi.spyOn(pages.files, 'publishAt').mockImplementationOnce((bucket, path, content, expectedHash) => {
      writeFileSync(page.path, readFileSync(page.path, 'utf8').replace('old', 'outside'));
      return original(bucket, path, content, expectedHash);
    });
    expect(libraries.transaction(() => pages.publishGenerated(permit, { title: 'New', content: 'new' }))).toEqual({ state: 'skipped', reason: 'changed' });
    expect(readFileSync(page.path, 'utf8')).toContain('outside');
    expect(db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, source.generatedPageId)).toEqual({ title: 'Old' });
  });
  it('backs up the old index schema and preserves failed export bucket entries on migration', () => {
    const f = sourceFixture(); cleanups.push(f.cleanup);
    f.db.exec(`CREATE TABLE wiki_pages(workspace TEXT,page TEXT,title TEXT,content TEXT,source_path TEXT,content_hash TEXT,updated_at INTEGER,PRIMARY KEY(workspace,page));
      CREATE TABLE wiki_documents(workspace TEXT,page TEXT,title TEXT,source_path TEXT,path TEXT,updated_at INTEGER,locked INTEGER,chunks INTEGER,content_hash TEXT,PRIMARY KEY(workspace,page));
      CREATE VIRTUAL TABLE wiki_fts USING fts5(workspace UNINDEXED,page UNINDEXED,title,content);`);
    for (const workspace of ['/old', '/broken']) {
      f.db.prepare('INSERT INTO wiki_pages VALUES(?,?,?,?,?,?,?)').run(workspace, 'guide', 'Legacy', 'legacytoken', 'README.md', 'oldhash', 1);
      f.db.prepare('INSERT INTO wiki_documents VALUES(?,?,?,?,?,?,?,?,?)').run(workspace, 'guide', 'Kept index', 'README.md', 'wiki/guide.md', 1, 0, 1, 'oldhash');
      f.db.prepare('INSERT INTO wiki_fts VALUES(?,?,?,?)').run(workspace, 'guide', 'Kept index', 'legacytoken');
    }
    f.files.manifest('/broken', true); f.files.write('/broken', 'workspace.json', '{broken');
    const pages = new WikiStore(f.db, f.files.root, { libraries: f.libraries, sources: f.sources });
    expect(pages.legacyExportFailedBuckets.has(wikiHash('/broken'))).toBe(true);
    expect(f.libraries.resolveLegacy('/broken')).toBeUndefined();
    expect(f.db.prepare('SELECT title FROM wiki_documents WHERE workspace=?').get('/broken')).toEqual({ title: 'Kept index' });
    expect(f.db.prepare('SELECT count(*) AS n FROM wiki_documents_before_libraries').get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT count(*) AS n FROM wiki_fts_before_libraries').get()).toEqual({ n: 2 });
    const library = f.libraries.resolveLegacy('/old')!;
    expect(pages.readById(library.kbId, 'guide')).toMatchObject({ pageId: 'guide', revision: 0, content: 'legacytoken' });
    expect(new WikiStore(f.db, f.files.root).readById(library.kbId, 'guide')?.content).toBe('legacytoken');
    f.files.write('/broken', 'workspace.json', JSON.stringify({ version: 1, workspace: '/broken', legacyExported: [] }));
    const recovered = new WikiStore(f.db, f.files.root);
    expect(recovered.libraries.resolveLegacy('/broken')).toBeDefined();
    expect(f.db.prepare('SELECT count(*) AS n FROM wiki_documents WHERE workspace=? AND page=?').get('/broken', 'guide')).toEqual({ n: 1 });
    expect(recovered.overview({}).pages).toBe(2);
  });
  it('rolls schema renaming back on commit failure and can retry without duplicate libraries', () => {
    const f = sourceFixture(); cleanups.push(f.cleanup);
    f.db.exec(`CREATE TABLE wiki_documents(workspace TEXT,page TEXT,title TEXT,source_path TEXT,path TEXT,updated_at INTEGER,locked INTEGER,chunks INTEGER,content_hash TEXT,PRIMARY KEY(workspace,page));
      CREATE VIRTUAL TABLE wiki_fts USING fts5(workspace UNINDEXED,page UNINDEXED,title,content);`);
    f.files.manifest('/old', true); f.files.write('/old', 'wiki/guide.md', '# body');
    const exec = f.db.exec.bind(f.db);
    const spy = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && f.db.prepare('PRAGMA table_info(wiki_documents)').all().some((column) => column.name === 'kb_id')) throw new Error('schema fixture');
      exec(sql);
    });
    expect(() => new WikiStore(f.db, f.files.root, { libraries: f.libraries, sources: f.sources })).toThrow('schema fixture');
    spy.mockRestore();
    expect(f.db.prepare('PRAGMA table_info(wiki_documents)').all().some((column) => column.name === 'kb_id')).toBe(false);
    new WikiStore(f.db, f.files.root, { libraries: f.libraries, sources: f.sources });
    expect(f.libraries.list()).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM wiki_schema_migrations').get()).toEqual({ n: 1 });
  });
  it('treats a corrupted library manifest as a bucket diagnostic and preserves its index', () => {
    const { pages, library, files, db } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Kept', content: 'token', sourceRefs: [] });
    files.writeAt(library, 'library.json', '{broken');
    const result = pages.reindexLibrary(library.kbId);
    expect(result.pages).toBe(0); expect(result.diagnostics[0].path).toContain('library.json');
    expect(db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, page.pageId)).toEqual({ title: 'Kept' });
  });
  it('reports bucket links as diagnostics without following them or losing its index', () => {
    const { pages, library, files, db, root } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Kept', content: 'token', sourceRefs: [] });
    const bucket = files.bucketDir(library); const outside = join(root, 'outside'); mkdirSync(outside);
    renameSync(bucket, `${bucket}-saved`);
    symlinkSync(outside, bucket, process.platform === 'win32' ? 'junction' : 'dir');
    const result = pages.reindexLibrary(library.kbId);
    expect(result).toMatchObject({ pages: 0 }); expect(result.diagnostics).toHaveLength(1);
    expect(db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, page.pageId)).toEqual({ title: 'Kept' });
  });
  it('hashes original disk bytes even if external edits contain malformed UTF-8', () => {
    const { pages, library } = fixture();
    const page = pages.createManual(library.kbId, { title: 'Bytes', content: 'body', sourceRefs: [] });
    const bytes = Buffer.concat([readFileSync(page.path), Buffer.from([0xff, 0xfe])]); writeFileSync(page.path, bytes);
    expect(pages.readById(library.kbId, page.pageId)?.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
