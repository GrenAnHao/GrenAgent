import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type JobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Job { id: string; kind: string; workspace: string; state: JobState; progress: number; error?: string; createdAt: number; updatedAt: number }
export interface ConfigValue { version: number; value: Record<string, unknown> }

export class JobStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_config (module TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }
  create(input: { kind: string; workspace: string }): Job { const now = Date.now(); const id = randomUUID(); this.db.prepare('INSERT INTO agent_jobs VALUES(?,?,?,?,?,?,?,?)').run(id, input.kind, input.workspace, 'pending', 0, null, now, now); this.record('job.create', { id, ...input }); return this.get(id)!; }
  get(id: string): Job | undefined { const row = this.db.prepare('SELECT id,kind,workspace,state,progress,error,created_at as createdAt,updated_at as updatedAt FROM agent_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined; return row ? this.mapJob(row) : undefined; }
  list(state?: JobState): Job[] {
    const rows = state === undefined
      ? this.db.prepare('SELECT id,kind,workspace,state,progress,error,created_at as createdAt,updated_at as updatedAt FROM agent_jobs ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT id,kind,workspace,state,progress,error,created_at as createdAt,updated_at as updatedAt FROM agent_jobs WHERE state=? ORDER BY updated_at DESC').all(state);
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapJob(row));
  }
  cancel(id: string): Job | undefined { const job = this.get(id); if (!job) return undefined; this.db.prepare("UPDATE agent_jobs SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','running')").run(Date.now(), id); this.record('job.cancel', { id }); return this.get(id); }
  updateConfig(module: string, value: Record<string, unknown>, expectedVersion: number): ConfigValue { const current = this.config(module); if (current.version !== expectedVersion) throw new Error('VERSION_CONFLICT'); const next = current.version + 1; this.db.prepare('INSERT INTO agent_config(module,version,value) VALUES(?,?,?) ON CONFLICT(module) DO UPDATE SET version=excluded.version,value=excluded.value').run(module, next, JSON.stringify(value)); this.record('config.update', { module, version: next }); return { version: next, value }; }
  config(module: string): ConfigValue { const row = this.db.prepare('SELECT version,value FROM agent_config WHERE module=?').get(module) as { version?: number; value?: string } | undefined; return row ? { version: Number(row.version), value: JSON.parse(row.value!) as Record<string, unknown> } : { version: 0, value: {} }; }
  audit(limit = 100): Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: number }> { return (this.db.prepare('SELECT id,action,detail,created_at as createdAt FROM agent_audit ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), action: String(r.action), detail: JSON.parse(String(r.detail)) as Record<string, unknown>, createdAt: Number(r.createdAt) })); }
  diagnostics(): { jobs: { total: number; failed: number }; auditEvents: number } { const jobs = this.db.prepare("SELECT count(*) as total, sum(state='failed') as failed FROM agent_jobs").get() as { total: number; failed: number }; const audit = this.db.prepare('SELECT count(*) as count FROM agent_audit').get() as { count: number }; return { jobs: { total: Number(jobs.total), failed: Number(jobs.failed ?? 0) }, auditEvents: Number(audit.count) }; }
  exportData(): { jobs: Job[]; configs: Record<string, ConfigValue>; audit: ReturnType<JobStore['audit']> } { const configs: Record<string, ConfigValue> = {}; for (const row of this.db.prepare('SELECT module FROM agent_config').all() as Array<{ module: string }>) configs[row.module] = this.config(row.module); return { jobs: this.list(), configs, audit: this.audit(500) }; }
  importData(data: { configs?: Record<string, ConfigValue> }): void { this.db.exec('BEGIN'); try { for (const [module, config] of Object.entries(data.configs ?? {})) this.db.prepare('INSERT INTO agent_config(module,version,value) VALUES(?,?,?) ON CONFLICT(module) DO UPDATE SET version=excluded.version,value=excluded.value').run(module, config.version, JSON.stringify(config.value)); this.db.exec('COMMIT'); this.record('data.import', { modules: Object.keys(data.configs ?? {}).length }); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private record(action: string, detail: Record<string, unknown>): void { this.db.prepare('INSERT INTO agent_audit VALUES(?,?,?,?)').run(randomUUID(), action, JSON.stringify(detail), Date.now()); }
  private mapJob(row: Record<string, unknown>): Job { return { id: String(row.id), kind: String(row.kind), workspace: String(row.workspace), state: String(row.state) as JobState, progress: Number(row.progress), error: row.error == null ? undefined : String(row.error), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }; }
}
