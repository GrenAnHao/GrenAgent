import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { WikiFiles, wikiHash, wikiRelativePath, type WikiDiskPage, type WikiPageDocument } from './wikiFiles';
import { WikiLibraryStore } from './wikiLibraryStore';
import { WikiSourceStore } from './wikiSourceStore';
import type { DiagnosticItem } from './operationsContracts';
import type { WikiDiagnostic, WikiLibrary, WikiPage, WikiPageHit, WikiPageInput, WikiPageSave, WikiPublishResult, WikiReindexResult, WikiSourceRef, WikiVersion, WikiWritePermit } from './wikiContracts';

/** Legacy workspace entry points remain adapters for existing integrations. */
export interface WikiScope { workspace?: string }
export interface WikiWriteScope { workspace: string }
export interface WikiSearchHit { workspace: string; page: string; title: string; snippet: string; sourcePath: string; chunks: number }
export interface WikiChunk { id: string; page: string; title: string; content: string; sourcePath: string; startLine: number; endLine: number; hash: string }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }
export type WikiPageSummary = Omit<WikiPageDocument, 'content'>;
export type { WikiPageDocument } from './wikiFiles';

export class WikiStore {
  readonly files: WikiFiles;
  readonly libraries: WikiLibraryStore;
  readonly sources: WikiSourceStore;
  readonly diagnostics: WikiDiagnostic[] = [];
  readonly legacyExportFailedBuckets = new Set<string>();

  constructor(private readonly db: DatabaseSync, rootDir: string, dependencies?: WikiLibraryStore | { libraries: WikiLibraryStore; sources: WikiSourceStore }) {
    this.files = new WikiFiles(rootDir);
    this.libraries = dependencies instanceof WikiLibraryStore ? dependencies : dependencies?.libraries ?? new WikiLibraryStore(db, this.files);
    this.sources = dependencies && !(dependencies instanceof WikiLibraryStore) ? dependencies.sources : new WikiSourceStore(db, this.files, this.libraries);
    this.db.exec(`CREATE TABLE IF NOT EXISTS wiki_pages (workspace TEXT NOT NULL, page TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source_path TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace,page));`);
    this.exportLegacy();
    this.diagnostics.push(...this.libraries.registerLegacyBuckets(this.legacyExportFailedBuckets));
    this.upgradeIndex();
    this.libraries.attachPageReader((kbId, pageId) => this.readById(kbId, pageId));
    for (const library of this.libraries.list()) if (library.lifecycle === 'active' && !this.legacyExportFailedBuckets.has(library.storageKey)) this.diagnostics.push(...this.reindexLibrary(library.kbId).diagnostics);
  }

