import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WikiImportPreview, WikiLibrary, WikiSource, WikiSourceRef, WikiVersion } from './wikiContracts';
import { WikiFiles, wikiHash, wikiRelativePath } from './wikiFiles';
import { normalizeWikiWorkspace, WikiLibraryStore } from './wikiLibraryStore';

interface SourceRow {
  kb_id: string; source_id: string; name: string; kind: WikiSource['kind']; project_workspace: string | null;
  relative_path: string | null; snapshot_path: string; lifecycle: WikiSource['lifecycle']; epoch: number;
  status: WikiSource['status']; processed_hash: string | null; generated_page_id: string; generation_suppressed: number;
  error: string | null; revision: number; content_hash: string; created_at: number; updated_at: number;
}

export class WikiSourceStore {
  constructor(private readonly db: DatabaseSync, private readonly files: WikiFiles, private readonly libraries: WikiLibraryStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_sources (
      kb_id TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      project_workspace TEXT, relative_path TEXT, snapshot_path TEXT NOT NULL, lifecycle TEXT NOT NULL,
      epoch INTEGER NOT NULL, status TEXT NOT NULL, processed_hash TEXT, generated_page_id TEXT NOT NULL,
      generation_suppressed INTEGER NOT NULL, error TEXT, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kb_id,source_id));
      CREATE TABLE IF NOT EXISTS wiki_source_revisions (
        kb_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
        snapshot_path TEXT NOT NULL, PRIMARY KEY(kb_id,source_id,revision));
      CREATE TABLE IF NOT EXISTS wiki_legacy_source_map (
        kb_id TEXT NOT NULL, snapshot_path TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(kb_id,snapshot_path));`);
  }

  private parse(row: SourceRow): WikiSource {
    return { kbId: row.kb_id, sourceId: row.source_id, name: row.name, kind: row.kind,
      projectWorkspace: row.project_workspace ?? undefined, relativePath: row.relative_path ?? undefined,
      snapshotPath: row.snapshot_path, lifecycle: row.lifecycle, epoch: row.epoch, status: row.status,
      processedHash: row.processed_hash ?? undefined, generatedPageId: row.generated_page_id,
      generationSuppressed: !!row.generation_suppressed, error: row.error ?? undefined,
      revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  list(kbId: string, includeDeleted = false): WikiSource[] {
    const rows = this.db.prepare(`SELECT * FROM wiki_sources WHERE kb_id=? ${includeDeleted ? '' : "AND lifecycle='active'"} ORDER BY created_at,source_id`).all(kbId) as unknown as SourceRow[];
    return rows.map((row) => this.parse(row));
  }

  get(kbId: string, sourceId: string): WikiSource | undefined {
    const row = this.db.prepare('SELECT * FROM wiki_sources WHERE kb_id=? AND source_id=?').get(kbId, sourceId) as unknown as SourceRow | undefined;
    return row ? this.parse(row) : undefined;
  }

  private assertActive(kbId: string, sourceId: string): WikiSource {
    this.libraries.assertActive(kbId);
    const source = this.get(kbId, sourceId);
    if (!source) throw new Error('NOT_FOUND: Wiki source not found');
    if (source.lifecycle === 'deleting') throw new Error('RESOURCE_DELETING: Wiki source is deleting');
    if (source.lifecycle === 'deleted') throw new Error('RESOURCE_DELETED: Wiki source is deleted');
    return source;
  }

  private textName(name: string): string {
    if (typeof name !== 'string' || wikiRelativePath(name).includes('/') || !/\.(md|txt)$/i.test(name)) throw new Error('Wiki source name must be an .md or .txt filename');
    return name;
  }

  private insert(source: WikiSource): void {
    this.db.prepare(`INSERT INTO wiki_sources(kb_id,source_id,name,kind,project_workspace,relative_path,snapshot_path,lifecycle,epoch,status,
      processed_hash,generated_page_id,generation_suppressed,error,revision,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(source.kbId, source.sourceId, source.name, source.kind, source.projectWorkspace ?? null, source.relativePath ?? null,
        source.snapshotPath, source.lifecycle, source.epoch, source.status, source.processedHash ?? null, source.generatedPageId,
        source.generationSuppressed ? 1 : 0, source.error ?? null, source.revision, source.contentHash, source.createdAt, source.updatedAt);
    this.insertRevision(source);
  }

  private insertRevision(source: WikiSource): void {
    this.db.prepare('INSERT INTO wiki_source_revisions(kb_id,source_id,revision,content_hash,snapshot_path) VALUES(?,?,?,?,?)')
      .run(source.kbId, source.sourceId, source.revision, source.contentHash, source.snapshotPath);
  }

