/**
 * codegraph 自己的任务记录。
 *
 * 与 Repo Wiki 的 `WikiTaskStore` 同一套语义（状态机、阶段、取消意图、终态、孤儿落定），
 * 但落在 codegraph 自己的库里。任务体系下线后，索引任务不再写 `agent_jobs`，
 * 也不再依赖 AgentData 管理面；`CodeGraphJobs` 的回调直接接这里。
 *
 * 为什么不复用共享任务表：索引任务的消费方只有代码索引面板和 `code_explore` 的提示，
 * 没有跨域查询需求；把它留在通用任务模型里，正是被判定为无独立价值的抽象。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type IndexTaskState = 'pending' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface IndexTaskStageCounts { processed: number; total: number }

export interface IndexTask {
  id: string;
  workspace: string;
  kind: 'codegraph.sync';
  state: IndexTaskState;
  progress: number;
  stage?: string;
  message?: string;
  processed?: number;
  total?: number;
  error?: string;
  origin?: 'breaker' | 'manual';
  createdAt: number;
  updatedAt: number;
}

const ACTIVE = new Set<IndexTaskState>(['pending', 'running', 'blocked', 'paused']);
const TERMINAL = new Set<IndexTaskState>(['completed', 'failed', 'cancelled']);

export class IndexTaskStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS index_tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'codegraph.sync',
        state TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        stage TEXT,
        message TEXT,
        processed INTEGER,
        total INTEGER,
        error TEXT,
        origin TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS index_tasks_workspace ON index_tasks(workspace, updated_at DESC);
      CREATE INDEX IF NOT EXISTS index_tasks_state ON index_tasks(state, updated_at DESC);
    `);
  }

  close(): void { this.db.close(); }

  create(input: { id: string; workspace: string; origin?: 'manual' | 'breaker' }): IndexTask {
    const now = this.now();
    this.db.prepare(`INSERT INTO index_tasks(id,workspace,kind,state,progress,created_at,updated_at,origin)
      VALUES(?,?,'codegraph.sync','pending',0,?,?,?)`).run(input.id, input.workspace, now, now, input.origin ?? 'manual');
    return this.get(input.id)!;
  }

  get(id: string): IndexTask | undefined {
    const row = this.db.prepare('SELECT * FROM index_tasks WHERE id=?').get(id) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(query: { workspace?: string; activeOnly?: boolean } = {}): IndexTask[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query.workspace) { where.push('workspace=?'); params.push(query.workspace); }
    if (query.activeOnly) where.push("state IN ('pending','running','paused','blocked')");
    const sql = `SELECT * FROM index_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, created_at DESC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapRow);
  }

  start(id: string): IndexTask | undefined {
    this.db.prepare("UPDATE index_tasks SET state='running',updated_at=? WHERE id=? AND state='pending'").run(this.now(), id);
    return this.get(id);
  }

  stage(id: string, stage: string, counts?: IndexTaskStageCounts): IndexTask | undefined {
    if (!stage.trim() || stage.length > 120) throw new Error('INVALID_STAGE');
    if (counts && (!Number.isSafeInteger(counts.processed) || !Number.isSafeInteger(counts.total) || counts.processed < 0 || counts.total < 0 || counts.processed > counts.total)) throw new Error('INVALID_COUNTS');
    const current = this.get(id);
    if (!current || !ACTIVE.has(current.state)) return current;
    const progress = counts && counts.total > 0 ? Math.max(0, Math.min(99, Math.round((counts.processed / counts.total) * 100))) : current.progress;
    this.db.prepare('UPDATE index_tasks SET stage=?,processed=?,total=?,progress=?,updated_at=? WHERE id=?')
      .run(stage, counts?.processed ?? current.processed ?? null, counts?.total ?? current.total ?? null, progress, this.now(), id);
    return this.get(id);
  }

  complete(id: string): IndexTask | undefined {
    this.db.prepare("UPDATE index_tasks SET state='completed',progress=100,stage='已完成',updated_at=? WHERE id=? AND state IN ('pending','running')").run(this.now(), id);
    return this.get(id);
  }

  fail(id: string, error: string): IndexTask | undefined {
    this.db.prepare("UPDATE index_tasks SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('pending','running')").run(error.slice(0, 2000), this.now(), id);
    return this.get(id);
  }

  cancel(id: string): IndexTask | undefined {
    this.db.prepare("UPDATE index_tasks SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','running')").run(this.now(), id);
    return this.get(id);
  }

  /** 同一工作区已有在跑的索引任务时不允许重复派发。 */
  activeFor(workspace: string): IndexTask | undefined {
    return this.list({ workspace, activeOnly: true })[0];
  }

  remove(id: string): { deleted: boolean } {
    const task = this.get(id);
    if (task && !TERMINAL.has(task.state)) throw new Error('TASK_ACTIVE');
    const result = this.db.prepare("DELETE FROM index_tasks WHERE id=? AND state IN ('completed','failed','cancelled')").run(id);
    return { deleted: Number(result.changes) > 0 };
  }

  /**
   * 启动时孤儿落定：本进程没有执行者的 pending/running 不会自行恢复。
   * 索引写入可能已部分完成，因此标 failed 并保留已写索引，不声称回滚。
   */
  settleOrphans(reason = 'JOB_INTERRUPTED: 应用重启时索引任务仍在运行，已中断'): number {
    const rows = this.db.prepare("SELECT id FROM index_tasks WHERE state IN ('pending','running')").all() as Array<{ id: string }>;
    if (!rows.length) return 0;
    const now = this.now();
    const fail = this.db.prepare("UPDATE index_tasks SET state='failed',error=?,updated_at=? WHERE id=?");
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) fail.run(reason, now, row.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return rows.length;
  }

  /** 熔断记录：同一工作区已有未结束任务时不另建，已有熔断失败则刷新错误。 */
  recordBreaker(workspace: string, error: string): IndexTask {
    const active = this.activeFor(workspace);
    if (active) return active;
    const previous = this.list({ workspace }).find((task) => task.origin === 'breaker' && task.state === 'failed');
    if (previous) {
      this.db.prepare('UPDATE index_tasks SET error=?,updated_at=? WHERE id=?').run(error.slice(0, 2000), this.now(), previous.id);
      return this.get(previous.id)!;
    }
    const id = `breaker:${workspace}:${this.now()}`;
    const task = this.create({ id, workspace, origin: 'breaker' });
    return this.fail(task.id, error)!;
  }
}

type Row = Record<string, unknown>;

function mapRow(row: Row): IndexTask {
  const state = String(row.state) as IndexTaskState;
  return {
    id: String(row.id), workspace: String(row.workspace), kind: 'codegraph.sync',
    state: ACTIVE.has(state) || TERMINAL.has(state) ? state : 'failed',
    progress: Number(row.progress ?? 0),
    ...(row.stage == null ? {} : { stage: String(row.stage) }),
    ...(row.message == null ? {} : { message: String(row.message) }),
    ...(row.processed == null ? {} : { processed: Number(row.processed) }),
    ...(row.total == null ? {} : { total: Number(row.total) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    ...(row.origin == null ? {} : { origin: String(row.origin) as IndexTask['origin'] }),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
