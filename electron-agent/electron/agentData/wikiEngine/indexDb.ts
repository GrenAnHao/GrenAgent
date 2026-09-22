// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function poolMax(): number {
  const raw = process.env.KNOWLEDGE_WIKI_POOL_MAX;
  const n = raw === undefined ? 300 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 300;
}

function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -2000');
  db.exec('PRAGMA busy_timeout = 5000');
}

function openDb(wikiDir: string): DatabaseSync {
  const db = new DatabaseSync(join(wikiDir, 'index.db'));
  applyPragmas(db);
  return db;
}

function closeDb(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore checkpoint failures on close
  }
  db.close();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS page_meta (
  page_id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  rel_path TEXT,
  snippet TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  page_id UNINDEXED,
  title_tok,
  content_tok,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TABLE IF NOT EXISTS graph_edge (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE IF NOT EXISTS source (
  filename TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_modified_by TEXT,
  ingested_at TEXT,
  ingest_error TEXT
);
`;

export function initIndexDb(wikiDir: string): void {
  const db = openDb(wikiDir);
  try {
    db.exec(SCHEMA);
  } finally {
    db.close();
  }
}

export function withWriteDb<T>(wikiDir: string, fn: (db: DatabaseSync) => T): T {
  const db = openDb(wikiDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

const readPool = new Map<string, DatabaseSync>();

export function getReadDb(wikiId: string, wikiDir: string): DatabaseSync {
  const hit = readPool.get(wikiId);
  if (hit) {
    readPool.delete(wikiId);
    readPool.set(wikiId, hit);
    return hit;
  }

  const max = poolMax();
  while (readPool.size >= max) {
    const oldest = readPool.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const old = readPool.get(oldest);
    readPool.delete(oldest);
    if (old) closeDb(old);
  }

  const db = openDb(wikiDir);
  readPool.set(wikiId, db);
  return db;
}

export function evictWikiDb(wikiId: string): void {
  const db = readPool.get(wikiId);
  if (!db) return;
  readPool.delete(wikiId);
  closeDb(db);
}

const STOP_WORDS = new Set([
  '的', '是', '了', '什么', '在', '有', '和', '与', '对', '从',
  'the', 'is', 'a', 'an', 'what', 'how', 'are', 'was', 'were',
  'do', 'does', 'did', 'be', 'been', 'being', 'have', 'has', 'had',
  'it', 'its', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'this', 'that', 'these', 'those',
]);

/**
 * 分词器：中英文混合处理。
 * - 英文：按空格/标点切分，保留完整单词，过滤 stop words
 * - 中文：bigram + 整词
 */
export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      result.push(token);
    }
  }
  return result;
}

export type WikiIndexPage = {
  id: string;
  title: string;
  type: string;
  relPath: string;
  content: string;
  links: string[];
};

export function ftsSearch(
  wikiDir: string,
  query: string,
  limit: number,
): Array<{ id: string; score: number }> {
  const toks = tokenize(query);
  if (toks.length === 0) return [];
  const expr = toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
  const db = openDb(wikiDir);
  try {
    const rows = db
      .prepare(
        'SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?',
      )
      .all(expr, limit) as Array<{ page_id: string; score: number }>;
    return rows.map((r) => ({ id: r.page_id, score: -r.score }));
  } finally {
    db.close();
  }
}

export function writeIndex(wikiDir: string, pages: WikiIndexPage[]): void {
  withWriteDb(wikiDir, (db) => {
    db.prepare('DELETE FROM wiki_fts').run();
    db.prepare('DELETE FROM page_meta').run();
    db.prepare('DELETE FROM graph_edge').run();

    const insFts = db.prepare(
      'INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)',
    );
    const insMeta = db.prepare(
      'INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)',
    );
    const insEdge = db.prepare(
      'INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)',
    );

    const idSet = new Set(pages.map((p) => p.id));
    for (const p of pages) {
      insFts.run(p.id, tokenize(p.title).join(' '), tokenize(p.content).join(' '));
      const snippet = [...p.content].slice(0, 200).join('');
      insMeta.run(p.id, p.title, p.type, p.relPath, snippet);
      for (const target of p.links) {
        if (idSet.has(target)) insEdge.run(p.id, target);
      }
    }
  });
}
