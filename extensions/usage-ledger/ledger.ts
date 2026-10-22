// 用量账本：每次模型调用结束时记一行，报表直接按 SQL 聚合，不再回头扫会话 jsonl。
// 库在 <agentDir>/usage/ledger.db，主会话、子代理、命令行 pi 都写同一份（WAL + busy_timeout）。
// 见 .agents/notes/implemented/architecture/2026-10-21-usage-ledger.md

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "../_shared/sqlite.js";

/** 一次模型调用。口径与会话 jsonl 里 `type: message`、`role: assistant`、带 `usage` 的条目相同。 */
export interface LedgerCall {
  sessionId: string;
  /** ISO 时间；按它的前 10 位分日（UTC 日期，与旧扫描一致）。 */
  timestamp: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  /** provider 返回的响应 id；有就用它去重，分叉复制出来的同一条调用只记一次。 */
  responseId: string | null;
  /** 助手消息自己的创建时间（毫秒），没有 responseId 时和 sessionId 一起去重。 */
  messageTimestamp: number | null;
  /** 只有导入时才有：没有 messageTimestamp 时退回条目 id。 */
  entryId?: string | null;
}

export interface LedgerSession {
  id: string;
  path: string | null;
  cwd: string | null;
  startedAt: string | null;
  name: string | null;
}

export type LedgerSource = "live" | "import";

