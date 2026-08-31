import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface MemoryScope { userId: string; workspace: string; sessionId?: string }
export interface MemoryRecord { id: string; level: 0 | 1 | 2 | 3; content: string; source?: string; createdAt: number; updatedAt: number }

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT,
      level INTEGER NOT NULL, content TEXT NOT NULL, source TEXT, fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, workspace, session_id, level, fingerprint)
    ); CREATE INDEX IF NOT EXISTS memories_scope ON memories(user_id, workspace, session_id, level);`);
  }

  upsert(scope: MemoryScope, input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): MemoryRecord {
    const now = Date.now();
    const content = input.content.trim();
    if (!content) throw new Error('memory content is required');
    const fingerprint = hash(`${input.level}:${content}`);
    const id = input.id ?? hash(`${scope.userId}:${scope.workspace}:${scope.sessionId ?? ''}:${fingerprint}`);
    this.db.prepare(`INSERT INTO memories(id,user_id,workspace,session_id,level,content,source,fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, source=excluded.source, updated_at=excluded.updated_at`).run(
      id, scope.userId, scope.workspace, scope.sessionId ?? null, input.level, content, input.source ?? null, fingerprint, now, now,
    );
    const row = this.db.prepare('SELECT id, level, content, source, created_at as createdAt, updated_at as updatedAt FROM memories WHERE id=?').get(id) as Record<string, unknown>;
    return { id: String(row.id), level: Number(row.level) as MemoryRecord['level'], content: String(row.content), source: row.source == null ? undefined : String(row.source), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  search(scope: MemoryScope, query: string, limit = 20): MemoryRecord[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db.prepare(`SELECT id,level,content,source,created_at as createdAt,updated_at as updatedAt FROM memories
      WHERE user_id=? AND workspace=? AND (? IS NULL OR session_id=?) AND lower(content) LIKE ? ORDER BY updated_at DESC LIMIT ?`).all(
      scope.userId, scope.workspace, scope.sessionId ?? null, scope.sessionId ?? null, `%${q}%`, Math.max(1, Math.min(limit, 100)),
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), level: Number(row.level) as MemoryRecord['level'], content: String(row.content), source: row.source == null ? undefined : String(row.source), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }));
  }

  remove(scope: MemoryScope, id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=? AND workspace=?').run(id, scope.userId, scope.workspace);
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
