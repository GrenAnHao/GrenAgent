import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LayerScheduleStore } from '../app/memoryLayerSchedule';
import type { ManagedMemoryRecord, MemoryConversation, MemoryConversationDetail, MemoryCreateInput, MemoryDraft, MemoryFilter, MemoryListInput, MemoryPage, MemoryReadInput, MemoryRecord, MemoryUpdateInput } from './memoryContracts';
import { RpcError } from './protocol';

export type { MemoryRecord } from './memoryContracts';

export interface MemoryScope { userId: string; workspace: string; projectId?: string; sessionId?: string; scope?: 'global' | 'project'; includeOtherProjects?: boolean }
export interface MemoryOverview { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }
export interface ConversationSearchHit { id: string; source: string; sessionId?: string; workspace: string; sourceProjectId: string; snippet: string; updatedAt: number }

const memoryColumns = `id,level,content,source,COALESCE(project_id,workspace) as sourceProjectId,memory_scope as scope,
  session_id as sourceSessionId,workspace as sourceWorkspace,origin,revision,content_hash as contentHash,
  created_at as createdAt,updated_at as updatedAt`;
const conversationColumns = `capture_key as id,source,session_id as sourceSessionId,workspace,
  COALESCE(project_id,workspace) as sourceProjectId,transcript,updated_at as updatedAt`;

export class MemoryStore {
  readonly schedules: LayerScheduleStore;

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
    this.ensureColumn('memories', 'origin', "TEXT NOT NULL DEFAULT 'automatic'");
    this.ensureColumn('memories', 'revision', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('memories', 'content_hash', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('memory_captures', 'project_id', 'TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS memories_browse ON memories(user_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_captures_browse ON memory_captures(user_id,updated_at DESC,capture_key DESC)`);
    const unhashed = this.db.prepare("SELECT id,user_id,level,content FROM memories WHERE content_hash=''").all();
    const backfillHash = this.db.prepare("UPDATE memories SET content_hash=? WHERE user_id=? AND id=? AND content_hash=''");
    for (const row of unhashed) backfillHash.run(hash(`${row.level}:${row.content}`), row.user_id, row.id);
    // project_id 是后加列，老数据落地为 NULL。search()/overview() 按
    // `memory_scope='global' OR project_id=? OR (...)` 过滤，project_id 为 NULL 时三个条件都
    // 不成立（SQL 里 NULL 不等于任何值），导致这些记录永久搜不到、总数统计也不含它们。
    // 不能只在“刚新增该列”时回填一次：加列本身也曾用 ensureColumn 静默发生过（列已存在于
    // 老数据库里，值仍是 NULL），错过了那次窗口。改为每次打开都无条件跑这条幂等 UPDATE——
    // 健康数据库里 `project_id IS NULL` 天然匹配 0 行，是零开销的自愈检查。
    // 回填规则对齐写入时的 projectId(scope) = scope.projectId ?? scope.workspace。
    this.db.exec("UPDATE memories SET project_id = workspace WHERE project_id IS NULL AND memory_scope != 'global'");
    this.schedules = new LayerScheduleStore(this.db);
    this.schedules.ensure();
  }

  list(input: MemoryListInput): MemoryPage<ManagedMemoryRecord> {
    const query = browseQuery(input, 'memory');
    const rows = this.db.prepare(`SELECT ${memoryColumns} FROM memories WHERE ${query.where}
      ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...query.params, query.limit + 1) as Array<Record<string, unknown>>;
    return page(rows.map((row) => this.mapManagedRecord(row)), query.limit, query.filterHash);
  }

  read(input: MemoryReadInput): ManagedMemoryRecord {
    const row = this.db.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id=? AND id=?`).get(input.userId, input.id) as Record<string, unknown> | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'memory not found');
    return this.mapManagedRecord(row);
  }

  listConversations(input: MemoryListInput): MemoryPage<MemoryConversation> {
    const query = browseQuery(input, 'conversation');
    // 列表只展示 1200 字片段。没有搜索词时片段就是开头，在 SQL 里截取，不把整份 transcript（单条可达数百 KB）读进主进程。
    // SQLite 按字符截、JS 按 UTF-16 截，前者只会多不会少，mapConversation 再 slice 一次结果不变。
    const columns = query.query ? conversationColumns : conversationColumns.replace('transcript,', `substr(transcript,1,${SNIPPET_LENGTH}) AS transcript,`);
    const rows = this.db.prepare(`SELECT ${columns} FROM memory_captures WHERE ${query.where}
      ORDER BY updated_at DESC,capture_key DESC LIMIT ?`).all(...query.params, query.limit + 1) as Array<Record<string, unknown>>;
    return page(rows.map((row) => mapConversation(row, query.query)), query.limit, query.filterHash);
  }

  readConversation(input: MemoryReadInput): MemoryConversationDetail {
    const row = this.db.prepare(`SELECT ${conversationColumns} FROM memory_captures WHERE user_id=? AND capture_key=?`).get(input.userId, input.id) as Record<string, unknown> | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'conversation not found');
    return { ...mapConversation(row, ''), transcript: String(row.transcript) };
  }

