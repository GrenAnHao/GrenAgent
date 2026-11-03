import { DatabaseSync } from 'node:sqlite';

import { migrateKnowledgeKernel } from './knowledgeKernel/store';
export class AgentDataStorage {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 1000');
  }

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`);
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    if (!row) this.db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(1);
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace TEXT NOT NULL, title TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      status TEXT NOT NULL, mode TEXT NOT NULL, input TEXT NOT NULL, permission_profile TEXT NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, type TEXT NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_events (
      id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, type TEXT NOT NULL, timestamp INTEGER NOT NULL,
      project_id TEXT, thread_id TEXT, turn_id TEXT, item_id TEXT, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_events_sequence_idx ON app_events(sequence);
    CREATE TABLE IF NOT EXISTS service_tasks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_project_id TEXT, source_session_id TEXT, source_thread_id TEXT, is_system INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, attempts INTEGER NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_state (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`);
    this.ensureColumn('service_tasks', 'source_thread_id', 'TEXT');
    this.ensureColumn('service_tasks', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
    // 模型用量：同一任务各次 attempt 累加，NULL 表示从未拿到过用量（旧行或未走模型）。
    this.ensureColumn('service_tasks', 'input_tokens', 'INTEGER');
    this.ensureColumn('service_tasks', 'output_tokens', 'INTEGER');
    this.ensureColumn('service_tasks', 'cache_read_tokens', 'INTEGER');
    this.ensureColumn('service_tasks', 'cache_write_tokens', 'INTEGER');
    this.ensureColumn('service_tasks', 'model', 'TEXT');
    // 最近一次失败 attempt 的模型原文（截断），成功时清空。解析失败后原文否则无处可查。
    this.ensureColumn('service_tasks', 'raw_output', 'TEXT');
    // 任务视图的覆盖索引：这些列有一半排在巨大的 input 之后，扫表读它们要走完整条溢出页链。见 TaskViewStore.union。
    this.db.exec('CREATE INDEX IF NOT EXISTS service_tasks_task_view ON service_tasks(updated_at, id, kind, status, source_project_id, attempts, created_at, error)');
    this.ensureColumn('threads', 'session_id', 'TEXT');
    this.ensureColumn('turns', 'session_id', 'TEXT');
    this.db.exec(`DROP TABLE IF EXISTS goal_turn_leases; DROP TABLE IF EXISTS goal_events; DROP TABLE IF EXISTS goal_snapshots;`);
    // 工具授权：tool_audit 的 thread_id 与 turn_id 当前恒为 NULL，留给后续阶段填充。
    this.db.exec(`CREATE TABLE IF NOT EXISTS permission_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      matcher_kind TEXT NOT NULL,
      matcher TEXT NOT NULL DEFAULT '',
      effect TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS permission_rules_lookup ON permission_rules(scope, scope_key, tool);
    CREATE TABLE IF NOT EXISTS tool_audit (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      session_id TEXT, thread_id TEXT, turn_id TEXT, tool_call_id TEXT,
      origin TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      decision TEXT NOT NULL,
      resolution TEXT NOT NULL,
      rule_id TEXT,
      queue_payload TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tool_audit_session ON tool_audit(session_id, created_at);
    CREATE INDEX IF NOT EXISTS tool_audit_pending ON tool_audit(resolution, created_at) WHERE resolution = 'queued';`);
    this.removeRetiredMemory();
    migrateKnowledgeKernel(this.db);
    if (this.schemaVersion() < 7) this.db.prepare('UPDATE schema_version SET version = ?').run(7);
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    return row?.version ?? 0;
  }

  close(): void { this.db.close(); }

  private removeRetiredMemory(): void {
    const legacyTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories','memory_captures','memory_layer_schedules')").all();
    this.db.exec('BEGIN IMMEDIATE');
    let removedRows = 0;
    try {
      this.db.exec('DROP TABLE IF EXISTS memories; DROP TABLE IF EXISTS memory_captures; DROP TABLE IF EXISTS memory_layer_schedules;');
      removedRows += Number(this.db.prepare("DELETE FROM service_tasks WHERE kind GLOB 'memory_*'").run().changes);
      removedRows += Number(this.db.prepare("DELETE FROM plugin_state WHERE id='memory'").run().changes);
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((table) => table.name));
      const jobMetadata = tables.has('agent_jobs') && this.db.prepare('PRAGMA table_info(agent_jobs)').all().some((column) => column.name === 'metadata');
      const retiredJob = "kind GLOB 'memory_*'" + (jobMetadata ? " OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.target.type')='memory'" : '');
      if (tables.has('agent_config')) removedRows += Number(this.db.prepare("DELETE FROM agent_config WHERE module='memory'").run().changes);
      if (tables.has('agent_audit')) {
        const detail = "CASE WHEN json_valid(detail) THEN detail ELSE '{}' END";
        const memoryJob = tables.has('agent_jobs') ? `OR (action GLOB 'job.*' AND json_extract(${detail},'$.id') IN (SELECT id FROM agent_jobs WHERE ${retiredJob}))` : '';
        removedRows += Number(this.db.prepare(`DELETE FROM agent_audit WHERE action GLOB 'memory.*'
          OR (action='config.update' AND json_extract(${detail},'$.module')='memory')
          OR json_extract(${detail},'$.kind') GLOB 'memory_*'
          OR json_extract(${detail},'$.resource.type')='memory'
          OR json_extract(${detail},'$.target.type')='memory'
          OR json_extract(${detail},'$.metadata.resource.type')='memory'
          OR json_extract(${detail},'$.metadata.target.type')='memory' ${memoryJob}`).run().changes);
      }
      if (tables.has('agent_jobs')) removedRows += Number(this.db.prepare(`DELETE FROM agent_jobs WHERE ${retiredJob}`).run().changes);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Dropping captured transcripts otherwise leaves their pages in the shared file.
    if (legacyTables.length || removedRows) {
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
