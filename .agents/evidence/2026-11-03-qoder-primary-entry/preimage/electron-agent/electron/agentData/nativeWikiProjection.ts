import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WikiOperation } from '../wikiService/contracts';
import type { NativeWikiPublicationSummary, NativeWikiTaskSummary } from './operationsContracts';

/** AgentData projection and the existing legacy lease table; never dispatches Wiki work. */
export class NativeWikiProjection {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_wiki_projection(operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, lease_id TEXT, revision INTEGER NOT NULL DEFAULT -1); CREATE TABLE IF NOT EXISTS native_wiki_events(id TEXT PRIMARY KEY);`);
  }
  admit(operation: WikiOperation, scope: string): string {
    if (!scope || !operation.id || !operation.repositoryRoot) throw new Error('INVALID_NATIVE_ADMISSION');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM native_wiki_projection WHERE operation_id=?').get(operation.id) as { task_id: string; scope: string; lease_id: string | null } | undefined;
      if (prior && prior.scope && prior.scope !== scope) throw new Error('NATIVE_SCOPE_MISMATCH');
      if (prior?.lease_id) throw new Error('NATIVE_ALREADY_ADMITTED');
      const old = this.db.prepare('SELECT expires_at,pinned FROM agent_job_leases WHERE scope=?').get(scope) as { expires_at: number; pinned: number } | undefined;
      if (old && (old.expires_at !== 0 || old.pinned)) throw new Error('LEASE_BUSY');
      const taskId = prior?.task_id ?? `native:${operation.id}`, leaseId = randomUUID(), now = Date.now();
      if (!prior) {
        const metadata = { target: { type: 'repoWiki', id: operation.repositoryRoot, language: operation.locale }, stage: '准备中' };
        this.db.prepare("INSERT INTO agent_jobs(id,kind,workspace,state,progress,error,created_at,updated_at,metadata) VALUES(?,?,?,'pending',0,NULL,?,?,?)").run(taskId, 'repoWiki.native', operation.repositoryRoot, now, now, JSON.stringify(metadata));
        this.db.prepare('INSERT INTO native_wiki_projection(operation_id,task_id,scope,lease_id) VALUES(?,?,?,?)').run(operation.id, taskId, scope, leaseId);
      } else this.db.prepare('UPDATE native_wiki_projection SET scope=?,lease_id=? WHERE operation_id=?').run(scope, leaseId, operation.id);
      const max = this.db.prepare('SELECT max(generation) AS n FROM agent_job_leases').get() as { n: number | null };
      this.db.prepare("INSERT INTO agent_job_leases(scope,task_id,owner_id,ledger_id,controller_epoch,generation,expires_at,pinned) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(scope) DO UPDATE SET task_id=excluded.task_id,owner_id=excluded.owner_id,ledger_id=excluded.ledger_id,controller_epoch=excluded.controller_epoch,generation=excluded.generation,expires_at=excluded.expires_at,pinned=1,claim_id=NULL,claim=NULL").run(scope, taskId, leaseId, 'native', 'native', (max.n ?? 0) + 1, now + 30000);
      this.db.exec('COMMIT'); return leaseId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  release(operation: WikiOperation, leaseId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM native_wiki_projection WHERE operation_id=?').get(operation.id) as { scope: string; task_id: string; lease_id: string | null } | undefined;
      if (!row || row.lease_id !== leaseId) throw new Error('NATIVE_LEASE_MISMATCH');
      const changed = this.db.prepare('UPDATE agent_job_leases SET expires_at=0,pinned=0 WHERE scope=? AND task_id=? AND owner_id=?').run(row.scope, row.task_id, leaseId);
      if (Number(changed.changes) !== 1) throw new Error('NATIVE_LEASE_MISMATCH');
      this.db.prepare('UPDATE native_wiki_projection SET lease_id=NULL WHERE operation_id=?').run(operation.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stage(eventId: string, operationId: string, stage: string, detail?: unknown): void {
    const names: Record<string, string> = { overview: '正在规划', plan: '正在规划', catalogue: '正在规划', page: '正在生成', 'commit-analysis': '正在分析', 'catalogue-analysis': '正在规划', 'page-update': '正在生成', 'page-add': '正在生成', advance: '正在发布' };
    if (!eventId || !operationId || !stage) throw new Error('INVALID_NATIVE_EVENT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT task_id FROM native_wiki_projection WHERE operation_id=?').get(operationId) as { task_id: string } | undefined;
      if (!row) throw new Error('NATIVE_PROJECTION_NOT_READY');
      const event = this.db.prepare('INSERT OR IGNORE INTO native_wiki_events(id) VALUES(?)').run(eventId);
      if (Number(event.changes)) {
        const job = this.db.prepare('SELECT metadata FROM agent_jobs WHERE id=?').get(row.task_id) as { metadata: string };
        const metadata = JSON.parse(job.metadata); metadata.stage = names[stage] ?? stage;
        if (detail && typeof detail === 'object' && Number.isSafeInteger((detail as { total?: unknown }).total)) metadata.total = (detail as { total: number }).total;
        this.db.prepare('UPDATE agent_jobs SET metadata=?,updated_at=? WHERE id=?').run(JSON.stringify(metadata), Date.now(), row.task_id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  publication(operation: WikiOperation, summary: NativeWikiPublicationSummary): void {
    if (!summary || !operation.id || !Number.isSafeInteger(operation.revision) || operation.revision < 0 || operation.publicationId !== summary?.id || !summary.coverage || !Number.isSafeInteger(summary.coverage.published) || summary.coverage.published < 0 || !Number.isSafeInteger(summary.coverage.readable) || summary.coverage.readable < 0 || typeof summary.coverage.partial !== 'boolean' || !Array.isArray(summary.coverage.failed) || summary.coverage.failed.length > 10000 || summary.coverage.failed.some(id => typeof id !== 'string' || !id || id.length > 200) || !['pending', 'ready', 'conflict', 'error'].includes(summary.projection?.status)) throw new Error('NATIVE_PUBLICATION_MISMATCH');
    this.apply(operation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT task_id,revision FROM native_wiki_projection WHERE operation_id=?').get(operation.id) as { task_id: string; revision: number } | undefined;
      if (!row) throw new Error('NATIVE_PROJECTION_NOT_READY');
      if (operation.revision >= row.revision) {
        const job = this.db.prepare('SELECT metadata,updated_at FROM agent_jobs WHERE id=?').get(row.task_id) as { metadata: string; updated_at: number };
        const metadata = JSON.parse(job.metadata);
        const previous = metadata.nativeWiki as NativeWikiTaskSummary | undefined;
        if (previous?.publication && previous.publication.id !== summary.id) throw new Error('NATIVE_PUBLICATION_MISMATCH');
        const safeSummary: NativeWikiPublicationSummary = { id: summary.id, coverage: { published: summary.coverage.published, readable: summary.coverage.readable, failed: [...summary.coverage.failed], partial: summary.coverage.partial }, projection: { status: summary.projection.status, ...(summary.projection.error && /^[A-Z][A-Z0-9_]{0,99}$/.test(summary.projection.error) ? { error: summary.projection.error } : {}) } };
        const nativeWiki: NativeWikiTaskSummary = { engine: 'qoder-wiki-local-v1', operationId: operation.id, revision: operation.revision, publication: safeSummary };
        if (JSON.stringify(previous) !== JSON.stringify(nativeWiki)) {
          metadata.nativeWiki = nativeWiki;
          this.db.prepare('UPDATE agent_jobs SET metadata=?,updated_at=? WHERE id=?').run(JSON.stringify(metadata), Math.max(Date.now(), job.updated_at + 1), row.task_id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(operation: WikiOperation): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT scope,task_id,lease_id FROM native_wiki_projection WHERE operation_id=?').get(operation.id) as { scope: string; task_id: string; lease_id: string | null } | undefined;
      if (row?.lease_id) {
        const changed = this.db.prepare("UPDATE agent_job_leases SET expires_at=0,pinned=0 WHERE scope=? AND task_id=? AND owner_id=? AND ledger_id='native'").run(row.scope, row.task_id, row.lease_id);
        if (Number(changed.changes) !== 1) throw new Error('NATIVE_LEASE_MISMATCH');
        this.db.prepare('UPDATE native_wiki_projection SET lease_id=NULL WHERE operation_id=?').run(operation.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  apply(operation: WikiOperation): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let row = this.db.prepare('SELECT task_id,revision FROM native_wiki_projection WHERE operation_id=?').get(operation.id) as { task_id: string; revision: number } | undefined;
      if (!row) {
        const taskId = `native:${operation.id}`, now = Date.now();
        const metadata = { target: { type: 'repoWiki', id: operation.repositoryRoot, language: operation.locale }, stage: '准备中' };
        this.db.prepare("INSERT INTO agent_jobs(id,kind,workspace,state,progress,error,created_at,updated_at,metadata) VALUES(?,?,?,'pending',0,NULL,?,?,?)").run(taskId, 'repoWiki.native', operation.repositoryRoot, now, now, JSON.stringify(metadata));
        this.db.prepare("INSERT INTO native_wiki_projection(operation_id,task_id,scope,revision) VALUES(?,?,'',-1)").run(operation.id, taskId);
        row = { task_id: taskId, revision: -1 };
      }
      if (operation.revision > row.revision) {
        const state = operation.state === 'queued' ? 'pending' : operation.state === 'pausing' || operation.state === 'cancelling' ? 'running' : operation.state;
        const job = this.db.prepare('SELECT metadata FROM agent_jobs WHERE id=?').get(row.task_id) as { metadata: string };
        const metadata = JSON.parse(job.metadata);
        const previous = metadata.nativeWiki as NativeWikiTaskSummary | undefined;
        metadata.nativeWiki = { engine: 'qoder-wiki-local-v1', operationId: operation.id, revision: operation.revision, ...(previous?.publication && previous.publication.id === operation.publicationId ? { publication: previous.publication } : {}) };
        this.db.prepare('UPDATE agent_jobs SET state=?,error=?,metadata=?,updated_at=? WHERE id=?').run(state, operation.error ?? null, JSON.stringify(metadata), Date.now(), row.task_id);
        this.db.prepare('UPDATE native_wiki_projection SET revision=? WHERE operation_id=? AND revision<?').run(operation.revision, operation.id, operation.revision);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
