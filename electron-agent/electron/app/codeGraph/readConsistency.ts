/**
 * 一次工具调用可能跨过索引的一次提交（SDK 按文件分批提交）。
 * 在调用前后读同一条只读连接上的 PRAGMA data_version：变了就重试一次，还变就在 meta.consistency 标 mixed。
 * data_version 是连接本地的计数，必须复用同一条连接；新开的连接会从 1 重新计，比不出变化。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';

export async function observeRead(version: () => number | undefined, run: () => Promise<CodeRetrievalResult>): Promise<CodeRetrievalResult> {
  const attempt = async () => {
    const before = readVersion(version);
    const value = await run();
    const after = readVersion(version);
    return { value, changed: before !== undefined && after !== undefined && before !== after };
  };
  const first = await attempt();
  if (!first.changed) return first.value;
  const second = await attempt();
  if (!second.changed) return second.value;
  const meta = { ...(second.value.structuredContent.meta ?? {}), consistency: 'mixed' as const };
  return { ...second.value, structuredContent: { ...second.value.structuredContent, meta } };
}

export function indexDataVersion(workspace: string, cache: Map<string, DatabaseSync>): number | undefined {
  const file = join(workspace, '.codegraph', 'codegraph.db');
  if (!existsSync(file)) return undefined;
  try {
    let db = cache.get(file);
    if (!db) {
      db = new DatabaseSync(file, { readOnly: true });
      cache.set(file, db);
    }
    const row = db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined;
    return typeof row?.data_version === 'number' ? row.data_version : undefined;
  } catch {
    const db = cache.get(file);
    cache.delete(file);
    try { db?.close(); } catch { /* 连接已经不可用 */ }
    return undefined;
  }
}

export function closeIndexVersions(cache: Map<string, DatabaseSync>): void {
  for (const db of cache.values()) {
    try { db.close(); } catch { /* 关掉失败不影响进程退出 */ }
  }
  cache.clear();
}

function readVersion(version: () => number | undefined): number | undefined {
  try { return version(); } catch { return undefined; }
}