  create(input: MemoryCreateInput): ManagedMemoryRecord {
    const draft = validateDraft(input.draft);
    if (draft.level === 0) throw new RpcError('INVALID_PARAMS', 'cannot create L0 memory');
    const id = randomUUID();
    const now = Date.now();
    const ownerProject = draft.owner.scope === 'project' ? draft.owner.projectId : null;
    this.db.prepare(`INSERT INTO memories(id,user_id,workspace,project_id,memory_scope,session_id,level,content,source,fingerprint,origin,revision,content_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,NULL,?,?,?,?, 'manual',1,?,?,?)`).run(
      id, input.userId, ownerProject ?? '', ownerProject, draft.owner.scope, draft.level, draft.content, draft.source ?? null,
      `manual:${id}`, hash(`${draft.level}:${draft.content}`), now, now,
    );
    return this.read({ userId: input.userId, id });
  }

  update(input: MemoryUpdateInput): ManagedMemoryRecord {
    return this.transaction(() => {
      const current = this.read(input);
      if (current.revision !== input.expectedRevision) throw new RpcError('VERSION_CONFLICT', 'memory version conflict');
      const draft = validateDraft(input.draft);
      if ((current.level === 0) !== (draft.level === 0)) throw new RpcError('INVALID_PARAMS', 'cannot change L0 memory level');
      const sessionId = draft.source === current.source ? current.sourceSessionId ?? null : null;
      const result = this.db.prepare(`UPDATE memories SET content=?,level=?,source=?,project_id=?,memory_scope=?,session_id=?,
        fingerprint=?,content_hash=?,origin='manual',revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND revision=?`).run(
        draft.content, draft.level, draft.source ?? null, draft.owner.scope === 'project' ? draft.owner.projectId : null, draft.owner.scope,
        sessionId, `manual:${input.id}`, hash(`${draft.level}:${draft.content}`), Date.now(), input.userId, input.id, input.expectedRevision,
      );
      if (Number(result.changes) !== 1) throw new RpcError('VERSION_CONFLICT', 'memory version conflict');
      return this.read(input);
    });
  }

