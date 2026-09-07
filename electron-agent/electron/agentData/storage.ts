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
    // Goal ownership is keyed by session_id alone: Pi session ids are UUIDs from
    // the session JSONL header, so they are unique across workspaces. `workspace`
    // stays display/authorization metadata and is deliberately not part of any
    // Goal key or index. See GoalSnapshot in goalContracts.ts.
    this.db.exec(`CREATE TABLE IF NOT EXISTS goal_snapshots (
      goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace TEXT NOT NULL, revision INTEGER NOT NULL,
      condition TEXT NOT NULL, status TEXT NOT NULL, rounds_used INTEGER NOT NULL, max_rounds INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stop_reason TEXT, judge TEXT, blockage TEXT,
      source_goal_id TEXT, source_session_id TEXT, cleared_at TEXT, source TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS goal_snapshots_live_session ON goal_snapshots(session_id) WHERE status <> 'cleared';
    CREATE TABLE IF NOT EXISTS goal_events (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL, published_at TEXT
    );
    DROP INDEX IF EXISTS goal_events_idempotency;
    CREATE UNIQUE INDEX IF NOT EXISTS goal_events_goal_idempotency ON goal_events(goal_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS goal_events_session_created ON goal_events(session_id, created_at, id);
    CREATE TABLE IF NOT EXISTS goal_turn_leases (
      idempotency_key TEXT PRIMARY KEY, goal_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
      next_round INTEGER NOT NULL, status TEXT NOT NULL, turn_id TEXT, workspace TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'system', prompt_digest TEXT NOT NULL DEFAULT '', continuous_intent INTEGER NOT NULL DEFAULT 0,
      summary TEXT, error TEXT, blockage_fingerprint TEXT, blockage_summary TEXT,
      created_at TEXT NOT NULL, claimed_at TEXT, settled_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS goal_turn_leases_round ON goal_turn_leases(goal_id, revision, next_round);
    CREATE INDEX IF NOT EXISTS goal_turn_leases_session ON goal_turn_leases(session_id, status);`);
    for (const [column, definition] of [
      ['workspace', "TEXT NOT NULL DEFAULT ''"], ['origin', "TEXT NOT NULL DEFAULT 'system'"],
      ['prompt_digest', "TEXT NOT NULL DEFAULT ''"], ['continuous_intent', 'INTEGER NOT NULL DEFAULT 0'],
      ['error', 'TEXT'], ['claimed_at', 'TEXT'], ['blockage_fingerprint', 'TEXT'], ['blockage_summary', 'TEXT'],
    ] as const) this.ensureColumn('goal_turn_leases', column, definition);
    this.ensureColumn('goal_snapshots', 'source', 'TEXT');
    if (this.schemaVersion() < 3) this.db.prepare('UPDATE schema_version SET version = ?').run(3);
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
