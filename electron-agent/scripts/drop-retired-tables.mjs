// 由 cleanup-agentdata.bat 调用：删除已下线能力的表，然后回收空间。
// 用法: node drop-retired-tables.mjs <db 路径> <表名...>
import { DatabaseSync } from 'node:sqlite';

const [dbPath, ...tables] = process.argv.slice(2);
if (!dbPath) {
  console.error('用法: node drop-retired-tables.mjs <db> <table...>');
  process.exit(2);
}

// 绝不删除仍在服役的表：调用方传错也不执行。
const PROTECTED = new Set([
  'threads', 'turns', 'items', 'app_events', 'audit_events',
  'permission_rules', 'tool_audit', 'plugin_state', 'service_tasks',
  'agent_config', 'schema_version',
]);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
try {
  const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name),
  );
  const targets = tables.filter((name) => {
    if (PROTECTED.has(name)) {
      console.log(`       [跳过] ${name} 仍在服役`);
      return false;
    }
    if (!present.has(name)) return false;
    return true;
  });

  if (!targets.length) {
    console.log('       没有需要删除的表');
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of targets) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      db.exec('COMMIT');
      console.log(`       已删除 ${targets.length} 张表: ${targets.join(', ')}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // 回收空间；失败不算致命（例如仍有连接）。
  try {
    db.exec('VACUUM');
    console.log('       已回收磁盘空间');
  } catch {
    console.log('       VACUUM 跳过（数据库可能仍被占用）');
  }
} finally {
  db.close();
}
