import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface MemoryScope { userId: string; workspace: string; projectId?: string; sessionId?: string; scope?: 'global' | 'project'; includeOtherProjects?: boolean }
export interface MemoryRecord { id: string; level: 0 | 1 | 2 | 3; content: string; source?: string; sourceProjectId?: string; scope?: 'global' | 'project'; createdAt: number; updatedAt: number }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, project_id TEXT, memory_scope TEXT NOT NULL DEFAULT 'project', session_id TEXT,
      level INTEGER NOT NULL, content TEXT NOT NULL, source TEXT, fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, workspace, session_id, level, fingerprint)
    ); CREATE INDEX IF NOT EXISTS memories_scope ON memories(user_id, workspace, session_id, level);
    CREATE TABLE IF NOT EXISTS memory_captures (
      capture_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace TEXT NOT NULL, project_id TEXT, session_id TEXT,
      source TEXT NOT NULL, transcript TEXT NOT NULL, fingerprint TEXT NOT NULL, pending TEXT,
      updated_at INTEGER NOT NULL, UNIQUE(user_id, workspace, session_id, source)
    );`);
    this.ensureColumn('memories', 'project_id', 'TEXT');
    this.ensureColumn('memories', 'memory_scope', "TEXT NOT NULL DEFAULT 'project'");
    this.ensureColumn('memory_captures', 'project_id', 'TEXT');
    // project_id 是后加列，老数据落地为 NULL。search()/overview() 按
    // `memory_scope='global' OR project_id=? OR (...)` 过滤，project_id 为 NULL 时三个条件都
    // 不成立（SQL 里 NULL 不等于任何值），导致这些记录永久搜不到、总数统计也不含它们。
    // 不能只在“刚新增该列”时回填一次：加列本身也曾用 ensureColumn 静默发生过（列已存在于
    // 老数据库里，值仍是 NULL），错过了那次窗口。改为每次打开都无条件跑这条幂等 UPDATE——
    // 健康数据库里 `project_id IS NULL` 天然匹配 0 行，是零开销的自愈检查。
    // 回填规则对齐写入时的 projectId(scope) = scope.projectId ?? scope.workspace。
    this.db.exec("UPDATE memories SET project_id = workspace WHERE project_id IS NULL AND memory_scope != 'global'");
  }

  capture(scope: MemoryScope, source: string, transcript: string, fingerprint: string): { changed: boolean; delta: string; fingerprint: string } {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    const row = this.db.prepare('SELECT transcript, fingerprint, pending FROM memory_captures WHERE capture_key=?').get(captureKey) as { transcript?: string; fingerprint?: string; pending?: string | null } | undefined;
    if (row?.fingerprint === fingerprint && row.pending == null) return { changed: false, delta: '', fingerprint };
    const delta = row?.fingerprint === fingerprint && row.pending != null
      ? row.pending
      : row && transcript.startsWith(row.transcript) ? transcript.slice(row.transcript.length).replace(/^\n+/, '') : transcript;
    const now = Date.now();
    this.db.prepare(`INSERT INTO memory_captures(capture_key,user_id,workspace,project_id,session_id,source,transcript,fingerprint,pending,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_key) DO UPDATE SET transcript=excluded.transcript, fingerprint=excluded.fingerprint, pending=excluded.pending, updated_at=excluded.updated_at`).run(
      captureKey, scope.userId, scope.workspace, projectId(scope), scope.sessionId ?? null, source, transcript, fingerprint, delta || null, now,
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
    const project = projectId(scope);
    const memoryScope = scope.scope ?? 'project';
    const id = input.id ?? hash(`${scope.userId}:${project}:${memoryScope}:${scope.sessionId ?? ''}:${fingerprint}`);
    this.db.prepare(`INSERT INTO memories(id,user_id,workspace,project_id,memory_scope,session_id,level,content,source,fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, source=excluded.source, updated_at=excluded.updated_at`).run(
      id, scope.userId, scope.workspace, project, memoryScope, scope.sessionId ?? null, input.level, content, input.source ?? null, fingerprint, now, now,
    );
    const row = this.db.prepare('SELECT id, level, content, source, project_id as sourceProjectId, memory_scope as scope, created_at as createdAt, updated_at as updatedAt FROM memories WHERE id=?').get(id) as Record<string, unknown>;
    return this.mapRecord(row);
  }

  search(scope: MemoryScope, query: string, limit = 20): MemoryRecord[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const project = projectId(scope);
    const rows = this.db.prepare(`SELECT id,level,content,source,project_id as sourceProjectId,memory_scope as scope,created_at as createdAt,updated_at as updatedAt FROM memories
      WHERE user_id=? AND lower(content) LIKE ?
        AND (memory_scope='global' OR project_id=? OR (? = 1 AND project_id IS NOT NULL))
      ORDER BY updated_at DESC LIMIT ?`).all(
      scope.userId, `%${q}%`, project, scope.includeOtherProjects ? 1 : 0, Math.max(1, Math.min(limit, 100)),
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRecord(row));
  }

  overview(scope: MemoryScope): MemoryOverview {
    const rows = this.db.prepare(`SELECT level, count(*) as count FROM memories
      WHERE user_id=? AND (memory_scope='global' OR project_id=? OR (? = 1 AND project_id IS NOT NULL)) GROUP BY level`).all(
      scope.userId, projectId(scope), scope.includeOtherProjects ? 1 : 0,
    ) as Array<{ level: number; count: number }>;
    const byLevel: MemoryOverview['byLevel'] = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const row of rows) {
      if (row.level >= 0 && row.level <= 3) byLevel[`L${row.level}` as keyof typeof byLevel] = Number(row.count);
    }
    return { total: Object.values(byLevel).reduce((sum, count) => sum + count, 0), byLevel };
  }

  remove(scope: MemoryScope, id: string): void {
    // id 已经是 hash(userId:project:memoryScope:session:fingerprint)，配合 user_id 足以判权。
    // 不再约束 workspace：全局视图会列出其它项目的记录，带 workspace 条件会导致删除静默失败。
    this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(id, scope.userId);
  }

  private mapRecord(row: Record<string, unknown>): MemoryRecord {
    return { id: String(row.id), level: Number(row.level) as MemoryRecord['level'], content: String(row.content), source: row.source == null ? undefined : String(row.source), sourceProjectId: row.sourceProjectId == null || row.scope === 'global' ? undefined : String(row.sourceProjectId), scope: row.scope === 'global' ? 'global' : 'project', createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
function projectId(scope: MemoryScope): string { return scope.projectId ?? scope.workspace; }
