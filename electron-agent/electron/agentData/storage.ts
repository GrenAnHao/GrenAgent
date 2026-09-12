import { DatabaseSync } from 'node:sqlite';

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
    if (this.schemaVersion() < 4) this.db.prepare('UPDATE schema_version SET version = ?').run(4);
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    return row?.version ?? 0;
  }

  close(): void { this.db.close(); }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
