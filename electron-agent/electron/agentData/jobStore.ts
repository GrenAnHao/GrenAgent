import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JobMetadata } from './operationsContracts';
export type { JobMetadata } from './operationsContracts';

export type JobState = 'pending' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export interface Job { id: string; kind: string; workspace: string; state: JobState; progress: number; error?: string; metadata?: JobMetadata; createdAt: number; updatedAt: number }
export interface ConfigValue { version: number; value: Record<string, unknown> }

export class JobStore {
  /**
   * 表名可调：KnowledgeKernel 在自己的库里用 `knowledge_tasks`，不再创建 `agent_jobs`。
   * 默认值保持 `agent_jobs`，供仍在使用共享库的调用方与迁移读取。
   */
  private readonly table: string;
  constructor(private readonly db: DatabaseSync, options: { table?: string; createTables?: boolean } = {}) {
    this.table = options.table ?? 'agent_jobs';
    // 默认建表（Kernel 与测试需要）；共享库已清理时由运行时传 createTables: false，避免把表建回来。
    if (options.createTables === false) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_config (module TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    const columns = this.db.prepare(`PRAGMA table_info(${this.table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'metadata')) this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN metadata TEXT`);
  }
  create(input: { kind: string; workspace: string; metadata?: JobMetadata }): Job { const now = Date.now(); const id = randomUUID(); this.db.prepare(`INSERT INTO ${this.table}(id,kind,workspace,state,progress,error,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.kind, input.workspace, 'pending', 0, null, now, now, input.metadata ? JSON.stringify(input.metadata) : null); this.record('job.create', { id, ...input }); return this.get(id)!; }
  get(id: string): Job | undefined { const row = this.db.prepare(`SELECT id,kind,workspace,state,progress,error,metadata,created_at as createdAt,updated_at as updatedAt FROM ${this.table} WHERE id=?`).get(id) as Record<string, unknown> | undefined; return row ? this.mapJob(row) : undefined; }
  list(state?: JobState): Job[] {
    const rows = state === undefined
      ? this.db.prepare(`SELECT id,kind,workspace,state,progress,error,metadata,created_at as createdAt,updated_at as updatedAt FROM ${this.table} ORDER BY updated_at DESC`).all()
      : this.db.prepare(`SELECT id,kind,workspace,state,progress,error,metadata,created_at as createdAt,updated_at as updatedAt FROM ${this.table} WHERE state=? ORDER BY updated_at DESC`).all(state);
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapJob(row));
  }
  cancel(id: string): Job | undefined { const job = this.get(id); if (!job) return undefined; this.db.prepare(`UPDATE ${this.table} SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','running')`).run(Date.now(), id); this.record('job.cancel', { id, ...jobSnapshot(job) }); return this.get(id); }
  remove(id: string): { deleted: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(id);
      if (job && ['pending', 'running', 'paused', 'blocked'].includes(job.state)) throw new Error('JOB_ACTIVE');
      this.assertUnreferenced(id);
      const result = this.db.prepare(`DELETE FROM ${this.table} WHERE id=? AND state IN ('completed','failed','cancelled')`).run(id);
      const deleted = Number(result.changes) > 0;
      if (deleted) this.record('job.remove', { id, ...jobSnapshot(job) });
      this.db.exec('COMMIT');
      return { deleted };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  clear(ids: string[]): { deletedIds: string[] } {
    const deletedIds: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare(`DELETE FROM ${this.table} WHERE id=? AND state IN ('completed','failed','cancelled')`);
      for (const id of new Set(ids)) {
        const job = this.get(id);
        if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) this.assertUnreferenced(id);
        if (Number(remove.run(id).changes) > 0) {
          deletedIds.push(id);
          this.record('job.remove', { id, ...jobSnapshot(job) });
        }
      }
      if (deletedIds.length) this.record('job.clear', { ids: deletedIds });
      this.db.exec('COMMIT');
      return { deletedIds };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** pending → running。已取消/已结束的 job 不再推进，原样返回。 */
  start(id: string): Job | undefined {
    this.db.prepare(`UPDATE ${this.table} SET state='running',updated_at=? WHERE id=? AND state='pending'`).run(Date.now(), id);
    return this.get(id);
  }

  updateMetadata(id: string, patch: Partial<JobMetadata>): Job | undefined {
    return this.mutateMetadata(id, patch);
  }

  requestCancellation(id: string): Job | undefined {
    return this.mutateMetadata(id, { cancellationRequested: true, cancellationError: undefined }, 'job.cancel_requested');
  }

  recordStage(id: string, stage: string, counts?: { processed: number; total: number }): Job | undefined {
    if (!stage.trim() || stage.length > 120) throw new Error('INVALID_JOB_STAGE');
    if (counts && (!Number.isSafeInteger(counts.processed) || !Number.isSafeInteger(counts.total) || counts.processed < 0 || counts.total < counts.processed)) throw new Error('INVALID_JOB_COUNTS');
    return this.mutateMetadata(id, { stage, ...counts }, 'job.stage');
  }

  private mutateMetadata(id: string, patch: Partial<JobMetadata>, action?: string): Job | undefined {
    let nested = false;
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('within a transaction')) throw error;
      nested = true; this.db.exec('SAVEPOINT job_metadata');
    }
    try {
      const job = this.get(id);
      if (job && (job.state === 'pending' || job.state === 'running')) {
        const metadata = { ...job.metadata, ...patch };
        if (JSON.stringify(metadata) !== JSON.stringify(job.metadata)) {
          const result = this.db.prepare(`UPDATE ${this.table} SET metadata=?,updated_at=? WHERE id=? AND state IN ('pending','running')`).run(JSON.stringify(metadata), Date.now(), id);
          if (Number(result.changes) && action) this.record(action, { id, resource: metadata.target, resourceName: metadata.resourceName,
            ...(action === 'job.stage' ? { stage: metadata.stage, processed: metadata.processed, total: metadata.total } : {}) });
        }
      }
      this.db.exec(nested ? 'RELEASE SAVEPOINT job_metadata' : 'COMMIT');
      return this.get(id);
    } catch (error) {
      this.db.exec(nested ? 'ROLLBACK TO SAVEPOINT job_metadata' : 'ROLLBACK');
      if (nested) this.db.exec('RELEASE SAVEPOINT job_metadata');
      throw error;
    }
  }

  /** 更新进度（clamp 到 0..100）。仅对 running 生效，避免给已取消的 job 写进度。 */
  progress(id: string, value: number): Job | undefined {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    this.db.prepare(`UPDATE ${this.table} SET progress=?,updated_at=? WHERE id=? AND state='running'`).run(clamped, Date.now(), id);
    return this.get(id);
  }

  complete(id: string): Job | undefined {
    this.db.prepare(`UPDATE ${this.table} SET state='completed',progress=100,updated_at=? WHERE id=? AND state IN ('pending','running')`).run(Date.now(), id);
    this.record('job.complete', { id, ...jobSnapshot(this.get(id)) });
    return this.get(id);
  }

  fail(id: string, error: string): Job | undefined {
    this.db.prepare(`UPDATE ${this.table} SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('pending','running')`).run(error.slice(0, 2000), Date.now(), id);
    this.record('job.fail', { id, ...jobSnapshot(this.get(id)), error: error.slice(0, 200) });
    return this.get(id);
  }

  /**
   * 自动同步熔断后留一条失败的 codegraph.sync，任务中心能看见、能重试。
   * 直接写成 failed，不经过 create：create 出来的 pending 会被执行器马上跑起来。
   * 同一工作区已有未结束的同步任务时不另建；已有熔断失败则刷新错误。
   */
  recordBreaker(workspace: string, error: string): Job {
    const message = error.slice(0, 2000);
    const now = Date.now();
    const same = this.list().filter((job) => job.kind === 'codegraph.sync' && job.workspace === workspace);
    const active = same.find((job) => job.state === 'pending' || job.state === 'running');
    if (active) return active;
    const previous = same.find((job) => job.metadata?.origin === 'breaker' && job.state === 'failed');
    if (previous) {
      this.db.prepare(`UPDATE ${this.table} SET error=?,updated_at=? WHERE id=?`).run(message, now, previous.id);
      this.record('job.breaker', { id: previous.id, workspace });
      return this.get(previous.id)!;
    }
    const id = randomUUID();
    const metadata: JobMetadata = { target: { type: 'project', id: workspace }, resourceName: workspace, origin: 'breaker' };
    this.db.prepare(`INSERT INTO ${this.table}(id,kind,workspace,state,progress,error,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, 'codegraph.sync', workspace, 'failed', 0, message, now, now, JSON.stringify(metadata));
    this.record('job.breaker', { id, workspace, error: message.slice(0, 200) });
    return this.get(id)!;
  }

  /** 该 workspace 是否已有同 kind 的未结束 job（供并发拒绝）。 */
  hasActive(kind: string, workspace: string): boolean {
    const row = this.db.prepare(`SELECT count(*) as count FROM ${this.table} WHERE kind=? AND workspace=? AND state IN ('pending','running')`).get(kind, workspace) as { count: number };
    return Number(row.count) > 0;
  }
  updateConfig(module: string, value: Record<string, unknown>, expectedVersion: number): ConfigValue { const current = this.config(module); if (current.version !== expectedVersion) throw new Error('VERSION_CONFLICT'); const next = current.version + 1; this.db.prepare('INSERT INTO agent_config(module,version,value) VALUES(?,?,?) ON CONFLICT(module) DO UPDATE SET version=excluded.version,value=excluded.value').run(module, next, JSON.stringify(value)); this.record('config.update', { module, version: next }); return { version: next, value }; }
  config(module: string): ConfigValue { const row = this.db.prepare('SELECT version,value FROM agent_config WHERE module=?').get(module) as { version?: number; value?: string } | undefined; return row ? { version: Number(row.version), value: JSON.parse(row.value!) as Record<string, unknown> } : { version: 0, value: {} }; }
  audit(limit = 100): Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: number }> { return (this.db.prepare('SELECT id,action,detail,created_at as createdAt FROM agent_audit ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), action: String(r.action), detail: JSON.parse(String(r.detail)) as Record<string, unknown>, createdAt: Number(r.createdAt) })); }
  diagnostics(): { jobs: { total: number; failed: number }; auditEvents: number } { const jobs = this.db.prepare(`SELECT count(*) as total, sum(state='failed') as failed FROM ${this.table}`).get() as { total: number; failed: number }; const audit = this.db.prepare('SELECT count(*) as count FROM agent_audit').get() as { count: number }; return { jobs: { total: Number(jobs.total), failed: Number(jobs.failed ?? 0) }, auditEvents: Number(audit.count) }; }
  exportData(): { jobs: Job[]; configs: Record<string, ConfigValue>; audit: ReturnType<JobStore['audit']> } { const configs: Record<string, ConfigValue> = {}; for (const row of this.db.prepare("SELECT module FROM agent_config WHERE module != 'memory'").all() as Array<{ module: string }>) configs[row.module] = this.config(row.module); return { jobs: this.list(), configs, audit: this.audit(500) }; }
  importData(data: { configs?: Record<string, ConfigValue> }): void { this.db.exec('BEGIN'); try { for (const [module, config] of Object.entries(data.configs ?? {}).filter(([name]) => name !== 'memory')) this.db.prepare('INSERT INTO agent_config(module,version,value) VALUES(?,?,?) ON CONFLICT(module) DO UPDATE SET version=excluded.version,value=excluded.value').run(module, config.version, JSON.stringify(config.value)); this.db.exec('COMMIT'); this.record('data.import', { modules: Object.keys(data.configs ?? {}).length }); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private assertUnreferenced(id: string): void {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_wiki_projection'").get() && this.db.prepare('SELECT 1 FROM native_wiki_projection WHERE task_id=? LIMIT 1').get(id)) throw new Error('JOB_REFERENCED');
    if (this.db.prepare(`SELECT 1 FROM ${this.table} WHERE json_valid(metadata) AND json_extract(metadata,'$.retryOf')=? LIMIT 1`).get(id)) throw new Error('JOB_REFERENCED');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_build_items'").get() && this.db.prepare('SELECT 1 FROM knowledge_build_items WHERE source_task_id=? LIMIT 1').get(id)) throw new Error('JOB_REFERENCED');
  }
  private record(action: string, detail: Record<string, unknown>): void { this.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(randomUUID(), action, JSON.stringify(detail), Date.now()); }
  private mapJob(row: Record<string, unknown>): Job { return { id: String(row.id), kind: String(row.kind), workspace: String(row.workspace), state: String(row.state) as JobState, progress: Number(row.progress), error: row.error == null ? undefined : String(row.error), metadata: parseJobMetadata(row.metadata), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }; }
}

function jobSnapshot(job: Job | undefined): Pick<JobMetadata, 'resourceName'> & { resource?: JobMetadata['target'] } {
  return { resource: job?.metadata?.target, resourceName: job?.metadata?.resourceName };
}

/** Persisted metadata is optional; one damaged historical row must not break all task readers. */
export function parseJobMetadata(value: unknown): JobMetadata | undefined {
  if (value == null) return undefined;
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>; const metadata: JobMetadata = {};
    if (row.target && typeof row.target === 'object') {
      const target = row.target as Record<string, unknown>;
      if (['wiki', 'project'].includes(String(target.type)) && typeof target.id === 'string' && target.id) metadata.target = {
        type: target.type as NonNullable<JobMetadata['target']>['type'], id: target.id,
      };
    }
    if (row.payload && typeof row.payload === 'object') {
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload.kbId === 'string' && Array.isArray(payload.sourceIds) && payload.sourceIds.every((id) => typeof id === 'string')) metadata.payload = { kbId: payload.kbId, sourceIds: [...payload.sourceIds] };
      else if (typeof payload.workspace === 'string') metadata.payload = { workspace: payload.workspace };
    }
    for (const field of ['retryOf', 'resourceName', 'cancellationError', 'stage'] as const) if (typeof row[field] === 'string') metadata[field] = row[field];
    if (typeof row.message === 'string' && row.message.length <= 1000) metadata.message = row.message;
    if (typeof row.currentPage === 'string' && row.currentPage.length <= 500) metadata.currentPage = row.currentPage;
    if (row.origin === 'breaker') metadata.origin = 'breaker';
    if (typeof row.cancellationRequested === 'boolean') metadata.cancellationRequested = row.cancellationRequested;
    for (const field of ['processed', 'total'] as const) if (Number.isSafeInteger(row[field]) && Number(row[field]) >= 0) metadata[field] = Number(row[field]);
    return metadata;
  } catch { return undefined; }
}
