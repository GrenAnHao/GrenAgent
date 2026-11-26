// 子代理登记库的建表 / 补列唯一实现。
//
// 单独成文件而不是留在 registry.ts：仓库里有被 Git 忽略的旧 `.js` 声明构建产物，
// 同目录同名 `.js` 会在某些运行路径上遮蔽 `.ts`。registry.ts 与迁移适配器（session-project-transfer.ts）
// 都要用同一份 schema；把它放在只有 `.ts` 的新文件里，两边解析到的是同一实现。

import type { DatabaseSync } from "../_shared/sqlite.js";

/**
 * 建表 / 补列的唯一实现在这里：子代理 registry 与迁移适配器（session-project-transfer.ts）都用它，
 * 迁过去的目标库不需要假装成「本进程打开过的 registry」，也不会因为漏补列读到半旧 schema。
 */
export function ensureSubAgentRegistrySchema(db: DatabaseSync): void {
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
       bashState TEXT,
       responseStarted INTEGER NOT NULL DEFAULT 0,
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
  if (!cols.some((c) => c.name === "bashState")) db.exec("ALTER TABLE subagents ADD COLUMN bashState TEXT");
  // 首响应标记：旧库补列后为 0（未知）；运行期一旦观察到实质活动，未被节流跳过的帧立即写 1。
  if (!cols.some((c) => c.name === "responseStarted")) {
    db.exec("ALTER TABLE subagents ADD COLUMN responseStarted INTEGER NOT NULL DEFAULT 0");
  }
  // 列表索引：parentId / sessionPath / createdAt 都排在 transcript 后面，大 transcript 在溢出页里，
  // 不走索引时每次列表都要顺着所有行的溢出链读到行尾（百兆级 transcript 时一次上百毫秒，
  // 且在 Electron 主线程上）。覆盖索引让「按时间取最新 N 条」和「按会话收归属」都不碰表行。
  db.exec("CREATE INDEX IF NOT EXISTS idx_subagents_listing ON subagents(createdAt, id, parentId, sessionPath)");
}
