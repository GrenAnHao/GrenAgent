import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiFiles, wikiHash } from './wikiFiles';
import { WikiSourceStore } from './wikiSourceStore';
import { WikiLibraryStore } from './wikiLibraryStore';

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-sources-'));
  roots.push(root);
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const files = new WikiFiles(root);
  const libraries = new WikiLibraryStore(db, files);
  const library = libraries.create({ name: 'Sources', description: '', bindings: ['C:/project'] });
  const store = new WikiSourceStore(db, files, libraries);
  return { root, db, files, libraries, library, store, kbId: library.kbId };
}

describe('WikiSourceStore', () => {
  it('creates distinct identities and complete-hash immutable snapshots for identical uploads', () => {
    const { db, files, library, store, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'upload', name: 'notes.md', content: '# Notes\r\n' });
    const second = store.createText(kbId, { kind: 'upload', name: 'notes.md', content: '# Notes\r\n' });
    expect(first).toMatchObject({ revision: 1, contentHash: wikiHash('# Notes\r\n'), kind: 'upload', status: 'pending', generationSuppressed: false });
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(first.generatedPageId).not.toBe(second.generatedPageId);
    expect(first.snapshotPath).toBe(`raw/sources/${first.sourceId}/1-${first.contentHash}.md`);
    expect(files.readTextAt(library, first.snapshotPath)).toBe('# Notes\r\n');
    expect(store.list(kbId)).toHaveLength(2);
    expect(db.prepare('PRAGMA table_info(wiki_sources)').all().some((column) => column.name === 'content')).toBe(false);
  });

  it.each(['notes', 'notes.js', '../notes.md', 'folder/notes.md', 'C:\\notes.txt', 'CON.md', 'bad?.txt', 'notes.md '])('rejects unsafe or non-text source names: %s', (name) => {
    const { store, kbId } = fixture();
    expect(() => store.createText(kbId, { kind: 'manual', name, content: 'body' })).toThrow(/name|path|md|txt/i);
    expect(store.list(kbId)).toEqual([]);
  });

  it('isolates sources and revision references by library ID', () => {
    const { store, libraries, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.txt', content: 'body' });
    const other = libraries.create({ name: 'Other', description: '', bindings: [] });
    expect(store.get(other.kbId, source.sourceId)).toBeUndefined();
    expect(store.list(other.kbId)).toEqual([]);
    expect(() => store.readSnapshot(other.kbId, source)).toThrow(/snapshot|source|revision/i);
  });

  it('requires CAS and preserves old snapshots across explicit updates', () => {
    const { store, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'manual', name: 'notes.txt', content: 'one' });
    const second = store.updateText(kbId, first.sourceId, 'two', first);
    expect(second).toMatchObject({ sourceId: first.sourceId, generatedPageId: first.generatedPageId, revision: 2, contentHash: wikiHash('two'), status: 'pending' });
    expect(store.readSnapshot(kbId, first)).toBe('one');
    expect(store.readSnapshot(kbId, second)).toBe('two');
    expect(() => store.updateText(kbId, first.sourceId, 'stale', first)).toThrow('VERSION_CONFLICT:');
    expect(() => store.updateText(kbId, first.sourceId, 'stale', { revision: 2, contentHash: first.contentHash })).toThrow(/version|conflict|changed/i);
  });

  it('does not create a revision or clear suppression for identical bytes', () => {
    const { store, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'manual', name: 'notes.txt', content: 'same' });
    store.suppress(kbId, first.sourceId);
    const suppressed = store.get(kbId, first.sourceId)!;
    expect(store.updateText(kbId, first.sourceId, 'same', first)).toEqual(suppressed);
    expect(store.updateText(kbId, first.sourceId, 'changed', first)).toMatchObject({ revision: 2, generationSuppressed: true });
    expect(store.pending(kbId)).toEqual([]);
    store.allowRegeneration(kbId, first.sourceId);
    expect(store.pending(kbId)).toMatchObject([{ sourceId: first.sourceId, generationSuppressed: false }]);
  });

  it('allocates a new generated page ID for explicit regeneration after page deletion', () => {
    const { store, db, libraries, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'body' });
    db.prepare("INSERT INTO wiki_page_state(kb_id,page_id,lifecycle,epoch) VALUES(?,?,'deleted',1)").run(kbId, source.generatedPageId);
    store.suppress(kbId, source.sourceId);
    const regenerated = store.allowRegeneration(kbId, source.sourceId);
    expect(regenerated.sourceId).toBe(source.sourceId);
    expect(regenerated.generatedPageId).not.toBe(source.generatedPageId);
    expect(libraries.pageDeleted(kbId, source.generatedPageId)).toBe(true);
    expect(libraries.pageDeleted(kbId, regenerated.generatedPageId)).toBe(false);
  });

  it('rejects reads and updates when the current immutable snapshot was tampered with', () => {
    const { store, files, library, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'original' });
    writeFileSync(files.filePathAt(library, source.snapshotPath), 'tampered');
    expect(() => store.readSnapshot(kbId, source)).toThrow(/hash|snapshot|changed/i);
    expect(() => store.updateText(kbId, source.sourceId, 'original', source)).toThrow(/hash|snapshot|changed/i);
    expect(store.get(kbId, source.sourceId)).toEqual(source);
  });

  it('verifies actual snapshot bytes before decoding invalid UTF-8', () => {
    const { store, files, library, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.txt', content: '\ufffd' });
    writeFileSync(files.filePathAt(library, source.snapshotPath), Buffer.from([0xff]));
    expect(() => store.readSnapshot(kbId, source)).toThrow(/hash|snapshot|changed/i);
  });

  it('rolls back revision metadata and its new snapshot after SQL failure', () => {
    const { store, db, files, library, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'manual', name: 'notes.txt', content: 'one' });
    db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON wiki_source_revisions BEGIN SELECT RAISE(ABORT, 'fixture SQL failure'); END");
    expect(() => store.updateText(kbId, first.sourceId, 'two', first)).toThrow('fixture SQL failure');
    expect(store.get(kbId, first.sourceId)).toEqual(first);
    expect(existsSync(files.filePathAt(library, `raw/sources/${first.sourceId}/2-${wikiHash('two')}.txt`))).toBe(false);
    expect(store.readSnapshot(kbId, first)).toBe('one');
  });

  it('leaves the source unchanged after publication failure', () => {
    const { store, files, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'one' });
    vi.spyOn(files, 'publishAt').mockImplementationOnce(() => { throw new Error('fixture publication failure'); });
    expect(() => store.updateText(kbId, first.sourceId, 'two', first)).toThrow('fixture publication failure');
    expect(store.get(kbId, first.sourceId)).toEqual(first);
    expect(store.readSnapshot(kbId, first)).toBe('one');
  });

  it('rolls back a newly created source and snapshot when SQL commit fails', () => {
    const { store, db, files, library, kbId } = fixture();
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') throw new Error('fixture commit failure');
      return exec(sql);
    });
    expect(() => store.createText(kbId, { kind: 'upload', name: 'new.md', content: 'new' })).toThrow('fixture commit failure');
    expect(store.list(kbId)).toEqual([]);
    const raw = files.filePathAt(library, 'raw/sources');
    expect(existsSync(raw) ? readdirSync(raw, { recursive: true }).filter((entry) => String(entry).endsWith('.md')) : []).toEqual([]);
  });

  it('rolls back newly published snapshots with an enclosing transaction', () => {
    const { store, files, libraries, library, kbId } = fixture();
    let path = '';
    expect(() => libraries.transaction(() => {
      path = store.createText(kbId, { kind: 'manual', name: 'new.md', content: 'new' }).snapshotPath;
      throw new Error('fixture outer rollback');
    })).toThrow('fixture outer rollback');
    expect(store.list(kbId)).toEqual([]);
    expect(existsSync(files.filePathAt(library, path))).toBe(false);
  });

  it('rechecks project binding and content hash at creation', () => {
    const { store, libraries, library, kbId } = fixture();
    const preview = { projectWorkspace: 'C:\\PROJECT\\', relativePath: 'docs/readme.md', name: 'readme.md', contentHash: wikiHash('body'), bytes: 4 };
    expect(() => store.createProject(kbId, preview, 'changed')).toThrow('VERSION_CONFLICT:');
    const source = store.createProject(kbId, preview, 'body');
    expect(source).toMatchObject({ kind: 'project', relativePath: 'docs/readme.md', revision: 1 });
    libraries.update(kbId, { name: library.name, description: '', bindings: [] }, library.revision);
    expect(() => store.createProject(kbId, preview, 'body')).toThrow('FORBIDDEN:');
  });

  it('rejects new sources and updates once the library is deleting', () => {
    const { store, db, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'one' });
    db.prepare("UPDATE wiki_libraries SET lifecycle='deleting' WHERE kb_id=?").run(kbId);
    expect(() => store.createText(kbId, { kind: 'manual', name: 'new.md', content: 'one' })).toThrow(/active|delet/i);
    expect(() => store.updateText(kbId, source.sourceId, 'two', source)).toThrow(/active|delet/i);
  });

  it.each(['deleting', 'deleted'] as const)('reports a stable error code for a %s source', (lifecycle) => {
    const { store, db, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'one' });
    db.prepare('UPDATE wiki_sources SET lifecycle=? WHERE kb_id=? AND source_id=?').run(lifecycle, kbId, source.sourceId);
    expect(() => store.updateText(kbId, source.sourceId, 'two', source)).toThrow(`RESOURCE_${lifecycle.toUpperCase()}:`);
  });

  it('does not let an old processing result mark a newer revision as processed', () => {
    const { store, kbId } = fixture();
    const first = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'one' });
    expect(store.markProcessing(kbId, first.sourceId, 1)).toBe(true);
    expect(store.pending(kbId)).toEqual([]);
    const second = store.updateText(kbId, first.sourceId, 'two', first);
    expect(store.markResult(kbId, first.sourceId, 1, { status: 'succeeded', contentHash: first.contentHash })).toBe(false);
    expect(store.get(kbId, first.sourceId)).toEqual(second);
    expect(store.markProcessing(kbId, first.sourceId, 1)).toBe(false);
    expect(store.pending(kbId, [first.sourceId])).toHaveLength(1);
    expect(store.pending(kbId, [])).toEqual([]);
  });

  it('tracks failed retries and only explicitly regenerates successful sources', () => {
    const { store, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'body' });
    store.markProcessing(kbId, source.sourceId, 1);
    expect(store.markResult(kbId, source.sourceId, 1, { status: 'failed', error: 'retry me' })).toBe(true);
    expect(store.pending(kbId)).toMatchObject([{ error: 'retry me', status: 'failed' }]);
    store.markProcessing(kbId, source.sourceId, 1);
    expect(store.markResult(kbId, source.sourceId, 1, { status: 'succeeded' })).toBe(true);
    expect(store.get(kbId, source.sourceId)).toMatchObject({ status: 'succeeded', processedHash: source.contentHash, error: undefined });
    expect(store.pending(kbId)).toEqual([]);
    store.allowRegeneration(kbId, source.sourceId);
    expect(store.pending(kbId)).toHaveLength(1);
  });

  it('returns cancelled processing to pending without marking its hash processed', () => {
    const { store, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'body' });
    store.markProcessing(kbId, source.sourceId, 1);
    expect(store.markResult(kbId, source.sourceId, 1, { status: 'pending' })).toBe(true);
    expect(store.pending(kbId)).toMatchObject([{ status: 'pending', processedHash: undefined }]);
    expect(store.markResult(kbId, source.sourceId, 1, { status: 'succeeded', contentHash: wikiHash('wrong') })).toBe(false);
    expect(store.get(kbId, source.sourceId)?.status).toBe('pending');
  });

  it('prevents suppressed or deleted sources from accepting processing results', () => {
    const { store, db, kbId } = fixture();
    const source = store.createText(kbId, { kind: 'manual', name: 'notes.md', content: 'body' });
    store.suppress(kbId, source.sourceId);
    expect(store.markProcessing(kbId, source.sourceId, 1)).toBe(false);
    expect(store.markResult(kbId, source.sourceId, 1, { status: 'succeeded' })).toBe(false);
    db.prepare("UPDATE wiki_sources SET lifecycle='deleted' WHERE kb_id=? AND source_id=?").run(kbId, source.sourceId);
    expect(store.list(kbId)).toEqual([]);
    expect(store.list(kbId, true)).toHaveLength(1);
    expect(store.pending(kbId)).toEqual([]);
    expect(store.readSnapshot(kbId, source)).toBe('body');
    expect(() => store.updateText(kbId, source.sourceId, 'new', source)).toThrow(/delet|active/i);
  });

  it('maps legacy snapshot paths idempotently without rewriting their bytes or paths', () => {
    const { store, files, library, db, kbId } = fixture();
    const path = 'raw/sources/src/index--oldhash.ts';
    files.writeAt(library, path, 'export const legacy = true;');
    const ref = store.registerLegacy(kbId, path, 'index.ts', 'legacy-page');
    expect(ref.revision).toBe(1);
    expect(store.registerLegacy(kbId, path, 'renamed.ts', 'other-page')).toEqual(ref);
    expect(store.get(kbId, ref.sourceId)).toMatchObject({ snapshotPath: path, kind: 'legacy', generatedPageId: 'legacy-page', status: 'succeeded' });
    expect(store.readSnapshot(kbId, ref)).toBe('export const legacy = true;');
    expect(db.prepare('SELECT count(*) AS count FROM wiki_source_revisions').get()).toEqual({ count: 1 });
    expect(store.pending(kbId)).toEqual([]);
  });

  it('reports the missing legacy path without registering a broken source', () => {
    const { store, kbId } = fixture();
    expect(() => store.registerLegacy(kbId, 'raw/sources/missing.md')).toThrow('raw/sources/missing.md');
    expect(store.list(kbId)).toEqual([]);
  });
});