  capture(scope: MemoryScope, source: string, transcript: string, fingerprint: string): { changed: boolean; delta: string; fingerprint: string } {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    const row = this.db.prepare('SELECT transcript, fingerprint, pending FROM memory_captures WHERE capture_key=?').get(captureKey) as { transcript?: string; fingerprint?: string; pending?: string | null } | undefined;
    if (row?.fingerprint === fingerprint && row.pending == null) return { changed: false, delta: '', fingerprint };
    let delta = transcript;
    if (row?.fingerprint === fingerprint && row.pending != null) delta = row.pending;
    else if (row?.transcript && transcript.startsWith(row.transcript)) {
      const suffix = transcript.slice(row.transcript.length).replace(/^\n+/, '');
      delta = [row.pending, suffix].filter(Boolean).join('\n');
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO memory_captures(capture_key,user_id,workspace,project_id,session_id,source,transcript,fingerprint,pending,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_key) DO UPDATE SET transcript=excluded.transcript, fingerprint=excluded.fingerprint, pending=excluded.pending, updated_at=excluded.updated_at`).run(
      captureKey, scope.userId, scope.workspace, projectId(scope), scope.sessionId ?? null, source, transcript, fingerprint, delta || null, now,
    );
    return { changed: Boolean(delta), delta, fingerprint };
  }

  commitCapture(scope: MemoryScope, source: string, fingerprint: string, delta?: string): void {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    const row = this.db.prepare('SELECT fingerprint,pending FROM memory_captures WHERE capture_key=?').get(captureKey) as { fingerprint: string; pending: string | null } | undefined;
    if (!row) return;
    let remaining: string | null = null;
    if (row.fingerprint !== fingerprint) {
      if (!delta || !row.pending?.startsWith(delta)) return;
      remaining = row.pending.slice(delta.length).replace(/^\n+/, '') || null;
    }
    this.db.prepare('UPDATE memory_captures SET pending=?, updated_at=? WHERE capture_key=?').run(remaining, Date.now(), captureKey);
  }

  pendingCapture(scope: MemoryScope, source: string): { transcript: string; fingerprint: string } | undefined {
    const captureKey = hash(`${scope.userId}\0${scope.workspace}\0${scope.sessionId ?? ''}\0${source}`);
    return this.db.prepare('SELECT transcript,fingerprint FROM memory_captures WHERE capture_key=? AND pending IS NOT NULL').get(captureKey) as { transcript: string; fingerprint: string } | undefined;
  }

  /** 启动补抽用：只取来源键，不读 transcript。 */
  listPendingCaptures(): Array<{ userId: string; workspace: string; projectId?: string; sessionId?: string; source: string }> {
    const rows = this.db.prepare(`SELECT user_id,workspace,project_id,session_id,source FROM memory_captures
      WHERE pending IS NOT NULL ORDER BY updated_at ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: String(row.user_id), workspace: String(row.workspace), source: String(row.source),
      ...(row.project_id == null ? {} : { projectId: String(row.project_id) }),
      ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
    }));
  }

  searchConversations(scope: MemoryScope, query: string, limit = 20): ConversationSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 20;
    const rows = this.db.prepare(`SELECT capture_key as id,source,session_id as sessionId,workspace,
      COALESCE(project_id,workspace) as sourceProjectId,transcript,updated_at as updatedAt FROM memory_captures
      WHERE user_id=? AND instr(lower(transcript),?) > 0 AND (COALESCE(project_id,workspace)=? OR ?=1)
      ORDER BY updated_at DESC,capture_key ASC LIMIT ?`).all(scope.userId, q, projectId(scope), scope.includeOtherProjects ? 1 : 0, count) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const transcript = String(row.transcript);
      const start = Math.max(0, transcript.toLowerCase().indexOf(q) - 200);
      return { id: String(row.id), source: String(row.source), sessionId: row.sessionId == null ? undefined : String(row.sessionId), workspace: String(row.workspace), sourceProjectId: String(row.sourceProjectId), snippet: transcript.slice(start, start + 1200), updatedAt: Number(row.updatedAt) };
    });
  }

  upsert(scope: MemoryScope, input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): MemoryRecord {
    const content = input.content.trim();
    if (!content) throw new Error('memory content is required');
    const fingerprint = hash(`${input.level}:${content}`);
    const project = projectId(scope);
    const memoryScope = scope.scope ?? 'project';
    const oldId = hash(`${scope.userId}:${project}:${memoryScope}:${scope.sessionId ?? ''}:${fingerprint}`);
    return this.transaction(() => {
      // The legacy UNIQUE permits duplicate NULL sessions. Locate an existing automatic
      // row first, so retries keep its ID even when earlier IDs became manual records.
      let existing = input.id === undefined ? this.db.prepare(`SELECT * FROM memories WHERE user_id=? AND workspace=? AND session_id IS ?
        AND level=? AND fingerprint=? AND origin='automatic' AND memory_scope=? AND COALESCE(project_id,workspace)=?
        ORDER BY created_at ASC,id ASC LIMIT 1`).get(
        scope.userId, scope.workspace, scope.sessionId ?? null, input.level, fingerprint, memoryScope, project,
      ) as Record<string, unknown> | undefined : undefined;
      let id = input.id ?? (existing ? String(existing.id) : oldId);
      for (let slot = 1; ; slot++) {
        existing ??= this.db.prepare('SELECT * FROM memories WHERE user_id=? AND id=?').get(scope.userId, id) as Record<string, unknown> | undefined;
        if (!existing) {
          if (this.db.prepare('SELECT id FROM memories WHERE user_id<>? AND id=?').get(scope.userId, id)) throw new RpcError('NOT_FOUND', 'memory not found');
          break;
        }
        if (existing.origin !== 'manual') {
          if (existing.workspace !== scope.workspace || existing.session_id !== (scope.sessionId ?? null) || existing.level !== input.level ||
            (existing.project_id ?? existing.workspace) !== project || existing.memory_scope !== memoryScope ||
            (input.id === undefined && existing.fingerprint !== fingerprint)) throw new RpcError('NOT_FOUND', 'memory not found');
          break;
        }
        if (input.id !== undefined) throw new RpcError('MANUAL_MEMORY_LOCKED', 'manual memory is locked');
        if (existing.workspace !== scope.workspace) throw new RpcError('NOT_FOUND', 'memory not found');
        id = hash(`${oldId}:auto:${slot}`);
        existing = undefined;
      }
      const now = Date.now();
      if (existing) {
        const result = this.db.prepare(`UPDATE memories SET content=?,source=?,content_hash=?,fingerprint=?,revision=revision+1,updated_at=?
          WHERE user_id=? AND id=? AND origin='automatic'`).run(content, input.source ?? null, fingerprint, fingerprint, now, scope.userId, id);
        if (Number(result.changes) !== 1) throw new RpcError('MANUAL_MEMORY_LOCKED', 'manual memory is locked');
      } else {
        this.db.prepare(`INSERT INTO memories(id,user_id,workspace,project_id,memory_scope,session_id,level,content,source,fingerprint,origin,revision,content_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,'automatic',1,?,?,?)`).run(
          id, scope.userId, scope.workspace, project, memoryScope, scope.sessionId ?? null, input.level, content, input.source ?? null, fingerprint, fingerprint, now, now,
        );
      }
      const row = this.db.prepare(`SELECT ${memoryColumns} FROM memories WHERE user_id=? AND id=?`).get(scope.userId, id) as Record<string, unknown>;
      return this.mapRecord(row);
    });
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
    // 以稳定 ID 和 user_id 定位；人工记录采用 UUID，不再从 ID 推断作用域。
    // 不再约束 workspace：全局视图会列出其它项目的记录，带 workspace 条件会导致删除静默失败。
    this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(id, scope.userId);
  }

  private mapRecord(row: Record<string, unknown>): MemoryRecord {
    return { id: String(row.id), level: Number(row.level) as MemoryRecord['level'], content: String(row.content), source: row.source == null ? undefined : String(row.source), sourceProjectId: row.sourceProjectId == null || row.scope === 'global' ? undefined : String(row.sourceProjectId), scope: row.scope === 'global' ? 'global' : 'project', createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private mapManagedRecord(row: Record<string, unknown>): ManagedMemoryRecord {
    return {
      ...this.mapRecord(row), scope: row.scope === 'global' ? 'global' : 'project',
      sourceSessionId: row.sourceSessionId == null ? undefined : String(row.sourceSessionId),
      sourceWorkspace: row.sourceWorkspace == null ? undefined : String(row.sourceWorkspace),
      origin: row.origin === 'manual' ? 'manual' : 'automatic', revision: Number(row.revision), contentHash: String(row.contentHash),
    };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
function projectId(scope: MemoryScope): string { return scope.projectId ?? scope.workspace; }

function validateDraft(draft: MemoryDraft): MemoryDraft {
  if (!draft || typeof draft.content !== 'string' || !draft.content.trim() || ![0, 1, 2, 3].includes(draft.level) ||
    (draft.source !== undefined && typeof draft.source !== 'string')) throw new RpcError('INVALID_PARAMS', 'invalid memory draft');
  const owner = validateFilter(draft.owner);
  if (owner.scope === 'all') throw new RpcError('INVALID_PARAMS', 'memory owner is required');
  return { ...draft, content: draft.content.trim(), owner };
}

function validateFilter(filter: MemoryFilter): MemoryFilter {
  if (!filter || typeof filter !== 'object') throw new RpcError('INVALID_PARAMS', 'invalid memory filter');
  if (filter.scope === 'all' || filter.scope === 'global') return { scope: filter.scope };
  if (filter.scope === 'project' && typeof filter.projectId === 'string' && filter.projectId.trim()) return { scope: 'project', projectId: filter.projectId };
  throw new RpcError('INVALID_PARAMS', 'invalid memory filter');
}

interface MemoryCursor { v: 1; updatedAt: number; id: string; filterHash: string }
function browseQuery(input: MemoryListInput, kind: 'memory' | 'conversation') {
  const filter = validateFilter(input.filter);
  if (typeof input.userId !== 'string' || !input.userId || (input.query !== undefined && typeof input.query !== 'string') ||
    (input.level !== undefined && ![0, 1, 2, 3].includes(input.level))) throw new RpcError('INVALID_PARAMS', 'invalid memory query');
  const query = (input.query ?? '').trim().toLowerCase();
  const filterHash = hash(JSON.stringify([input.userId, filter, query, input.level ?? null, kind]));
  const where = ['user_id=?'];
  const params: Array<string | number> = [input.userId];
  if (filter.scope === 'global') where.push(kind === 'memory' ? "memory_scope='global'" : '0=1');
  if (filter.scope === 'project') {
    if (kind === 'memory') where.push("memory_scope='project'");
    where.push('COALESCE(project_id,workspace)=?');
    params.push(filter.projectId);
  }
  if (query) { where.push(`instr(lower(${kind === 'memory' ? 'content' : 'transcript'}),?)>0`); params.push(query); }
  if (input.level !== undefined && kind === 'memory') { where.push('level=?'); params.push(input.level); }
  if (input.cursor !== undefined) {
    let cursor: MemoryCursor;
    try {
      if (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
      const bytes = Buffer.from(input.cursor, 'base64url');
      if (bytes.toString('base64url') !== input.cursor) throw new Error();
      cursor = JSON.parse(bytes.toString('utf8'));
      if (!cursor || cursor.v !== 1 || typeof cursor.updatedAt !== 'number' || !Number.isFinite(cursor.updatedAt) ||
        typeof cursor.id !== 'string' || !cursor.id || cursor.filterHash !== filterHash) throw new Error();
    } catch { throw new RpcError('INVALID_PARAMS', 'invalid memory cursor'); }
    where.push(`(updated_at<? OR (updated_at=? AND ${kind === 'memory' ? 'id' : 'capture_key'}<?))`);
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.max(1, Math.min(50, Math.trunc(input.limit))) : 50;
  return { where: where.join(' AND '), params, limit, filterHash, query };
}

function page<T extends { id: string; updatedAt: number }>(rows: T[], limit: number, filterHash: string): MemoryPage<T> {
  const items = rows.slice(0, limit);
  if (rows.length <= limit) return { items };
  const last = items[items.length - 1];
  const cursor: MemoryCursor = { v: 1, updatedAt: last.updatedAt, id: last.id, filterHash };
  return { items, nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') };
}

const SNIPPET_LENGTH = 1200;

function mapConversation(row: Record<string, unknown>, query: string): MemoryConversation {
  const transcript = String(row.transcript);
  const start = query ? Math.max(0, transcript.toLowerCase().indexOf(query) - 200) : 0;
  return {
    id: String(row.id), source: String(row.source), sourceSessionId: row.sourceSessionId == null ? undefined : String(row.sourceSessionId),
    workspace: String(row.workspace), sourceProjectId: String(row.sourceProjectId), snippet: transcript.slice(start, start + SNIPPET_LENGTH), updatedAt: Number(row.updatedAt),
  };
}