export interface LedgerReport {
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; sessions: number; messages: number; cacheHitRate: number };
  byDay: Array<{ date: string; tokens: number; cost: number }>;
  byModel: Array<{ provider: string; model: string; tokens: number; cost: number; messages: number }>;
  byProject: Array<{ cwd: string; name: string | null; tokens: number; cost: number; sessions: number }>;
  recentSessions: Array<{ id: string; name: string | null; cwd: string | null; path: string; timestamp: string | null; tokens: number; cost: number }>;
  calls: Array<{ timestamp: string | null; provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  path TEXT,
  cwd TEXT,
  started_at TEXT,
  name TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, started_at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 按 日 × 会话 × 模型 汇总，报表只扫这张表（本机 4.7 万次调用对应几千行）。
-- 由 calls 的插入触发器维护，和记账是同一条语句、同一个事务；别的进程写账也一样。
CREATE TABLE IF NOT EXISTS rollup (
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY (day, session_id, provider, model)
);
CREATE TRIGGER IF NOT EXISTS calls_rollup AFTER INSERT ON calls BEGIN
  INSERT INTO rollup (day, session_id, provider, model, input, output, cache_read, cache_write, total_tokens, cost, messages)
  VALUES (COALESCE(substr(NEW.ts, 1, 10), ''), NEW.session_id, NEW.provider, NEW.model,
          NEW.input, NEW.output, NEW.cache_read, NEW.cache_write, NEW.total_tokens, NEW.cost, 1)
  ON CONFLICT (day, session_id, provider, model) DO UPDATE SET
    input = input + excluded.input,
    output = output + excluded.output,
    cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write,
    total_tokens = total_tokens + excluded.total_tokens,
    cost = cost + excluded.cost,
    messages = messages + 1;
END;
`;

export function defaultLedgerPath(agentDir: string): string {
  return join(agentDir, "usage", "ledger.db");
}

/** 去重键：有 responseId 用它（全局唯一），否则会话 id + 消息时间，再不行退回条目 id。 */
export function callKey(call: Pick<LedgerCall, "sessionId" | "provider" | "responseId" | "messageTimestamp" | "entryId">): string | null {
  if (call.responseId) return `r:${call.provider}:${call.responseId}`;
  if (typeof call.messageTimestamp === "number") return `t:${call.sessionId}:${call.messageTimestamp}`;
  if (call.entryId) return `e:${call.sessionId}:${call.entryId}`;
  return null;
}

/** 从一条助手消息里取出用量；不是带 usage 的助手消息就返回 null。会话 jsonl 和 message_end 的消息形状相同。 */
export function callFromMessage(message: unknown, sessionId: string, timestamp: string | null): LedgerCall | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") return null;
  const usage = m.usage as Record<string, unknown>;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>).total : undefined;
  const messageTimestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  return {
    sessionId,
    timestamp,
    provider: typeof m.provider === "string" ? m.provider : "",
    model: typeof m.model === "string" ? m.model : "",
    input: n("input"),
    output: n("output"),
    cacheRead: n("cacheRead"),
    cacheWrite: n("cacheWrite"),
    totalTokens: n("totalTokens"),
    cost: typeof cost === "number" ? cost : 0,
    responseId: typeof m.responseId === "string" && m.responseId ? m.responseId : null,
    messageTimestamp,
  };
}

export class UsageLedger {
  private db: DatabaseSync | undefined;

  constructor(private readonly file: string) {}

  private get database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      /* 个别平台不支持 WAL 时退回默认日志模式 */
    }
    db.exec(SCHEMA);
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  /** 记一次调用；同一个键已经在账上就不动（返回 false）。 */
  record(call: LedgerCall, source: LedgerSource): boolean {
    const key = callKey(call);
    if (!key) return false;
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO calls (key, session_id, ts, provider, model, input, output, cache_read, cache_write, total_tokens, cost, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, call.sessionId, call.timestamp, call.provider, call.model, call.input, call.output, call.cacheRead, call.cacheWrite, call.totalTokens, call.cost, source);
    return Number(result.changes) > 0;
  }

  /** 会话信息：已知的字段不会被 null 覆盖。 */
  upsertSession(session: LedgerSession): void {
    this.database
      .prepare(
        `INSERT INTO sessions (id, path, cwd, started_at, name) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = COALESCE(excluded.path, sessions.path),
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           started_at = COALESCE(sessions.started_at, excluded.started_at),
           name = COALESCE(excluded.name, sessions.name)`,
      )
      .run(session.id, session.path, session.cwd, session.startedAt, session.name);
  }

  /** 一批写入放进一个事务；导入几万行时比逐条提交快两个数量级。 */
  transaction<T>(run: () => T): T {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.database.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  report(): LedgerReport {
    const db = this.database;
    const t = db
      .prepare(
        `SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cacheRead,
                COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(messages), 0) AS messages, COUNT(DISTINCT session_id) AS sessions
         FROM rollup`,
      )
      .get() as Record<string, number>;
    const totals = {
      input: num(t.input), output: num(t.output), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite),
      totalTokens: num(t.totalTokens), cost: num(t.cost), sessions: num(t.sessions), messages: num(t.messages), cacheHitRate: 0,
    };
    totals.cacheHitRate = totals.input + totals.cacheRead ? totals.cacheRead / (totals.input + totals.cacheRead) : 0;

    const byDay = (db
      .prepare(
        `SELECT day AS date, SUM(total_tokens) AS tokens, SUM(cost) AS cost
         FROM rollup WHERE day <> '' GROUP BY day ORDER BY day`,
      )
      .all() as Array<Record<string, unknown>>).map((r) => ({ date: String(r.date), tokens: num(r.tokens), cost: num(r.cost) }));

    const byModel = (db
      .prepare(
        `SELECT provider, model, SUM(total_tokens) AS tokens, SUM(cost) AS cost, SUM(messages) AS messages
         FROM rollup GROUP BY provider, model ORDER BY tokens DESC`,
      )
      .all() as Array<Record<string, unknown>>).map((r) => ({ provider: String(r.provider), model: String(r.model), tokens: num(r.tokens), cost: num(r.cost), messages: num(r.messages) }));

    // 项目名沿用旧口径：这个目录下最早一个有名字的会话标题（渲染层会再按侧栏命名覆盖）。
    const byProject = (db
      .prepare(
        `SELECT s.cwd AS cwd, SUM(r.total_tokens) AS tokens, SUM(r.cost) AS cost, COUNT(DISTINCT r.session_id) AS sessions,
                (SELECT s2.name FROM sessions s2 WHERE s2.cwd = s.cwd AND s2.name IS NOT NULL ORDER BY s2.started_at LIMIT 1) AS name
         FROM rollup r JOIN sessions s ON s.id = r.session_id
         WHERE s.cwd IS NOT NULL
         GROUP BY s.cwd ORDER BY tokens DESC`,
      )
      .all() as Array<Record<string, unknown>>).map((r) => ({ cwd: String(r.cwd), name: str(r.name), tokens: num(r.tokens), cost: num(r.cost), sessions: num(r.sessions) }));

    const recentSessions = (db
      .prepare(
        `SELECT s.id AS id, s.name AS name, s.cwd AS cwd, s.path AS path, s.started_at AS timestamp, a.tokens AS tokens, a.cost AS cost
         FROM (SELECT session_id, SUM(total_tokens) AS tokens, SUM(cost) AS cost FROM rollup GROUP BY session_id) a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.path IS NOT NULL
         ORDER BY s.started_at DESC LIMIT 50`,
      )
      .all() as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id), name: str(r.name), cwd: str(r.cwd), path: String(r.path), timestamp: str(r.timestamp), tokens: num(r.tokens), cost: num(r.cost),
      }));

    const calls = (db
      .prepare(
        `SELECT ts AS timestamp, provider, model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, total_tokens AS totalTokens, cost
         FROM calls ORDER BY ts DESC LIMIT 500`,
      )
      .all() as Array<Record<string, unknown>>).map((r) => ({
        timestamp: str(r.timestamp), provider: String(r.provider), model: String(r.model),
        input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite), totalTokens: num(r.totalTokens), cost: num(r.cost),
      }));

    return { totals, byDay, byModel, byProject, recentSessions, calls };
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const ledgers = new Map<string, UsageLedger>();

/** 同一进程里同一个库文件只开一个连接。 */
export function sharedLedger(file: string): UsageLedger {
  let ledger = ledgers.get(file);
  if (!ledger) {
    ledger = new UsageLedger(file);
    ledgers.set(file, ledger);
  }
  return ledger;
}