  private newSource(kbId: string, name: string, kind: WikiSource['kind'], content: string): WikiSource {
    const sourceId = randomUUID(); const contentHash = wikiHash(content); const now = Date.now();
    return { kbId, sourceId, name, kind, snapshotPath: `raw/sources/${sourceId}/1-${contentHash}${extname(name).toLowerCase()}`,
      lifecycle: 'active', epoch: 0, status: 'pending', generatedPageId: randomUUID(), generationSuppressed: false,
      revision: 1, contentHash, createdAt: now, updatedAt: now };
  }

  private publishNew(library: WikiLibrary, source: WikiSource, content: string): WikiSource {
    this.libraries.registerPublication(this.files.publishAt(library, source.snapshotPath, content, null));
    this.insert(source);
    return this.get(source.kbId, source.sourceId)!;
  }

  createText(kbId: string, input: { kind: 'manual' | 'upload'; name: string; content: string }): WikiSource {
    const name = this.textName(input.name);
    if (input.kind !== 'manual' && input.kind !== 'upload') throw new Error('invalid Wiki text source kind');
    return this.libraries.transaction(() => {
      const library = this.libraries.assertActive(kbId);
      return this.publishNew(library, this.newSource(kbId, name, input.kind, input.content), input.content);
    });
  }

  createProject(kbId: string, preview: WikiImportPreview, content: string): WikiSource {
    const name = this.textName(preview.name); const relativePath = wikiRelativePath(preview.relativePath);
    const workspace = normalizeWikiWorkspace(preview.projectWorkspace);
    return this.libraries.transaction(() => {
      const library = this.libraries.assertActive(kbId);
      if (!library.bindings.some((binding) => normalizeWikiWorkspace(binding) === workspace)) throw new Error('FORBIDDEN: Wiki project binding has changed');
      if (preview.contentHash !== wikiHash(content)) throw new Error('VERSION_CONFLICT: Wiki import preview content hash has changed');
      const source = { ...this.newSource(kbId, name, 'project', content), projectWorkspace: workspace, relativePath };
      return this.publishNew(library, source, content);
    });
  }

  updateText(kbId: string, sourceId: string, content: string, expected: WikiVersion): WikiSource {
    return this.libraries.transaction(() => {
      const current = this.assertActive(kbId, sourceId);
      if (current.revision !== expected.revision || current.contentHash !== expected.contentHash) throw new Error('VERSION_CONFLICT: Wiki source version conflict');
      this.readSnapshot(kbId, current);
      const contentHash = wikiHash(content);
      if (current.contentHash === contentHash) return current;
      const updated: WikiSource = { ...current, revision: current.revision + 1, contentHash, epoch: current.epoch + 1,
        snapshotPath: `raw/sources/${sourceId}/${current.revision + 1}-${contentHash}${/\.md$/i.test(current.name) ? '.md' : '.txt'}`,
        status: 'pending', error: undefined, updatedAt: Date.now() };
      this.libraries.registerPublication(this.files.publishAt(this.libraries.assertActive(kbId), updated.snapshotPath, content, null));
      const result = this.db.prepare(`UPDATE wiki_sources SET revision=?,content_hash=?,snapshot_path=?,epoch=?,status='pending',error=NULL,updated_at=?
        WHERE kb_id=? AND source_id=? AND lifecycle='active' AND revision=? AND content_hash=?`)
        .run(updated.revision, contentHash, updated.snapshotPath, updated.epoch, updated.updatedAt, kbId, sourceId, expected.revision, expected.contentHash);
      if (!result.changes) throw new Error('VERSION_CONFLICT: Wiki source version conflict');
      this.insertRevision(updated);
      return this.get(kbId, sourceId)!;
    });
  }

  readSnapshot(kbId: string, ref: WikiSourceRef): string {
    const library = this.libraries.get(kbId);
    if (!library) throw new Error('Wiki source library not found');
    const row = this.db.prepare('SELECT content_hash,snapshot_path FROM wiki_source_revisions WHERE kb_id=? AND source_id=? AND revision=?')
      .get(kbId, ref.sourceId, ref.revision) as { content_hash: string; snapshot_path: string } | undefined;
    if (!row) throw new Error('Wiki source snapshot revision not found');
    const bytes = readFileSync(this.files.filePathAt(library, row.snapshot_path));
    if (createHash('sha256').update(bytes).digest('hex') !== row.content_hash) throw new Error(`VERSION_CONFLICT: Wiki source snapshot hash changed: ${row.snapshot_path}`);
    return bytes.toString('utf8');
  }

