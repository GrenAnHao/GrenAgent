// SQLite-backed registry of sub-agents, so the main agent and the UI can later
// query (`status`), list, or stop (`cancel`) a sub-agent. Background results are
// pushed to the parent as subagent-settled notices; this table is the record.
// Project-scoped at <cwd>/.pi/subagents/registry.db (mirrors memory/checkpoint).

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "../_shared/sqlite.js";
import { isContinuableLeftover } from "./subagent-meta.js";
import { tailLines, LIVE_TRANSCRIPT_TAIL, TRANSCRIPT_CAP } from "./transcript-tail.js";

export type SubAgentStatus = "running" | "done" | "error" | "cancelled";

// progress() 的最小落盘间隔：运行期 `--mode json` 约每 150ms 一帧，但消费方（右坞子代理日志 /
// 任务托盘）轮询 registry 仅 ~2.5s 一次，没必要每帧都把最多 64KB 的 transcript 同步写进 SQLite。
// DatabaseSync 是同步的，高频大写入会阻塞 sidecar 事件循环并与只读轮询争锁。把落盘收敛到最多每
// PROGRESS_PERSIST_MS 一次，足够喂饱 2.5s 的轮询；终态完整 transcript 由 finish() 兜底写一次。
const PROGRESS_PERSIST_MS = 1000;

