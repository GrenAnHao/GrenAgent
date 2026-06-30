// Cross-runtime SQLite shim.
//
// The official Pi runtime is Node (>=22.5) where `node:sqlite` (DatabaseSync) is
// built in. GrenAgent compiles this extension pack into a *bun*-compiled sidecar,
// and bun does NOT implement `node:sqlite` (it ships `bun:sqlite` with a nearly
// identical API). A static `import ... from "node:sqlite"` makes `bun build
// --compile` fail with `Could not resolve "node:sqlite"`, and even a literal
// `require("node:sqlite")` is statically analyzed.
//
// So we pick the driver at runtime via a *variable* require (not statically
// analyzable), and expose a single `DatabaseSync` class with the small surface
// the stores use: exec / prepare().{get,all,run} / close.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// Variable module id → bun --compile won't try to bundle/resolve "node:sqlite".
const moduleName = isBun ? "bun:sqlite" : "node:sqlite";
const driver = require(moduleName) as Record<string, unknown>;

interface RawStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}
type DatabaseCtor = new (file: string) => RawDatabase;

// node:sqlite exports `DatabaseSync`; bun:sqlite exports `Database`. Both accept a
// file path and expose exec/prepare/close with matching statement semantics.
const NativeDatabase: DatabaseCtor = isBun
  ? (driver.Database as DatabaseCtor)
  : (driver.DatabaseSync as DatabaseCtor);

export class DatabaseSync {
  private readonly db: RawDatabase;

  constructor(file: string) {
    this.db = new NativeDatabase(file);
    // 并发健壮性：同一库文件常被多方同时访问——本进程（Node/bun 写入端）+ GrenAgent 的 Rust UI
    // 只读高频轮询（任务托盘 / 子代理日志）。SQLite 默认 busy_timeout=0：拿不到锁的一方会立刻抛
    // "database is locked"（SQLITE_BUSY），而不是等一下重试。子代理 registry 在运行期被流式高频
    // 写入，与只读轮询撞锁后整串异常会从子进程 stdout 流泵里逃逸（详见 multi-agent/registry.ts）。
    // 设一个较大的 busy_timeout，把短暂的读写争用变成「短等重试」而非「立即报错」。
    // PRAGMA 失败不致命（个别驱动/平台不支持时退回默认行为）。
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      /* 不支持 PRAGMA 时忽略：退回默认（busy_timeout=0）行为 */
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): RawStatement {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}