  private upgradeIndex(): void {
    const oldDocuments = this.db.prepare('PRAGMA table_info(wiki_documents)').all();
    const oldFts = this.db.prepare('PRAGMA table_info(wiki_fts)').all();
    this.libraries.transaction(() => {
      if (oldDocuments.length && !oldDocuments.some((column) => column.name === 'kb_id')) this.db.exec('ALTER TABLE wiki_documents RENAME TO wiki_documents_before_libraries');
      if (oldFts.length && !oldFts.some((column) => column.name === 'kb_id')) this.db.exec('ALTER TABLE wiki_fts RENAME TO wiki_fts_before_libraries');
      this.db.exec(`CREATE TABLE IF NOT EXISTS wiki_documents (kb_id TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '', page TEXT NOT NULL,
        title TEXT NOT NULL, source_path TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER NOT NULL, locked INTEGER NOT NULL,
        chunks INTEGER NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, source_refs TEXT NOT NULL DEFAULT '[]', auto_source_id TEXT,
        PRIMARY KEY(kb_id,page));
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(kb_id UNINDEXED,workspace UNINDEXED,page UNINDEXED,title,content);
        CREATE TABLE IF NOT EXISTS wiki_schema_migrations (name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);`);
      if (oldDocuments.length && !oldDocuments.some((column) => column.name === 'kb_id')) {
        for (const row of this.db.prepare('SELECT * FROM wiki_documents_before_libraries').all()) {
          const workspace = String(row.workspace); const kbId = this.libraries.resolveLegacy(workspace)?.kbId ?? `unavailable-${wikiHash(workspace)}`;
          this.db.prepare('INSERT INTO wiki_documents(kb_id,workspace,page,title,source_path,path,updated_at,locked,chunks,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(kbId, workspace, row.page!, row.title!, row.source_path!, row.path!, row.updated_at!, row.locked!, row.chunks!, row.content_hash!);
        }
      }
      if (oldFts.length && !oldFts.some((column) => column.name === 'kb_id')) for (const row of this.db.prepare('SELECT workspace,page,title,content FROM wiki_fts_before_libraries').all()) {
        const workspace = String(row.workspace); const kbId = this.libraries.resolveLegacy(workspace)?.kbId ?? `unavailable-${wikiHash(workspace)}`;
        this.db.prepare('INSERT INTO wiki_fts(kb_id,workspace,page,title,content) VALUES(?,?,?,?,?)').run(kbId, workspace, row.page!, row.title!, row.content!);
      }
      this.db.prepare('INSERT OR IGNORE INTO wiki_schema_migrations(name,completed_at) VALUES(?,?)').run('library-index-v2', Date.now());
    });
  }

  private exportLegacy(): void {
    const rows = this.db.prepare('SELECT workspace,page,title,content,source_path,content_hash,updated_at FROM wiki_pages').all() as Array<{ workspace: string; page: string; title: string; content: string; source_path: string; content_hash: string; updated_at: number }>;
    for (const row of rows) {
      try {
        const manifest = this.files.manifest(row.workspace, true)!;
        if (manifest.legacyExported.includes(row.page)) continue;
        const scanned = this.files.scan(row.workspace);
        if (scanned.failedBuckets.size) throw new Error(scanned.diagnostics.join('; '));
        const existing = scanned.pages.find((page) => page.page === row.page);
        let path = existing ? `legacy-backup/${wikiHash(row.page)}.md` : this.files.pagePath(row.workspace, row.page);
        const document: WikiPageDocument = { workspace: row.workspace, page: row.page, title: row.title, content: row.content, sourcePath: row.source_path, sources: [], path: this.files.filePath(row.workspace, path), locked: false, updatedAt: row.updated_at };
        const text = this.files.render(document, existing ? row.content_hash : undefined);
        if (existing && existsSync(this.files.filePath(row.workspace, path)) && this.files.readText(row.workspace, path) !== text) path = `legacy-backup/${wikiHash(row.page)}-${wikiHash(text)}.md`;
        this.libraries.transaction(() => {
          if (!existsSync(this.files.filePath(row.workspace, path))) this.libraries.registerPublication(this.files.publish(row.workspace, path, text));
          this.libraries.registerPublication(this.files.publish(row.workspace, 'workspace.json', JSON.stringify({ ...manifest, legacyExported: [...manifest.legacyExported, row.page] }, null, 2)));
        });
      } catch (error) {
        this.legacyExportFailedBuckets.add(wikiHash(row.workspace));
        this.diagnostics.push({ code: 'LEGACY_EXPORT_FAILED', path: `${wikiHash(row.workspace)}/${row.page}`, message: `legacy export failed: ${String(error)}` });
      }
    }
  }

  private libraryForWorkspace(workspace: string, create = false): WikiLibrary | undefined {
    let library = this.libraries.resolveLegacy(workspace);
    if (!library && create) {
      this.files.manifest(workspace, true);
      const diagnostics = this.libraries.registerLegacyBuckets(this.legacyExportFailedBuckets);
      this.diagnostics.push(...diagnostics); library = this.libraries.resolveLegacy(workspace);
      if (!library) throw new Error(`Wiki workspace registration failed: ${diagnostics.map((entry) => entry.message).join('; ')}`);
    }
    return library;
  }

  private refsForDisk(page: WikiDiskPage): WikiSourceRef[] {
    if (page.sourceRefs.length || !page.sources.length) return page.sourceRefs;
    return page.sources.map((path) => this.sources.registerLegacy(page.kbId, path, undefined, page.pageId));
  }

  private withState(page: WikiDiskPage): WikiPage {
    const state = this.db.prepare('SELECT epoch,lifecycle FROM wiki_page_state WHERE kb_id=? AND page_id=?').get(page.kbId, page.pageId) as { epoch: number; lifecycle: WikiPage['lifecycle'] } | undefined;
    const { sources: _sources, sourcePath: _sourcePath, workspace: _workspace, ...publicPage } = page;
    const refs = this.refsForDisk(page);
    return { ...publicPage, sourceRefs: refs, ...(page.autoSourceId ? {} : page.sources.length === 1 && refs.length === 1 ? { autoSourceId: refs[0].sourceId } : {}), epoch: state?.epoch ?? 0, lifecycle: state?.lifecycle ?? 'active' };
  }

  private diskById(library: WikiLibrary, pageId: string): WikiDiskPage | undefined {
    wikiRelativePath(pageId);
    const row = this.db.prepare('SELECT path FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, pageId) as { path: string } | undefined;
    const page = row ? this.files.readAt(library, row.path) : undefined;
    if (page) { if (page.pageId !== pageId) throw new Error('Wiki page metadata mismatch'); return page; }
    const scanned = this.files.scanBucket(library);
    if (scanned.diagnostics.length) throw new Error(`Wiki file scan failed: ${scanned.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
    return scanned.pages.find((candidate) => candidate.pageId === pageId);
  }

  readById(kbId: string, pageId: string): WikiPage | undefined {
    const library = this.libraries.get(kbId);
    if (!library || library.lifecycle !== 'active' || this.libraries.pageDeleted(kbId, pageId)) return undefined;
    const page = this.diskById(library, pageId); return page ? this.withState(page) : undefined;
  }

  listByLibrary(kbId: string): Array<Omit<WikiPage, 'content'>> {
    const library = this.libraries.assertActive(kbId); const scanned = this.files.scanBucket(library);
    if (scanned.diagnostics.length) throw new Error(`Wiki file scan failed: ${scanned.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
    return scanned.pages.filter((page) => !this.libraries.pageDeleted(kbId, page.pageId)).map((page) => { const { content: _content, ...summary } = this.withState(page); return summary; });
  }

  private validateRefs(kbId: string, refs: WikiSourceRef[]): void {
    if (!Array.isArray(refs)) throw new Error('invalid Wiki source references');
    for (const ref of refs) {
      if (!ref || typeof ref.sourceId !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 0) throw new Error('invalid Wiki source reference');
      if (!this.db.prepare('SELECT 1 FROM wiki_source_revisions WHERE kb_id=? AND source_id=? AND revision=?').get(kbId, ref.sourceId, ref.revision)) throw new Error('Wiki source revision does not belong to this library');
    }
  }

  private index(page: WikiPage, library: WikiLibrary, sourcePath = page.pageId): void {
    const path = relative(this.files.bucketDir(library), page.path).replace(/\\/g, '/');
    this.db.prepare(`INSERT INTO wiki_documents(kb_id,workspace,page,title,source_path,path,updated_at,locked,chunks,content_hash,revision,source_refs,auto_source_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kb_id,page) DO UPDATE SET title=excluded.title,source_path=excluded.source_path,path=excluded.path,
      updated_at=excluded.updated_at,locked=excluded.locked,chunks=excluded.chunks,content_hash=excluded.content_hash,revision=excluded.revision,source_refs=excluded.source_refs,auto_source_id=excluded.auto_source_id`)
      .run(page.kbId, library.legacyWorkspace ?? '', page.pageId, page.title, sourcePath, path, page.updatedAt, page.locked ? 1 : 0,
        chunkMarkdown(page.content, sourcePath, page.title).length, page.contentHash, page.revision, JSON.stringify(page.sourceRefs), page.autoSourceId ?? null);
    this.db.prepare('DELETE FROM wiki_fts WHERE kb_id=? AND page=?').run(page.kbId, page.pageId);
    this.db.prepare('INSERT INTO wiki_fts(kb_id,workspace,page,title,content) VALUES(?,?,?,?,?)').run(page.kbId, library.legacyWorkspace ?? '', page.pageId, page.title, page.content);
  }

  private publishPage(library: WikiLibrary, page: WikiPage, expectedHash: string | null, legacy?: WikiDiskPage): WikiPage {
    const path = relative(this.files.bucketDir(library), page.path).replace(/\\/g, '/');
    const legacyMetadata = library.legacyWorkspace ? { sources: this.snapshotPaths(page.kbId, page.sourceRefs), sourcePath: legacy?.sourcePath ?? page.pageId, workspace: library.legacyWorkspace } : undefined;
    const text = this.files.renderAt(page, legacyMetadata);
    const result = { ...page, contentHash: wikiHash(text) };
    this.index(result, library, legacy?.sourcePath);
    this.libraries.registerPublication(this.files.publishAt(library, path, text, expectedHash));
    return result;
  }

  private snapshotPaths(kbId: string, refs: WikiSourceRef[]): string[] {
    return refs.map((ref) => {
      const row = this.db.prepare('SELECT snapshot_path FROM wiki_source_revisions WHERE kb_id=? AND source_id=? AND revision=?').get(kbId, ref.sourceId, ref.revision) as { snapshot_path: string } | undefined;
      if (!row) throw new Error('Wiki source revision does not belong to this library');
      return row.snapshot_path;
    });
  }

  private legacyDocument(document: WikiPageDocument, library: WikiLibrary): WikiPageDocument {
    const path = relative(this.files.bucketDir(library), document.path).replace(/\\/g, '/');
    const disk = this.files.readAt(library, path);
    if (!disk) return document;
    const row = this.db.prepare('SELECT source_path FROM wiki_documents WHERE kb_id=? AND page=?').get(library.kbId, disk.pageId) as { source_path: string } | undefined;
    return { ...document, sources: disk.sourceRefs.length ? this.snapshotPaths(library.kbId, disk.sourceRefs) : disk.sources, sourcePath: row?.source_path ?? disk.sourcePath };
  }

  createManual(kbId: string, input: WikiPageInput): WikiPage {
    return this.libraries.transaction(() => {
      const library = this.libraries.assertActive(kbId); this.validateRefs(kbId, input.sourceRefs);
      const pageId = randomUUID();
      const page: WikiPage = { ...input, kbId, pageId, path: this.files.filePathAt(library, `wiki/${pageId}.md`), locked: true, revision: 1,
        contentHash: '', lifecycle: 'active', epoch: 0, updatedAt: Date.now() };
      return this.publishPage(library, page, null);
    });
  }

  private expectedPage(kbId: string, pageId: string, expected: WikiVersion): { library: WikiLibrary; disk: WikiDiskPage; page: WikiPage } {
    const library = this.libraries.assertActive(kbId);
    if (this.libraries.pageDeleted(kbId, pageId)) throw new Error('RESOURCE_DELETED: Wiki page is deleted');
    const disk = this.diskById(library, pageId);
    if (!disk) throw new Error('RESOURCE_DELETED: Wiki page not found');
    const page = this.withState(disk);
    if (!expected || expected.revision !== page.revision || expected.contentHash !== page.contentHash) throw new Error('VERSION_CONFLICT: Wiki page changed');
    return { library, disk, page };
  }

  saveManual(kbId: string, pageId: string, input: WikiPageSave): WikiPage {
    return this.libraries.transaction(() => {
      const { library, disk, page } = this.expectedPage(kbId, pageId, input.expected);
      this.validateRefs(kbId, input.sourceRefs);
      return this.publishPage(library, { ...page, title: input.title, content: input.content, sourceRefs: input.sourceRefs, locked: true, revision: page.revision + 1, updatedAt: Date.now() }, page.contentHash, disk);
    });
  }

  setLocked(kbId: string, pageId: string, locked: boolean, expected: WikiVersion): WikiPage {
    if (typeof locked !== 'boolean') throw new Error('invalid Wiki locked value');
    return this.libraries.transaction(() => {
      const { library, disk, page } = this.expectedPage(kbId, pageId, expected);
      if (!locked && !page.sourceRefs.length) throw new Error('SOURCE_REQUIRED: Wiki page needs a source before unlocking');
      if (page.locked === locked) return page;
      return this.publishPage(library, { ...page, locked, revision: page.revision + 1, updatedAt: Date.now() }, page.contentHash, disk);
    });
  }

  publishGenerated(permit: WikiWritePermit, input: { title: string; content: string }): WikiPublishResult;
  publishGenerated(permit: WikiWritePermit, title: string, content: string): WikiPublishResult;
  publishGenerated(permit: WikiWritePermit, value: { title: string; content: string } | string, content?: string): WikiPublishResult {
    const input = typeof value === 'string' ? { title: value, content: content! } : value;
    try { return this.libraries.transaction(() => {
      const library = this.libraries.get(permit.kbId); const source = this.sources.get(permit.kbId, permit.sourceId);
      const skipped = (reason: 'locked' | 'changed' | 'multi_source' | 'deleted' | 'suppressed'): WikiPublishResult => ({ state: 'skipped', reason });
      if (!library || library.lifecycle !== 'active' || library.epoch !== permit.libraryEpoch || !source || source.lifecycle !== 'active' || this.libraries.pageDeleted(permit.kbId, permit.pageId)) return skipped('deleted');
      let disk: WikiDiskPage | undefined;
      try { disk = this.diskById(library, permit.pageId); } catch { return skipped('changed'); }
      const current = disk ? this.withState(disk) : undefined;
      if (current?.locked) return skipped('locked');
      if (current && (current.autoSourceId !== permit.sourceId || current.sourceRefs.length !== 1 || current.sourceRefs[0].sourceId !== permit.sourceId)) return skipped('multi_source');
      if (current) { try { this.validateRefs(permit.kbId, current.sourceRefs); } catch { return skipped('changed'); } }
      if (current ? !permit.expected || current.revision !== permit.expected.revision || current.contentHash !== permit.expected.contentHash : permit.expected !== null) return skipped('changed');
      if (source.generationSuppressed) return skipped('suppressed');
      if (source.revision !== permit.sourceRevision || !this.libraries.permitActive(permit)) return skipped('changed');
      const page: WikiPage = { kbId: permit.kbId, pageId: permit.pageId, title: input.title, content: input.content,
        path: current?.path ?? this.files.filePathAt(library, `wiki/${permit.pageId}.md`), sourceRefs: [{ sourceId: permit.sourceId, revision: permit.sourceRevision }],
        locked: false, autoSourceId: permit.sourceId, revision: (current?.revision ?? 0) + 1, contentHash: '', lifecycle: 'active', epoch: permit.pageEpoch, updatedAt: Date.now() };
      return { state: 'published', page: this.publishPage(library, page, current?.contentHash ?? null, disk) };
    }); } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT:')) return { state: 'skipped', reason: 'changed' };
      throw error;
    }
  }

  deletePageFiles(kbId: string, pageId: string): void {
    this.libraries.beginDelete({ kind: 'page', kbId, pageId });
    const result = this.libraries.finishDelete({ kind: 'page', kbId, pageId });
    if (result.state === 'waiting') throw new Error('RESOURCE_DELETING: Wiki page has active writers');
  }

  reindexLibrary(kbId: string): WikiReindexResult {
    const library = this.libraries.assertActive(kbId); const scanned = this.files.scanBucket(library);
    for (const page of scanned.pages) if (this.libraries.pageDeleted(kbId, page.pageId)) scanned.diagnostics.push({ code: 'PAGE_DELETED', kbId, path: page.path, message: 'Deleted Wiki page cannot be restored by reindex' });
    if (scanned.diagnostics.length) return { pages: 0, diagnostics: scanned.diagnostics };
    try {
      this.libraries.transaction(() => {
        const pages = scanned.pages.map((disk) => {
          try { const page = this.withState(disk); this.validateRefs(kbId, page.sourceRefs); return { page, disk }; }
          catch (error) { scanned.diagnostics.push({ code: 'INVALID_SOURCE', kbId, path: disk.path, message: String(error) }); throw error; }
        });
        this.db.prepare('DELETE FROM wiki_documents WHERE kb_id=?').run(kbId); this.db.prepare('DELETE FROM wiki_fts WHERE kb_id=?').run(kbId);
        if (library.legacyWorkspace) {
          const fallback = `unavailable-${wikiHash(library.legacyWorkspace)}`;
          this.db.prepare('DELETE FROM wiki_documents WHERE kb_id=?').run(fallback);
          this.db.prepare('DELETE FROM wiki_fts WHERE kb_id=?').run(fallback);
        }
        for (const { page, disk } of pages) this.index(page, library, disk.sourcePath);
      });
    } catch (error) {
      if (!scanned.diagnostics.length) scanned.diagnostics.push({ code: 'REINDEX_FAILED', kbId, path: this.files.bucketDir(library), message: String(error) });
      return { pages: 0, diagnostics: scanned.diagnostics };
    }
    return { pages: scanned.pages.length, diagnostics: [] };
  }

  /** Inspect existing files and indexes only; do not register sources or repair state. */
  inspect(kbId?: string): DiagnosticItem[] {
    const checkedAt = Date.now(); const items: DiagnosticItem[] = [];
    const ids = kbId === undefined
      ? this.db.prepare('SELECT kb_id FROM wiki_libraries ORDER BY created_at,kb_id').all().map((row) => String(row.kb_id)) : [kbId];
    for (const id of ids) {
      const start = items.length; const resource = { type: 'wiki' as const, id };
      const add = (code: string, state: DiagnosticItem['state'], message: string, action?: DiagnosticItem['action'], path?: string) => {
        items.push({ id: `wiki:${wikiHash(`${id}:${code}:${path ?? ''}`)}`, resource, checkedAt, state, message, ...(action ? { action } : {}), ...(path ? { path } : {}) });
      };
      try {
        const library = this.libraries.get(id);
        if (!library || library.lifecycle !== 'active') {
          add('INACTIVE', 'unchecked', library?.lifecycle === 'deleting' ? '知识库正在删除，本次未检查' : '知识库已移除或不存在，本次未检查'); continue;
        }
        const safeFile = (path: string): string | undefined => {
          try {
            const safe = this.files.filePathAt(library, relative(this.files.bucketDir(library), path).replace(/\\/g, '/'));
            return existsSync(safe) && statSync(safe).isFile() ? safe : undefined;
          } catch { return undefined; }
        };
        const scanned = this.files.scanBucket(library);
        for (const diagnostic of scanned.diagnostics) {
          const path = safeFile(diagnostic.path);
          add(`${diagnostic.code}:${diagnostic.path}`, 'action_required', `${diagnostic.code}：Wiki 文件或元数据检查失败，请检查文件`, path ? 'open_file' : undefined, path);
        }
        if (scanned.diagnostics.length) continue;
        const rows = this.db.prepare('SELECT * FROM wiki_documents WHERE kb_id=?').all(id);
        const indexed = new Map(rows.map((row) => [String(row.page), row]));
        const fts = this.db.prepare('SELECT page,workspace,title,content FROM wiki_fts WHERE kb_id=?').all(id);
        for (const page of scanned.pages) {
          const row = indexed.get(page.pageId); indexed.delete(page.pageId);
          if (this.libraries.pageDeleted(id, page.pageId)) {
            add(`PAGE_DELETED:${page.pageId}`, 'action_required', '已删除页面仍存在于磁盘，不会自动恢复', 'open_file', safeFile(page.path)); continue;
          }
          if (!row) { add(`UNINDEXED:${page.pageId}`, 'action_required', '磁盘页面尚未索引，需要重建 Wiki 索引', 'reindex_wiki', safeFile(page.path)); continue; }
          let refs = page.sourceRefs; let validRefs = true;
          if (!refs.length && page.sources.length) {
            refs = page.sources.flatMap((path) => {
              const mapped = this.db.prepare('SELECT source_id FROM wiki_legacy_source_map WHERE kb_id=? AND snapshot_path=?').get(id, path);
              if (!mapped) { validRefs = false; return []; }
              return [{ sourceId: String(mapped.source_id), revision: 1 }];
            });
          }
          for (const ref of refs) if (!this.db.prepare('SELECT 1 FROM wiki_source_revisions WHERE kb_id=? AND source_id=? AND revision=?').get(id, ref.sourceId, ref.revision)) validRefs = false;
          let indexedRefs: unknown;
          try { indexedRefs = JSON.parse(String(row.source_refs)); } catch { validRefs = false; }
          const autoSourceId = page.autoSourceId ?? (page.sources.length === 1 && refs.length === 1 ? refs[0].sourceId : null);
          const matches = fts.filter((entry) => entry.page === page.pageId);
          if (!validRefs || row.content_hash !== page.contentHash || row.path !== relative(this.files.bucketDir(library), page.path).replace(/\\/g, '/')
            || row.title !== page.title || row.workspace !== (library.legacyWorkspace ?? '') || row.source_path !== page.sourcePath
            || Number(row.locked) !== Number(page.locked) || Number(row.revision) !== page.revision || Number(row.updated_at) !== page.updatedAt
            || Number(row.chunks) !== chunkMarkdown(page.content, page.sourcePath, page.title).length || row.auto_source_id !== autoSourceId
            || JSON.stringify(indexedRefs) !== JSON.stringify(refs) || matches.length !== 1 || matches[0].content !== page.content || matches[0].title !== page.title || matches[0].workspace !== (library.legacyWorkspace ?? '')) {
            add(`INDEX_MISMATCH:${page.pageId}`, 'action_required', '页面完整文件哈希或索引元数据不一致，需要重建 Wiki 索引', 'reindex_wiki', safeFile(page.path));
          }
        }
        for (const pageId of indexed.keys()) add(`REMOVED:${pageId}`, 'action_required', '索引中的页面已移除，需要重建 Wiki 索引', 'reindex_wiki');
        const diskIds = new Set(scanned.pages.map((page) => page.pageId));
        if (fts.some((row) => !diskIds.has(String(row.page)))) add('STALE_FTS', 'action_required', '搜索索引包含已移除页面，需要重建 Wiki 索引', 'reindex_wiki');
        if (items.length === start) add('HEALTHY', 'ok', `已只读检查 ${scanned.pages.length} 个页面，文件与索引一致`);
      } catch { add('CHECK_FAILED', 'unchecked', '无法读取知识库文件或索引，本次未完成检查'); }
    }
    return items.length ? items : [{ id: 'wiki:unchecked', checkedAt, state: 'unchecked', message: '尚无知识库，本次未检查 Wiki 文件' }];
  }

  searchByLibraries(kbIds: string[], query: string, limit = 20): WikiPageHit[] {
    const active = [...new Set(kbIds)].filter((kbId) => this.libraries.get(kbId)?.lifecycle === 'active');
    if (!active.length || !query.trim()) return [];
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 20;
    return this.db.prepare(`SELECT f.kb_id,f.page,p.title,snippet(wiki_fts,4,'','','...',24) AS snippet FROM wiki_fts f JOIN wiki_documents p ON p.kb_id=f.kb_id AND p.page=f.page
      WHERE f.kb_id IN (${active.map(() => '?').join(',')}) AND wiki_fts MATCH ? LIMIT ?`).all(...active, query.trim(), bounded)
      .filter((row) => !this.libraries.pageDeleted(String(row.kb_id), String(row.page)))
      .map((row) => ({ kbId: String(row.kb_id), pageId: String(row.page), title: String(row.title), snippet: String(row.snippet) }));
  }

  replacePage(scope: WikiWriteScope, page: string, title: string, content: string, sourcePath = page, sourceContent?: string): WikiChunk[] {
    const normalizedSource = this.files.sourcePath(scope.workspace, sourcePath); wikiRelativePath(page);
    const current = this.readPage(scope, page); if (current?.locked) throw new Error('Wiki page is locked; generated updates are not allowed');
    const library = this.libraryForWorkspace(scope.workspace, true)!; this.libraries.assertActive(library.kbId);
    if (this.libraries.pageDeleted(library.kbId, page)) throw new Error('RESOURCE_DELETED: Wiki page is deleted');
    const path = current ? relative(this.files.workspaceDir(scope.workspace), current.path).replace(/\\/g, '/') : this.files.pagePath(scope.workspace, page);
    const snapshot = sourceContent === undefined ? undefined : this.files.snapshotPath(normalizedSource, sourceContent);
    const sources = snapshot ? [snapshot] : current?.sourcePath === normalizedSource ? current.sources : [];
    const document: WikiPageDocument = { workspace: scope.workspace, page, title, content, sourcePath: normalizedSource, sources, path: this.files.filePath(scope.workspace, path), locked: false, updatedAt: Date.now() };
    this.libraries.transaction(() => {
      if (snapshot) {
        if (existsSync(this.files.filePath(scope.workspace, snapshot))) { if (this.files.readText(scope.workspace, snapshot) !== sourceContent) throw new Error('Wiki source snapshot conflicts with supplied content'); }
        else this.libraries.registerPublication(this.files.publish(scope.workspace, snapshot, sourceContent!));
      }
      const text = this.files.render(document);
      const refs = sources.map((snapshotPath) => this.sources.registerLegacy(library.kbId, snapshotPath, undefined, page));
      this.index({ kbId: library.kbId, pageId: page, title, content, path: document.path, sourceRefs: refs, ...(refs.length === 1 ? { autoSourceId: refs[0].sourceId } : {}), locked: false, revision: 0, contentHash: wikiHash(text), lifecycle: 'active', epoch: 0, updatedAt: document.updatedAt }, library, normalizedSource);
      this.libraries.registerPublication(this.files.publish(scope.workspace, path, text));
    });
    return chunkMarkdown(content, normalizedSource, title).map((chunk) => ({ ...chunk, id: wikiHash(`${scope.workspace}:${page}:${chunk.hash}`).slice(0, 32), page }));
  }

  replaceLegacyProtected(scope: WikiWriteScope, pageId: string, title: string, content: string, sourcePath = pageId, sourceContent?: string, expected?: WikiVersion | null): WikiPublishResult {
    wikiRelativePath(pageId);
    const normalizedSource = this.files.sourcePath(scope.workspace, sourcePath);
    try { return this.libraries.transaction(() => {
      const library = this.libraryForWorkspace(scope.workspace, true)!;
      const skipped = (reason: 'locked' | 'changed' | 'multi_source' | 'deleted' | 'suppressed'): WikiPublishResult => ({ state: 'skipped', reason });
      if (library.lifecycle !== 'active' || this.libraries.pageDeleted(library.kbId, pageId)) return skipped('deleted');
      let disk: WikiDiskPage | undefined;
      try { disk = this.diskById(library, pageId); } catch { return skipped('changed'); }
      const current = disk ? this.withState(disk) : undefined;
      if (current?.locked) return skipped('locked');
      if (current && (current.sourceRefs.length > 1 || (current.sourceRefs.length === 1 && current.autoSourceId !== current.sourceRefs[0].sourceId))) return skipped('multi_source');
      if (current ? !expected || expected.revision !== current.revision || expected.contentHash !== current.contentHash : expected != null) return skipped('changed');
      let source = current?.autoSourceId ? this.sources.get(library.kbId, current.autoSourceId) : undefined;
      if (current?.autoSourceId && !source) return skipped('deleted');
      if (source && source.lifecycle !== 'active') return skipped('deleted');
      if (source?.generationSuppressed) return skipped('suppressed');
      // A source edited independently of this page is pending a deliberate ingest.
      // The old writer has only a page baseline, so it must not overwrite that revision.
      if (source && (current?.sourceRefs.length !== 1 || current.sourceRefs[0].sourceId !== source.sourceId || current.sourceRefs[0].revision !== source.revision)) return skipped('changed');
      if (sourceContent !== undefined) {
        if (source) source = this.sources.updateText(library.kbId, source.sourceId, sourceContent, source);
        else {
          source = this.sources.createText(library.kbId, { kind: 'manual', name: 'legacy-source.txt', content: sourceContent });
          this.db.prepare('UPDATE wiki_sources SET generated_page_id=? WHERE kb_id=? AND source_id=?').run(pageId, library.kbId, source.sourceId);
        }
      }
      const page: WikiPage = { kbId: library.kbId, pageId, title, content, path: current?.path ?? this.files.filePathAt(library, this.files.pagePath(scope.workspace, pageId)),
        sourceRefs: source ? [{ sourceId: source.sourceId, revision: source.revision }] : current?.sourceRefs ?? [], locked: false,
        ...(source ? { autoSourceId: source.sourceId } : {}), revision: (current?.revision ?? 0) + 1, contentHash: '', lifecycle: 'active', epoch: current?.epoch ?? 0, updatedAt: Date.now() };
      const result = this.publishPage(library, page, current?.contentHash ?? null, { ...page, sources: [], sourcePath: normalizedSource, workspace: scope.workspace });
      this.db.prepare('UPDATE wiki_documents SET source_path=? WHERE kb_id=? AND page=?').run(normalizedSource, library.kbId, pageId);
      return { state: 'published', page: result };
    }); } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT:')) return { state: 'skipped', reason: 'changed' };
      throw error;
    }
  }

  readPage(scope: WikiWriteScope, page: string): WikiPageDocument | undefined {
    wikiRelativePath(page); const library = this.libraryForWorkspace(scope.workspace);
    if (library && (library.lifecycle !== 'active' || this.libraries.pageDeleted(library.kbId, page))) return undefined;
    const row = this.db.prepare('SELECT path FROM wiki_documents WHERE workspace=? AND page=?').get(scope.workspace, page) as { path: string } | undefined;
    const document = row ? this.files.read(scope.workspace, row.path) : undefined;
    if (document) { if (document.page !== page) throw new Error('Wiki page metadata mismatch; rebuild the index'); return library ? this.legacyDocument(document, library) : document; }
    const scanned = this.files.scan(scope.workspace); if (scanned.failedBuckets.size) throw new Error(`Wiki file scan failed: ${scanned.diagnostics.join('; ')}`);
    const found = scanned.pages.find((candidate) => candidate.page === page);
    return found && library ? this.legacyDocument(found, library) : found;
  }

  listPages(scope: WikiScope): WikiPageSummary[] {
    const scan = this.files.scan(scope.workspace);
    if (scan.diagnostics.length) throw new Error(`Wiki file scan failed: ${scan.diagnostics.join('; ')}`);
    return scan.pages.filter((page) => { const library = this.libraryForWorkspace(page.workspace); return !library || (library.lifecycle === 'active' && !this.libraries.pageDeleted(library.kbId, page.page)); })
      .map((document) => { const library = this.libraryForWorkspace(document.workspace); const { content: _content, ...summary } = library ? this.legacyDocument(document, library) : document; return summary; });
  }

  rebuildIndex(scope: WikiScope = {}): { pages: number; diagnostics: string[] } {
    const diagnostics = [...this.diagnostics.map((entry) => `${entry.path}: ${entry.message}`)]; let count = 0;
    const scanned = this.files.scan(scope.workspace); diagnostics.push(...scanned.diagnostics);
    this.diagnostics.push(...this.libraries.registerLegacyBuckets(this.legacyExportFailedBuckets));
    for (const library of this.libraries.list()) {
      if (library.lifecycle !== 'active' || (scope.workspace && library.legacyWorkspace !== scope.workspace) || scanned.failedBuckets.has(library.storageKey)) continue;
      const result = this.reindexLibrary(library.kbId); count += result.pages; diagnostics.push(...result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`));
    }
    return { pages: count, diagnostics };
  }

  search(scope: WikiScope, query: string, limit = 20): WikiSearchHit[] {
    const libraries = this.libraries.list().filter((library) => library.legacyWorkspace && (!scope.workspace || library.legacyWorkspace === scope.workspace));
    return this.searchByLibraries(libraries.map((library) => library.kbId), query, limit).flatMap((hit) => {
      const library = this.libraries.get(hit.kbId)!; const page = this.readPage({ workspace: library.legacyWorkspace! }, hit.pageId);
      return page ? [{ workspace: page.workspace, page: page.page, title: page.title, snippet: hit.snippet, sourcePath: page.sourcePath, chunks: chunkMarkdown(page.content, page.sourcePath, page.title).length }] : [];
    });
  }

  overview(scope: WikiScope): WikiOverview {
    const row = this.db.prepare(`SELECT COUNT(*) AS pages,MAX(d.updated_at) AS latest FROM wiki_documents d LEFT JOIN wiki_libraries l ON l.kb_id=d.kb_id
      WHERE (l.lifecycle='active' OR l.kb_id IS NULL) AND NOT EXISTS (SELECT 1 FROM wiki_page_state s WHERE s.kb_id=d.kb_id AND s.page_id=d.page AND s.lifecycle!='active')
      ${scope.workspace === undefined ? '' : 'AND d.workspace=?'}`).get(...(scope.workspace === undefined ? [] : [scope.workspace]))!;
    return { pages: Number(row.pages), latestUpdatedAt: row.latest == null ? null : Number(row.latest) };
  }

  deleteWorkspace(scope: WikiWriteScope): void {
    const library = this.libraryForWorkspace(scope.workspace); if (!library) return;
    const target = { kind: 'library' as const, kbId: library.kbId }; this.libraries.beginDelete(target); this.libraries.finishDelete(target);
  }
}

export function chunkMarkdown(content: string, sourcePath: string, fallbackTitle = 'Untitled'): Array<Omit<WikiChunk, 'id' | 'page'>> {
  const lines = content.split(/\r?\n/); const chunks: Array<Omit<WikiChunk, 'id' | 'page'>> = []; let start = 0; let title = fallbackTitle;
  const flush = (end: number) => { const body = lines.slice(start, end).join('\n').trim(); if (!body) return; chunks.push({ title, content: body, sourcePath, startLine: start + 1, endLine: end, hash: wikiHash(body) }); };
  lines.forEach((line, index) => { const heading = /^(#{1,6})\s+(.+)$/.exec(line); if (!heading) return; flush(index); title = heading[2].trim(); start = index; }); flush(lines.length); return chunks;
}
