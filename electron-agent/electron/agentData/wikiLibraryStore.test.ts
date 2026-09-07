import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiFiles, wikiHash } from './wikiFiles';
import { WikiLibraryStore, normalizeWikiWorkspace } from './wikiLibraryStore';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-libraries-'));
  const db = new DatabaseSync(join(root, 'fixture.sqlite'));
  const files = new WikiFiles(join(root, 'buckets'));
  const libraries = new WikiLibraryStore(db, files);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, files, libraries };
}
const input = { name: '知识库', description: '', bindings: ['/project'] };

describe('WikiLibraryStore', () => {
  it('creates independent same-name libraries and keeps storage fixed when renamed', () => {
    const { libraries, files } = fixture();
    const first = libraries.create(input); const second = libraries.create(input);
    expect(first.kbId).not.toBe(second.kbId);
    expect(first.storageKey).toMatch(/^kb-[0-9a-f-]{36}$/);
    expect(first.storageKey).not.toBe(`kb-${first.kbId}`);
    const before = files.bucketDir(first);
    const renamed = libraries.update(first.kbId, { ...input, name: '新名字', bindings: [] }, first.revision);
    expect(files.bucketDir(renamed)).toBe(before);
    expect(JSON.parse(files.readTextAt(first, 'library.json')).name).toBe('新名字');
    expect(libraries.get(second.kbId)?.name).toBe('知识库');
  });
  it('counts Unicode code points and deduplicates normalized bindings', () => {
    const { libraries } = fixture();
    expect(libraries.create({ ...input, name: '😀'.repeat(80), bindings: ['/project/', '/project'] }).bindings).toHaveLength(1);
    expect(() => libraries.create({ ...input, name: '😀'.repeat(81) })).toThrow(/name/i);
    expect(() => libraries.create({ ...input, name: ' ' })).toThrow(/name/i);
    expect(() => libraries.create({ ...input, description: 'a'.repeat(501) })).toThrow(/description/i);
    expect(() => normalizeWikiWorkspace('')).toThrow(/workspace/i);
  });
  it('rolls back manifest and SQL together on a failing commit', () => {
    const { db, libraries, files } = fixture(); const library = libraries.create(input);
    const before = files.readTextAt(library, 'library.json');
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => { if (sql === 'COMMIT') throw new Error('commit fixture'); exec(sql); });
    expect(() => libraries.update(library.kbId, { ...input, name: 'Changed' }, library.revision)).toThrow('commit fixture');
    expect(files.readTextAt(library, 'library.json')).toBe(before);
    expect(libraries.get(library.kbId)?.name).toBe(input.name);
  });
  it('keeps a failed creation retry from leaving duplicate manifests', () => {
    const { db, libraries, files } = fixture(); const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => { if (sql === 'COMMIT') throw new Error('commit fixture'); exec(sql); });
    expect(() => libraries.create(input)).toThrow('commit fixture'); spy.mockRestore();
    libraries.create(input);
    expect(libraries.list()).toHaveLength(1);
    const manifests = readdirSync(files.root).filter((key) => { try { return !!files.readTextAt(key, 'library.json'); } catch { return false; } });
    expect(manifests).toHaveLength(1);
  });
  it('registers legacy bytes once and does not restore removed bindings', () => {
    const { libraries, files } = fixture();
    files.manifest('/old', true); files.write('/old', 'wiki/guide.md', '# Old'); files.write('/old', 'raw/source.txt', 'original');
    const page = files.readText('/old', 'wiki/guide.md');
    expect(libraries.registerLegacyBuckets()).toEqual([]);
    const library = libraries.resolveLegacy('/old')!;
    expect(library.storageKey).toBe(wikiHash('/old'));
    libraries.update(library.kbId, { name: library.name, description: '', bindings: [] }, library.revision);
    libraries.registerLegacyBuckets();
    expect(libraries.resolveLegacy('/old')?.bindings).toEqual([]);
    expect(files.readText('/old', 'wiki/guide.md')).toBe(page);
    expect(files.readText('/old', 'raw/source.txt')).toBe('original');
    expect(() => libraries.assertAccess({ kind: 'project', workspace: '/old' }, library.kbId)).toThrow(/access/i);
    expect(libraries.visibleLibraries({ kind: 'project', workspace: '/old' })).toEqual([]);
  });
  it('reports damaged and export-failed legacy buckets while registering healthy ones', () => {
    const { libraries, files } = fixture();
    files.manifest('/good', true); files.manifest('/broken', true); files.manifest('/failed', true);
    files.write('/broken', 'workspace.json', '{invalid');
    const diagnostics = libraries.registerLegacyBuckets(new Set([wikiHash('/failed')]));
    expect(diagnostics.some((entry) => entry.path.includes(wikiHash('/broken')))).toBe(true);
    expect(libraries.resolveLegacy('/good')).toBeDefined();
    expect(libraries.resolveLegacy('/broken')).toBeUndefined();
    expect(libraries.resolveLegacy('/failed')).toBeUndefined();
  });
  it('checks expected full bytes at publication time and leaves previous content intact', () => {
    const { libraries, files } = fixture(); const library = libraries.create(input);
    files.writeAt(library, 'wiki/page.md', 'original');
    expect(() => files.publishAt(library, 'wiki/page.md', 'new', wikiHash('stale'))).toThrow(/changed|conflict/i);
    expect(files.readTextAt(library, 'wiki/page.md')).toBe('original');
    expect(() => files.publishAt(library, 'wiki/page.md', 'new', null)).toThrow(/changed|conflict/i);
    for (const key of ['../escape', 'kb-unsafe', library.kbId, 'C:/outside']) expect(() => files.bucketDir(key)).toThrow(/bucket|storage|path/i);
  });
  it('preserves binding display paths while trimming human labels and using stable errors', () => {
    const { libraries } = fixture();
    const library = libraries.create({ name: '  产品  ', description: '  说明  ', bindings: ['/Project/', '/Project'] });
    expect(library).toMatchObject({ name: '产品', description: '说明', bindings: ['/Project/'] });
    expect(libraries.assertAccess({ kind: 'project', workspace: '/Project' }, library.kbId).kbId).toBe(library.kbId);
    expect(() => libraries.assertAccess({ kind: 'project', workspace: '/Other' }, library.kbId)).toThrow(/^FORBIDDEN:/);
    expect(() => libraries.update(library.kbId, input, 100)).toThrow(/^VERSION_CONFLICT:/);
    libraries.beginDelete({ kind: 'library', kbId: library.kbId });
    expect(() => libraries.assertActive(library.kbId)).toThrow(/^RESOURCE_DELETING:/);
  });
  it('maps exact legacy workspaces independently even when their normalized paths match', () => {
    const { libraries, files } = fixture();
    files.manifest('/old', true); files.manifest('/old/', true);
    expect(libraries.registerLegacyBuckets()).toEqual([]);
    expect(libraries.list()).toHaveLength(2);
    expect(libraries.resolveLegacy('/old')?.kbId).not.toBe(libraries.resolveLegacy('/old/')?.kbId);
    expect(libraries.resolveLegacy('/old')?.storageKey).toBe(wikiHash('/old'));
  });
  it('rolls back a caught nested transaction without leaking its manifest or SQL', () => {
    const { libraries, files } = fixture();
    let rolledBackKey = '';
    libraries.transaction(() => {
      libraries.create(input);
      expect(() => libraries.transaction(() => { rolledBackKey = libraries.create(input).storageKey; throw new Error('inner fixture'); })).toThrow('inner fixture');
    });
    expect(libraries.list()).toHaveLength(1);
    expect(() => files.readTextAt(rolledBackKey, 'library.json')).toThrow();
  });
  it('diagnoses a broken registered legacy manifest without overwriting or remapping it', () => {
    const { libraries, files } = fixture(); files.manifest('/old', true); libraries.registerLegacyBuckets();
    const library = libraries.resolveLegacy('/old')!; files.writeAt(library, 'library.json', '{broken');
    expect(libraries.registerLegacyBuckets()[0].path).toContain('library.json');
    expect(libraries.resolveLegacy('/old')?.kbId).toBe(library.kbId);
    expect(files.readTextAt(library, 'library.json')).toBe('{broken');
  });
});