  pending(kbId: string, sourceIds?: string[]): WikiSource[] {
    if (this.libraries.get(kbId)?.lifecycle !== 'active') return [];
    const selected = sourceIds === undefined ? undefined : new Set(sourceIds);
    return this.list(kbId).filter((source) => !source.generationSuppressed && source.status !== 'processing'
      && (source.status === 'pending' || source.status === 'failed' || source.processedHash !== source.contentHash)
      && (!selected || selected.has(source.sourceId)));
  }

  markProcessing(kbId: string, sourceId: string, revision: number): boolean {
    return this.libraries.transaction(() => {
      if (this.libraries.get(kbId)?.lifecycle !== 'active') return false;
      return !!this.db.prepare(`UPDATE wiki_sources SET status='processing',error=NULL,updated_at=?
        WHERE kb_id=? AND source_id=? AND revision=? AND lifecycle='active' AND generation_suppressed=0 AND status!='processing'`)
        .run(Date.now(), kbId, sourceId, revision).changes;
    });
  }

  markResult(kbId: string, sourceId: string, revision: number, result: { status: 'succeeded' | 'failed' | 'pending'; contentHash?: string; error?: string }): boolean {
    return this.libraries.transaction(() => {
      if (this.libraries.get(kbId)?.lifecycle !== 'active') return false;
      const source = this.get(kbId, sourceId);
      if (!source || source.lifecycle !== 'active' || source.generationSuppressed || source.revision !== revision
        || (result.contentHash !== undefined && result.contentHash !== source.contentHash)) return false;
      return !!this.db.prepare(`UPDATE wiki_sources SET status=?,processed_hash=?,error=?,updated_at=?
        WHERE kb_id=? AND source_id=? AND revision=? AND lifecycle='active' AND generation_suppressed=0`)
        .run(result.status, result.status === 'succeeded' ? source.contentHash : source.processedHash ?? null,
          result.status === 'failed' ? result.error ?? null : null, Date.now(), kbId, sourceId, revision).changes;
    });
  }

  suppress(kbId: string, sourceId: string): WikiSource {
    return this.libraries.transaction(() => {
      const source = this.assertActive(kbId, sourceId);
      if (source.generationSuppressed) return source;
      this.db.prepare('UPDATE wiki_sources SET generation_suppressed=1,epoch=epoch+1,updated_at=? WHERE kb_id=? AND source_id=?').run(Date.now(), kbId, sourceId);
      return this.get(kbId, sourceId)!;
    });
  }

  allowRegeneration(kbId: string, sourceId: string): WikiSource {
    return this.libraries.transaction(() => {
      const source = this.assertActive(kbId, sourceId);
      const pageId = this.libraries.pageDeleted(kbId, source.generatedPageId) ? randomUUID() : source.generatedPageId;
      this.db.prepare("UPDATE wiki_sources SET generation_suppressed=0,generated_page_id=?,processed_hash=NULL,status='pending',error=NULL,epoch=epoch+1,updated_at=? WHERE kb_id=? AND source_id=?")
        .run(pageId, Date.now(), kbId, sourceId);
      return this.get(kbId, sourceId)!;
    });
  }

  registerLegacy(kbId: string, snapshotPath: string, name?: string, pageId?: string): WikiSourceRef {
    const path = wikiRelativePath(snapshotPath);
    if (!path.startsWith('raw/sources/')) throw new Error(`invalid Wiki legacy source snapshot path: ${path}`);
    return this.libraries.transaction(() => {
      const library = this.libraries.assertActive(kbId);
      const mapped = this.db.prepare('SELECT source_id FROM wiki_legacy_source_map WHERE kb_id=? AND snapshot_path=?').get(kbId, path) as { source_id: string } | undefined;
      if (mapped) {
        const ref = { sourceId: mapped.source_id, revision: 1 };
        this.readSnapshot(kbId, ref);
        return ref;
      }
      let content: string;
      try { content = this.files.readTextAt(library, path); }
      catch (error) { throw new Error(`Wiki legacy source snapshot unavailable at ${path}: ${String(error)}`); }
      const source = { ...this.newSource(kbId, name ?? basename(path), 'legacy', content), snapshotPath: path,
        generatedPageId: pageId ?? randomUUID(), status: 'succeeded' as const, processedHash: wikiHash(content) };
      this.insert(source);
      this.db.prepare('INSERT INTO wiki_legacy_source_map(kb_id,snapshot_path,source_id) VALUES(?,?,?)').run(kbId, path, source.sourceId);
      return { sourceId: source.sourceId, revision: source.revision };
    });
  }
}