export interface SubAgentRow {
  id: string;
  task: string;
  /** JSON of the resolved capability profile, for display. */
  profile: string | null;
  model: string | null;
  /** 子会话当前实际运行的思考档位（embedded 子代理起会话后写入）；未知为 null。 */
  thinkingLevel: string | null;
  status: SubAgentStatus;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  /** Raw `--mode json` JSONL stream, written incrementally while running (progress) and finalized on finish. */
  transcript: string | null;
  /** Child session JSONL path (embedded continuable). Null for process / one-shot leftovers. */
  sessionPath: string | null;
  /** 直接父级 id（顶层会话 spawn 的为 null）。 */
  parentId: string | null;
  /** 委派深度：顶层 0。 */
  depth: number;
  /** 旧版后台 one-shot 用过的 jobs id；子代理已不走 jobs，只保留列给旧库读取。 */
  jobId: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SubAgentRegistry {
  private db: DatabaseSync | undefined;
  /** progress() 每-id 的上次落盘时刻，用于把高频流式写入收敛到 PROGRESS_PERSIST_MS 间隔。 */
  private lastProgressAt = new Map<string, number>();

  constructor(private readonly file: string) {}

  load(): void {
    if (this.db) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(
      `CREATE TABLE IF NOT EXISTS subagents (
         id TEXT PRIMARY KEY,
         task TEXT NOT NULL,
         profile TEXT,
         model TEXT,
         thinkingLevel TEXT,
         status TEXT NOT NULL,
         output TEXT,
         error TEXT,
         exitCode INTEGER,
         transcript TEXT,
         sessionPath TEXT,
         parentId TEXT,
         depth INTEGER NOT NULL DEFAULT 0,
         jobId TEXT,
         createdAt INTEGER NOT NULL,
         updatedAt INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status);`,
    );
    // 迁移：旧库（v1，无 transcript 列）补列——CREATE TABLE IF NOT EXISTS 不会给已存在的表加列。
    // 新库的 CREATE 已含该列，PRAGMA 命中即跳过 ALTER。
    const cols = db.prepare("PRAGMA table_info(subagents)").all() as Array<{ name?: string }>;
    if (!cols.some((c) => c.name === "transcript")) {
      db.exec("ALTER TABLE subagents ADD COLUMN transcript TEXT");
    }
    if (!cols.some((c) => c.name === "sessionPath")) {
      db.exec("ALTER TABLE subagents ADD COLUMN sessionPath TEXT");
    }
    if (!cols.some((c) => c.name === "parentId")) db.exec("ALTER TABLE subagents ADD COLUMN parentId TEXT");
    if (!cols.some((c) => c.name === "depth")) db.exec("ALTER TABLE subagents ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
    if (!cols.some((c) => c.name === "jobId")) db.exec("ALTER TABLE subagents ADD COLUMN jobId TEXT");
    if (!cols.some((c) => c.name === "thinkingLevel")) db.exec("ALTER TABLE subagents ADD COLUMN thinkingLevel TEXT");
    // 列表索引：parentId / sessionPath / createdAt 都排在 transcript 后面，大 transcript 在溢出页里，
    // 不走索引时每次列表都要顺着所有行的溢出链读到行尾（百兆级 transcript 时一次上百毫秒，
    // 且在 Electron 主线程上）。覆盖索引让「按时间取最新 N 条」和「按会话收归属」都不碰表行。
    db.exec("CREATE INDEX IF NOT EXISTS idx_subagents_listing ON subagents(createdAt, id, parentId, sessionPath)");
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private get database(): DatabaseSync {
    if (!this.db) this.load();
    return this.db as DatabaseSync;
  }

  static genId(): string {
    return "sa-" + randomBytes(4).toString("hex");
  }

  create(input: {
    id: string;
    task: string;
    profile?: string | null;
    model?: string | null;
    sessionPath?: string | null;
    parentId?: string | null;
    depth?: number;
    jobId?: string | null;
  }): SubAgentRow {
    const now = Date.now();
    const row: SubAgentRow = {
      id: input.id,
      task: input.task,
      profile: input.profile ?? null,
      model: input.model ?? null,
      thinkingLevel: null,
      status: "running",
      output: null,
      error: null,
      exitCode: null,
      transcript: null,
      sessionPath: input.sessionPath ?? null,
      parentId: input.parentId ?? null,
      depth: input.depth ?? 0,
      jobId: input.jobId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        "INSERT INTO subagents(id, task, profile, model, status, output, error, exitCode, sessionPath, parentId, depth, jobId, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.task,
        row.profile,
        row.model,
        row.status,
        row.output,
        row.error,
        row.exitCode,
        row.sessionPath,
        row.parentId,
        row.depth,
        row.jobId,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  /** thinkingLevel 缺省时保留库里已有的值，流式帧不带档位也不会把它清掉。 */
  setSessionPath(id: string, path: string, thinkingLevel?: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    const level = thinkingLevel?.trim() || null;
    this.database
      .prepare("UPDATE subagents SET sessionPath=?, thinkingLevel=COALESCE(?, thinkingLevel), updatedAt=? WHERE id=?")
      .run(trimmed, level, Date.now(), id);
  }

  /** 前台单任务路径不写 sessionPath，档位单独落库。 */
  setThinkingLevel(id: string, level: string): void {
    const trimmed = level.trim();
    if (!trimmed) return;
    this.database.prepare("UPDATE subagents SET thinkingLevel=? WHERE id=?").run(trimmed, id);
  }

  finish(
    id: string,
    patch: {
      status: SubAgentStatus;
      output?: string | null;
      error?: string | null;
      exitCode?: number | null;
      transcript?: string | null;
    },
  ): void {
    // transcript 用 COALESCE：调用方不传 / 传空串(→null)时保留运行期 progress() 已写入的 transcript，
    // 不会把实时累积的内容清空；传非空字符串则截断到上限后覆盖为最终 transcript。
    this.database
      .prepare(
        "UPDATE subagents SET status=?, output=?, error=?, exitCode=?, transcript=COALESCE(?, transcript), updatedAt=? WHERE id=?",
      )
      .run(
        patch.status,
        patch.output ?? null,
        patch.error ?? null,
        patch.exitCode ?? null,
        patch.transcript ? tailLines(patch.transcript, TRANSCRIPT_CAP) : null,
        Date.now(),
        id,
      );
    this.lastProgressAt.delete(id);
  }

  get(id: string): SubAgentRow | undefined {
    return this.database.prepare("SELECT * FROM subagents WHERE id=?").get(id) as SubAgentRow | undefined;
  }

  list(limit = 50): SubAgentRow[] {
    return this.database
      .prepare("SELECT * FROM subagents ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as unknown as SubAgentRow[];
  }

  /** Heartbeat: bump updatedAt for a running row (background spawn's stream calls this). */
  touch(id: string): void {
    // best-effort：在子进程 stdout 流泵的 onUpdate 回调里被调用，写失败（偶发 SQLITE_BUSY 等）
    // 绝不能抛进流处理器变成 uncaughtException 打断子代理流。丢一次心跳无害，下一帧再写。
    try {
      this.database.prepare("UPDATE subagents SET updatedAt=? WHERE id=? AND status='running'").run(Date.now(), id);
    } catch {
      /* 偶发争用：丢弃本次心跳，下个 tick 再试 */
    }
  }

  /**
   * Streaming progress: persist the latest raw JSONL transcript (and bump updatedAt) for a running row.
   * Used in place of touch() on the streaming path so the UI can replay the sub-agent live by polling
   * the registry. The `status='running'` guard makes a late update after finish() a harmless no-op.
   */
  progress(id: string, transcript: string): void {
    // 落盘节流：见 PROGRESS_PERSIST_MS——流式每帧（~150ms）都同步写一次最多 64KB 的 TEXT 既阻塞
    // 事件循环、又与只读轮询争锁，而消费方仅 ~2.5s 轮询一次。每-id 收敛到至多每 PROGRESS_PERSIST_MS
    // 落盘一次（首帧立即写，保证预览尽快出现）；被跳过的帧无害（transcript 是累计量，下次写即最新）。
    const now = Date.now();
    if (now - (this.lastProgressAt.get(id) ?? 0) < PROGRESS_PERSIST_MS) return;
    this.lastProgressAt.set(id, now);
    // best-effort：本方法在子进程 stdout 流泵的 onUpdate 回调里被调用，写失败绝不能抛进流处理器
    // 变成 uncaughtException（会打断子代理流、扰乱 sidecar）。丢这一帧即可，下一帧再写。
    try {
      // 写入侧统一截断：运行期 transcript 随 `--mode json` 的 message_update 呈 O(n^2) 膨胀，只留尾部
      // 定长片段（与主对话内联流同口径），避免 DB 写超大 TEXT、前端轮询读全量经 IPC 卡顿。
      this.database
        .prepare("UPDATE subagents SET transcript=?, updatedAt=? WHERE id=? AND status='running'")
        .run(tailLines(transcript, LIVE_TRANSCRIPT_TAIL), now, id);
    } catch {
      /* 偶发 SQLITE_BUSY / 写失败：保留上次预览，下个 tick 再试 */
    }
  }

  /** Running rows with no activity (updatedAt) for >= thresholdMs — candidates for stuck reaping. */
  findStuck(thresholdMs: number): SubAgentRow[] {
    const cutoff = Date.now() - Math.max(0, thresholdMs);
    return this.database
      .prepare("SELECT * FROM subagents WHERE status='running' AND updatedAt <= ? ORDER BY updatedAt ASC")
      .all(cutoff) as unknown as SubAgentRow[];
  }

  /** Delete a record. The main agent controls lifecycle — sub-agents are not auto-destroyed. */
  remove(id: string): boolean {
    const info = this.database.prepare("DELETE FROM subagents WHERE id=?").run(id);
    this.lastProgressAt.delete(id);
    return Number(info.changes) > 0;
  }

  /** After a restart, leftover running rows are reaped. Continuable JSONL leftovers stay resumable. */
  reapOrphans(): number {
    const rows = this.database
      .prepare("SELECT * FROM subagents WHERE status='running'")
      .all() as unknown as SubAgentRow[];
    let n = 0;
    for (const row of rows) {
      if (isContinuableLeftover(row.sessionPath)) {
        this.finish(row.id, { status: "done", error: "sidecar restarted", output: "" });
      } else {
        this.finish(row.id, { status: "error", error: "orphaned: process restarted" });
      }
      n += 1;
    }
    return n;
  }
}
