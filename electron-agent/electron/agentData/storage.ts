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
    );`);
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
    return row?.version ?? 0;
  }

  close(): void { this.db.close(); }
}
