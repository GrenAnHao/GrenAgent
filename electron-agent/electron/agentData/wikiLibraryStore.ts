import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WikiDeleteResult, WikiDiagnostic, WikiLibrary, WikiLibraryInput, WikiPage, WikiRequestContext, WikiTarget, WikiTaskTarget, WikiWritePermit } from './wikiContracts';
import { WikiFiles, wikiHash, type WikiFilePublication } from './wikiFiles';

export function normalizeWikiWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('Wiki workspace is required');
  const normalized = resolve(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

interface LibraryRow {
  kb_id: string; storage_key: string; name: string; description: string; bindings: string; revision: number;
  lifecycle: WikiLibrary['lifecycle']; epoch: number; created_at: number; updated_at: number; legacy_workspace: string | null;
}

export class WikiLibraryStore {
  readonly diagnostics: WikiDiagnostic[] = [];
  private depth = 0;
  private publications: WikiFilePublication[] = [];
  private pageReader?: (kbId: string, pageId: string) => WikiPage | undefined;

  constructor(readonly db: DatabaseSync, readonly files: WikiFiles) {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_libraries (
      kb_id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, bindings TEXT NOT NULL,
      revision INTEGER NOT NULL, lifecycle TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, legacy_workspace TEXT);
      CREATE TABLE IF NOT EXISTS wiki_legacy_library_map (workspace TEXT PRIMARY KEY, kb_id TEXT NOT NULL UNIQUE, storage_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS wiki_page_state (kb_id TEXT NOT NULL, page_id TEXT NOT NULL, lifecycle TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(kb_id,page_id));
      CREATE TABLE IF NOT EXISTS wiki_task_targets (task_source TEXT NOT NULL, task_id TEXT NOT NULL, kb_id TEXT NOT NULL,
        source_id TEXT NOT NULL DEFAULT '', page_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL, can_cancel INTEGER NOT NULL,
        PRIMARY KEY(task_source,task_id,kb_id,source_id,page_id));`);
  }

  /** All participants must be synchronous and share this SQLite connection. */
  transaction<T>(fn: () => T): T {
    if (this.depth) {
      const savepoint = `wiki_${this.depth++}`; const publicationStart = this.publications.length;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Wiki transaction must be synchronous');
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        for (const publication of this.publications.splice(publicationStart).reverse()) {
          try { publication.rollback(); } catch { /* Keep .rollback recovery files. */ }
        }
        throw error;
      } finally { this.depth--; }
    }
    this.db.exec('BEGIN IMMEDIATE'); this.depth = 1; this.publications = [];
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Wiki transaction must be synchronous');
      this.db.exec('COMMIT');
      const publications = this.publications; this.publications = []; this.depth = 0;
      for (const publication of publications) publication.commit();
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* A failed COMMIT may already have rolled back. */ }
      const publications = this.publications; this.publications = []; this.depth = 0;
      for (const publication of publications.reverse()) {
        try { publication.rollback(); } catch { /* Keep the .rollback file for recovery if restoring fails. */ }
      }
      throw error;
    }
  }

  registerPublication(publication: WikiFilePublication): void {
    if (!this.depth) throw new Error('Wiki publication requires a transaction');
    this.publications.push(publication);
  }

  attachPageReader(reader: (kbId: string, pageId: string) => WikiPage | undefined): void { this.pageReader = reader; }

  private parse(row: LibraryRow): WikiLibrary {
    return { kbId: row.kb_id, storageKey: row.storage_key, name: row.name, description: row.description, bindings: JSON.parse(row.bindings),
      revision: row.revision, lifecycle: row.lifecycle, epoch: row.epoch, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.legacy_workspace ? { legacyWorkspace: row.legacy_workspace } : {}) };
  }

  get(kbId: string): WikiLibrary | undefined {
    const row = this.db.prepare('SELECT * FROM wiki_libraries WHERE kb_id=?').get(kbId) as unknown as LibraryRow | undefined;
    return row ? this.parse(row) : undefined;
  }

  list(includeDeleted = false): WikiLibrary[] {
    return (this.db.prepare(`SELECT * FROM wiki_libraries ${includeDeleted ? '' : "WHERE lifecycle!='deleted'"} ORDER BY created_at,kb_id`).all() as unknown as LibraryRow[]).map((row) => this.parse(row));
  }

  private validate(input: WikiLibraryInput): WikiLibraryInput {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 80) throw new Error('invalid Wiki library name');
    if (typeof input.description !== 'string' || [...input.description.trim()].length > 500) throw new Error('invalid Wiki library description');
    if (!Array.isArray(input.bindings)) throw new Error('invalid Wiki library bindings');
    const seen = new Set<string>();
    const bindings = input.bindings.filter((binding) => { const normalized = normalizeWikiWorkspace(binding); if (seen.has(normalized)) return false; seen.add(normalized); return true; });
    return { name: input.name.trim(), description: input.description.trim(), bindings };
  }

  private persist(library: WikiLibrary): void {
    this.db.prepare(`INSERT INTO wiki_libraries(kb_id,storage_key,name,description,bindings,revision,lifecycle,epoch,created_at,updated_at,legacy_workspace)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kb_id) DO UPDATE SET name=excluded.name,description=excluded.description,bindings=excluded.bindings,
      revision=excluded.revision,lifecycle=excluded.lifecycle,epoch=excluded.epoch,updated_at=excluded.updated_at`)
      .run(library.kbId, library.storageKey, library.name, library.description, JSON.stringify(library.bindings), library.revision, library.lifecycle, library.epoch, library.createdAt, library.updatedAt, library.legacyWorkspace ?? null);
    this.registerPublication(this.files.publishAt(library, 'library.json', JSON.stringify({ version: 1, ...library }, null, 2)));
  }

  create(input: WikiLibraryInput): WikiLibrary {
    const value = this.validate(input); const now = Date.now();
    const library: WikiLibrary = { ...value, kbId: randomUUID(), storageKey: `kb-${randomUUID()}`, revision: 1, lifecycle: 'active', epoch: 0, createdAt: now, updatedAt: now };
    return this.transaction(() => { this.persist(library); return library; });
  }

  update(kbId: string, input: WikiLibraryInput, expectedRevision: number): WikiLibrary {
    const value = this.validate(input);
    return this.transaction(() => {
      const current = this.assertActive(kbId);
      if (current.revision !== expectedRevision) throw new Error('VERSION_CONFLICT: Wiki library revision conflict');
      const updated = { ...current, ...value, revision: current.revision + 1, updatedAt: Date.now() };
      this.persist(updated); return updated;
    });
  }

  resolveLegacy(workspace: string): WikiLibrary | undefined {
    const normalized = normalizeWikiWorkspace(workspace);
    const exact = this.db.prepare('SELECT kb_id FROM wiki_legacy_library_map WHERE workspace=?').get(workspace) as { kb_id: string } | undefined;
    const row = exact ?? (this.db.prepare('SELECT workspace,kb_id FROM wiki_legacy_library_map ORDER BY workspace').all() as Array<{ workspace: string; kb_id: string }>).find((entry) => normalizeWikiWorkspace(entry.workspace) === normalized);
    return row ? this.get(row.kb_id) : undefined;
  }

  registerLegacyBuckets(excludedStorageKeys: Set<string> = new Set()): WikiDiagnostic[] {
    const diagnostics: WikiDiagnostic[] = [];
    for (const storageKey of readdirSync(this.files.root).filter((key) => /^[a-f0-9]{64}$/.test(key))) {
      if (excludedStorageKeys.has(storageKey)) continue;
      let path = `${storageKey}/workspace.json`;
      try {
        path = this.files.filePathAt(storageKey, 'workspace.json');
        const manifest = JSON.parse(this.files.readTextAt(storageKey, 'workspace.json')) as { workspace?: string };
        if (typeof manifest.workspace !== 'string' || wikiHash(manifest.workspace) !== storageKey) throw new Error('invalid Wiki workspace mapping');
        this.files.manifest(manifest.workspace);
        const workspace = manifest.workspace;
        const mapped = this.db.prepare('SELECT kb_id FROM wiki_legacy_library_map WHERE workspace=? OR storage_key=?').get(workspace, storageKey) as { kb_id: string } | undefined;
        if (mapped) {
          path = this.files.filePathAt(storageKey, 'library.json');
          const registered = this.get(mapped.kb_id);
          if (!registered) throw new Error('Wiki legacy library mapping is missing its library');
          this.files.checkBucket(registered); continue;
        }
        const now = Date.now();
        const library: WikiLibrary = { kbId: randomUUID(), storageKey, name: basename(normalizeWikiWorkspace(workspace)) || workspace, description: '', bindings: [workspace], revision: 1, lifecycle: 'active', epoch: 0, createdAt: now, updatedAt: now, legacyWorkspace: manifest.workspace };
        if (existsSync(this.files.filePathAt(storageKey, 'library.json'))) {
          path = this.files.filePathAt(storageKey, 'library.json');
          const existing = JSON.parse(this.files.readTextAt(storageKey, 'library.json')) as WikiLibrary & { version: number };
          if (existing.version !== 1 || existing.storageKey !== storageKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(existing.kbId) || !Array.isArray(existing.bindings) || !['active', 'deleting', 'deleted'].includes(existing.lifecycle)
            || !Number.isSafeInteger(existing.revision) || existing.revision < 1 || !Number.isSafeInteger(existing.epoch) || existing.epoch < 0) throw new Error('invalid Wiki library manifest');
          this.validate(existing);
          if (this.get(existing.kbId)?.storageKey && this.get(existing.kbId)!.storageKey !== storageKey) throw new Error('Wiki library ID belongs to a different storage bucket');
          Object.assign(library, existing, { legacyWorkspace: manifest.workspace });
        }
        this.transaction(() => {
          this.persist(library);
          this.db.prepare('INSERT INTO wiki_legacy_library_map(workspace,kb_id,storage_key) VALUES(?,?,?)').run(workspace, library.kbId, storageKey);
        });
      } catch (error) { diagnostics.push({ code: 'LEGACY_REGISTRATION_FAILED', path, message: String(error) }); }
    }
    this.diagnostics.push(...diagnostics); return diagnostics;
  }

  assertActive(kbId: string): WikiLibrary {
    const library = this.get(kbId);
    if (!library || library.lifecycle !== 'active') throw new Error(`${library?.lifecycle === 'deleting' ? 'RESOURCE_DELETING' : 'RESOURCE_DELETED'}: Wiki library is not active`);
    return library;
  }

  assertAccess(context: WikiRequestContext, kbId: string): WikiLibrary {
    const library = this.assertActive(kbId);
    if (context.kind === 'project' && !library.bindings.some((binding) => normalizeWikiWorkspace(binding) === normalizeWikiWorkspace(context.workspace))) throw new Error('FORBIDDEN: Wiki library access denied');
    return library;
  }

  visibleLibraries(context: WikiRequestContext): WikiLibrary[] {
    return this.list().filter((library) => library.lifecycle === 'active' && (context.kind === 'admin' || library.bindings.some((binding) => normalizeWikiWorkspace(binding) === normalizeWikiWorkspace(context.workspace))));
  }

  pageDeleted(kbId: string, pageId: string): boolean {
    const row = this.db.prepare('SELECT lifecycle FROM wiki_page_state WHERE kb_id=? AND page_id=?').get(kbId, pageId) as { lifecycle: string } | undefined;
    return !!row && row.lifecycle !== 'active';
  }

  private pageState(kbId: string, pageId: string): { lifecycle: string; epoch: number } {
    return (this.db.prepare('SELECT lifecycle,epoch FROM wiki_page_state WHERE kb_id=? AND page_id=?').get(kbId, pageId) as { lifecycle: string; epoch: number } | undefined) ?? { lifecycle: 'active', epoch: 0 };
  }

  acquirePermit(kbId: string, sourceId: string): WikiWritePermit {
    return this.transaction(() => {
      const library = this.assertActive(kbId);
      const source = this.db.prepare('SELECT lifecycle,epoch,revision,generated_page_id FROM wiki_sources WHERE kb_id=? AND source_id=?').get(kbId, sourceId) as { lifecycle: string; epoch: number; revision: number; generated_page_id: string } | undefined;
      if (!source || source.lifecycle !== 'active') throw new Error('Wiki source is not active');
      const pageId = source.generated_page_id; const state = this.pageState(kbId, pageId);
      if (state.lifecycle !== 'active') throw new Error('Wiki page is deleted');
      if (!this.pageReader) throw new Error('Wiki page reader is not initialized');
      const page = this.pageReader(kbId, pageId);
      return { kbId, sourceId, pageId, libraryEpoch: library.epoch, sourceEpoch: source.epoch, sourceRevision: source.revision, pageEpoch: state.epoch,
        expected: page ? { revision: page.revision, contentHash: page.contentHash } : null };
    });
  }

  permitActive(permit: WikiWritePermit): boolean {
    const library = this.get(permit.kbId);
    if (!library || library.lifecycle !== 'active' || library.epoch !== permit.libraryEpoch) return false;
    const source = this.db.prepare('SELECT lifecycle,epoch,revision,generated_page_id FROM wiki_sources WHERE kb_id=? AND source_id=?').get(permit.kbId, permit.sourceId) as { lifecycle: string; epoch: number; revision: number; generated_page_id: string } | undefined;
    const page = this.pageState(permit.kbId, permit.pageId);
    return !!source && source.lifecycle === 'active' && source.epoch === permit.sourceEpoch && source.revision === permit.sourceRevision && source.generated_page_id === permit.pageId && page.lifecycle === 'active' && page.epoch === permit.pageEpoch;
  }

  beginDelete(target: WikiTarget): void {
    this.transaction(() => {
      const library = this.get(target.kbId); if (!library) throw new Error('Wiki library not found');
      if (target.kind === 'library') {
        if (library.lifecycle !== 'active') return;
        this.persist({ ...library, lifecycle: 'deleting', epoch: library.epoch + 1, revision: library.revision + 1, updatedAt: Date.now() });
      } else if (target.kind === 'source') {
        if (library.lifecycle !== 'active') throw new Error('Wiki library is not active');
        const result = this.db.prepare("UPDATE wiki_sources SET lifecycle='deleting',epoch=epoch+1,updated_at=? WHERE kb_id=? AND source_id=? AND lifecycle='active'").run(Date.now(), target.kbId, target.sourceId);
        if (!result.changes && !this.db.prepare('SELECT 1 FROM wiki_sources WHERE kb_id=? AND source_id=?').get(target.kbId, target.sourceId)) throw new Error('Wiki source not found');
      } else {
        if (library.lifecycle !== 'active') throw new Error('Wiki library is not active');
        this.db.prepare("INSERT INTO wiki_page_state(kb_id,page_id,lifecycle,epoch) VALUES(?,?,'deleting',1) ON CONFLICT(kb_id,page_id) DO UPDATE SET lifecycle='deleting',epoch=epoch+1 WHERE lifecycle='active'").run(target.kbId, target.pageId);
      }
    });
  }

  recordTask(target: WikiTaskTarget): void {
    this.transaction(() => {
      this.assertActive(target.kbId);
      if (target.sourceId) {
        const source = this.db.prepare('SELECT lifecycle FROM wiki_sources WHERE kb_id=? AND source_id=?').get(target.kbId, target.sourceId) as { lifecycle: string } | undefined;
        if (source?.lifecycle !== 'active') throw new Error('Wiki source is not active');
      }
      if (target.pageId && this.pageDeleted(target.kbId, target.pageId)) throw new Error('Wiki page is deleted');
      this.db.prepare(`INSERT INTO wiki_task_targets(task_source,task_id,kb_id,source_id,page_id,active,can_cancel) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(task_source,task_id,kb_id,source_id,page_id) DO UPDATE SET active=excluded.active,can_cancel=excluded.can_cancel`)
        .run(target.taskSource, target.taskId, target.kbId, target.sourceId ?? '', target.pageId ?? '', target.active ? 1 : 0, target.canCancel ? 1 : 0);
    });
  }

  activeTasks(target: WikiTarget): WikiTaskTarget[] {
    const condition = target.kind === 'source' ? " AND (source_id=? OR (source_id='' AND page_id=''))" : target.kind === 'page' ? " AND (page_id=? OR (source_id='' AND page_id=''))" : '';
    const params = target.kind === 'source' ? [target.kbId, target.sourceId] : target.kind === 'page' ? [target.kbId, target.pageId] : [target.kbId];
    return this.db.prepare(`SELECT * FROM wiki_task_targets WHERE kb_id=? AND active=1${condition}`).all(...params).map((row) => ({
      taskSource: row.task_source as WikiTaskTarget['taskSource'], taskId: String(row.task_id), kbId: String(row.kb_id),
      ...(row.source_id ? { sourceId: String(row.source_id) } : {}), ...(row.page_id ? { pageId: String(row.page_id) } : {}), active: true, canCancel: !!row.can_cancel,
    }));
  }

  settleTask(taskSource: WikiTaskTarget['taskSource'], taskId: string): void { this.db.prepare('UPDATE wiki_task_targets SET active=0 WHERE task_source=? AND task_id=?').run(taskSource, taskId); }

  /** Run only during startup after job/service recovery, never from UI cancellation. */
  recoverTasks(): void {
    for (const [taskSource, table] of [['agent_job', 'agent_jobs'], ['service_task', 'service_tasks']] as const) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name));
      const status = columns.includes('state') ? 'state' : 'status';
      this.db.exec(`UPDATE wiki_task_targets SET active=0 WHERE task_source='${taskSource}' AND active=1 AND EXISTS
        (SELECT 1 FROM ${table} WHERE id=wiki_task_targets.task_id AND ${status} IN ('succeeded','failed','cancelled','completed','interrupted'))`);
      if (taskSource === 'service_task') this.db.exec(`UPDATE wiki_task_targets SET active=0 WHERE task_source='service_task' AND active=1 AND NOT EXISTS
        (SELECT 1 FROM service_tasks WHERE id=wiki_task_targets.task_id)`);
    }
  }

  finishDelete(target: WikiTarget): WikiDeleteResult {
    return this.transaction(() => {
      const tasks = this.activeTasks(target); if (tasks.length) return { state: 'waiting', tasks };
      const library = this.get(target.kbId); if (!library) throw new Error('Wiki library not found');
      if (target.kind === 'library') {
        if (library.lifecycle === 'deleted') return { state: 'deleted' };
        if (library.lifecycle !== 'deleting') throw new Error('Wiki deletion has not begun');
        this.files.deleteBucketContent(library);
        for (const table of ['wiki_documents', 'wiki_fts']) if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) this.db.prepare(`DELETE FROM ${table} WHERE kb_id=?`).run(target.kbId);
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wiki_sources'").get()) this.db.prepare("UPDATE wiki_sources SET lifecycle='deleted',generation_suppressed=1 WHERE kb_id=?").run(target.kbId);
        this.persist({ ...library, bindings: [], lifecycle: 'deleted', updatedAt: Date.now() });
      } else if (target.kind === 'source') {
        const source = this.db.prepare('SELECT lifecycle FROM wiki_sources WHERE kb_id=? AND source_id=?').get(target.kbId, target.sourceId) as { lifecycle: string } | undefined;
        if (!source || source.lifecycle === 'active') throw new Error('Wiki source deletion has not begun');
        this.db.prepare("UPDATE wiki_sources SET lifecycle='deleted',generation_suppressed=1,updated_at=? WHERE kb_id=? AND source_id=?").run(Date.now(), target.kbId, target.sourceId);
      } else {
        if (!this.pageDeleted(target.kbId, target.pageId)) throw new Error('Wiki page deletion has not begun');
        const page = this.db.prepare('SELECT path,auto_source_id FROM wiki_documents WHERE kb_id=? AND page=?').get(target.kbId, target.pageId) as { path: string; auto_source_id: string | null } | undefined;
        const scanned = this.files.scanBucket(library);
        if (scanned.diagnostics.length) throw new Error(`Wiki page deletion scan failed: ${scanned.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
        for (const current of scanned.pages.filter((entry) => entry.pageId === target.pageId)) {
          this.files.removeAt(library, relative(this.files.bucketDir(library), current.path).replace(/\\/g, '/'));
        }
        if (page) {
          if (page.auto_source_id) this.db.prepare('UPDATE wiki_sources SET generation_suppressed=1 WHERE kb_id=? AND source_id=?').run(target.kbId, page.auto_source_id);
        }
        this.db.prepare('UPDATE wiki_sources SET generation_suppressed=1 WHERE kb_id=? AND generated_page_id=?').run(target.kbId, target.pageId);
        this.db.prepare('DELETE FROM wiki_documents WHERE kb_id=? AND page=?').run(target.kbId, target.pageId);
        this.db.prepare('DELETE FROM wiki_fts WHERE kb_id=? AND page=?').run(target.kbId, target.pageId);
        this.db.prepare("UPDATE wiki_page_state SET lifecycle='deleted' WHERE kb_id=? AND page_id=?").run(target.kbId, target.pageId);
      }
      return { state: 'deleted' };
    });
  }
}
