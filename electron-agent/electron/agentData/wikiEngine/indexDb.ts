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
