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
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_project_id TEXT, source_session_id TEXT,
      status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, attempts INTEGER NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugin_state (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`);
    if (this.schemaVersion() < 2) this.db.prepare('UPDATE schema_version SET version = ?').run(2);
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    return row?.version ?? 0;
  }

  close(): void { this.db.close(); }
}
