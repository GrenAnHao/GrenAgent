import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface MemoryScope { userId: string; workspace: string; sessionId?: string }
export interface MemoryRecord { id: string; level: 0 | 1 | 2 | 3; content: string; source?: string; createdAt: number; updatedAt: number }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT,
      level INTEGER NOT NULL, content TEXT NOT NULL, source TEXT, fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, workspace, session_id, level, fingerprint)
    ); CREATE INDEX IF NOT EXISTS memories_scope ON memories(user_id, workspace, session_id, level);
    CREATE TABLE IF NOT EXISTS memory_captures (
      capture_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT,
      source TEXT NOT NULL, transcript TEXT NOT NULL, fingerprint TEXT NOT NULL, pending TEXT,
      updated_at INTEGER NOT NULL, UNIQUE(user_id, workspace, session_id, source)
    );`);
  }

  capture(scope: MemoryScope, source: string, transcript: string, fingerprint: string): { changed: boolean; delta: string; fingerprint: string } {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    const row = this.db.prepare('SELECT transcript, fingerprint, pending FROM memory_captures WHERE capture_key=?').get(captureKey) as { transcript?: string; fingerprint?: string; pending?: string | null } | undefined;
    if (row?.fingerprint === fingerprint && row.pending == null) return { changed: false, delta: '', fingerprint };
    const delta = row?.fingerprint === fingerprint && row.pending != null
      ? row.pending
      : row && transcript.startsWith(row.transcript) ? transcript.slice(row.transcript.length).replace(/^\n+/, '') : transcript;
    if (delta) this.upsert(scope, { level: 0, content: delta, source });
    const now = Date.now();
    this.db.prepare(`INSERT INTO memory_captures(capture_key,user_id,workspace,session_id,source,transcript,fingerprint,pending,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_key) DO UPDATE SET transcript=excluded.transcript, fingerprint=excluded.fingerprint, pending=excluded.pending, updated_at=excluded.updated_at`).run(
      captureKey, scope.userId, scope.workspace, scope.sessionId ?? null, source, transcript, fingerprint, delta || null, now,
    );
    return { changed: Boolean(delta), delta, fingerprint };
  }

  commitCapture(scope: MemoryScope, source: string, fingerprint: string): void {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    this.db.prepare('UPDATE memory_captures SET pending=NULL, updated_at=? WHERE capture_key=? AND fingerprint=?').run(Date.now(), captureKey, fingerprint);
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

  overview(scope: MemoryScope): MemoryOverview {
    const rows = this.db.prepare(`SELECT level, count(*) as count FROM memories
      WHERE user_id=? AND workspace=? AND (? IS NULL OR session_id=?) GROUP BY level`).all(
      scope.userId, scope.workspace, scope.sessionId ?? null, scope.sessionId ?? null,
    ) as Array<{ level: number; count: number }>;
    const byLevel: MemoryOverview['byLevel'] = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const row of rows) {
      if (row.level >= 0 && row.level <= 3) byLevel[`L${row.level}` as keyof typeof byLevel] = Number(row.count);
    }
    return { total: Object.values(byLevel).reduce((sum, count) => sum + count, 0), byLevel };
  }

  remove(scope: MemoryScope, id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=? AND workspace=?').run(id, scope.userId, scope.workspace);
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
