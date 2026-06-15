// Memory store backed by node:sqlite. Each memory is a short, atomic fact
// (preference / decision / convention / fact) — unlike knowledge-rag, memories
// are NOT chunked. Dedup is by text hash so saving the same fact is idempotent.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "../_shared/sqlite.js";
import { type EmbeddingConfig, embedTexts } from "./embedding.js";
import { vecNorm } from "./ranking.js";

export interface Memory {
  id: string;
  text: string;
  category: string | null;
  createdAt: number;
  embedding?: number[];
}

export interface MemoryHit {
  memory: Memory;
  score: number;
}

export type HistoryOp = "ADD" | "UPDATE" | "DELETE" | "ROLLBACK";

export interface HistoryRow {
  historyId: number;
  memoryId: string;
  op: HistoryOp;
  oldText: string | null;
  newText: string | null;
  oldCategory: string | null;
  newCategory: string | null;
  reason: string | null;
  model: string | null;
  version: number;
  createdAt: number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function keywordScore(query: string, text: string): number {
  // Match ASCII words and CJK runs so keyword search works for Chinese too
  // (plain \W+ split drops CJK characters entirely).
  const terms = (query.toLowerCase().match(/[\w\u4e00-\u9fff]+/g) ?? []).filter((t) => t.length > 1);
  if (!terms.length) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    let idx = hay.indexOf(term);
    while (idx !== -1) {
      hits++;
      idx = hay.indexOf(term, idx + term.length);
    }
  }
  return hits / Math.sqrt(text.length + 1);
}

function encodeEmbedding(emb: number[] | undefined): Uint8Array | null {
  if (!emb || !emb.length) return null;
  return new Uint8Array(new Float32Array(emb).buffer);
}

function decodeEmbedding(blob: Uint8Array | null | undefined): number[] | undefined {
  if (!blob || blob.byteLength < 4) return undefined;
  const aligned = blob.slice();
  return Array.from(new Float32Array(aligned.buffer, 0, Math.floor(aligned.byteLength / 4)));
}

interface MemoryRow {
  id: string;
  text: string;
  category: string | null;
  createdAt: number;
  embedding: Uint8Array | null;
}

export class MemoryStore {
  private db: DatabaseSync | undefined;
  // id → 预解码向量 + 预算 norm。null 表示尚未懒初始化。
  private vecCache: Map<string, { vec: Float32Array; norm: number }> | null = null;

  constructor(private readonly file: string) {}

  load(): void {
    if (this.db) return;
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memories (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         category TEXT,
         createdAt INTEGER NOT NULL,
         embedding BLOB
       );
       CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(createdAt);
       CREATE TABLE IF NOT EXISTS memory_history (
         historyId INTEGER PRIMARY KEY AUTOINCREMENT,
         memoryId TEXT NOT NULL,
         op TEXT NOT NULL,
         oldText TEXT, newText TEXT, oldCategory TEXT, newCategory TEXT,
         reason TEXT, model TEXT,
         version INTEGER NOT NULL,
         createdAt INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_history_memory ON memory_history(memoryId, historyId);`,
    );
    this.migrate();
  }

  /** Backfill new columns on a legacy `memories` table without data loss. */
  private migrate(): void {
    const cols = this.database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has("updatedAt")) {
      this.database.exec("ALTER TABLE memories ADD COLUMN updatedAt INTEGER");
      this.database.exec("UPDATE memories SET updatedAt = createdAt WHERE updatedAt IS NULL");
    }
    if (!has("version")) {
      this.database.exec("ALTER TABLE memories ADD COLUMN version INTEGER");
      this.database.exec("UPDATE memories SET version = 1 WHERE version IS NULL");
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private get database(): DatabaseSync {
    if (!this.db) this.load();
    return this.db as DatabaseSync;
  }

  private ensureVecCache(): Map<string, { vec: Float32Array; norm: number }> {
    if (this.vecCache) return this.vecCache;
    const cache = new Map<string, { vec: Float32Array; norm: number }>();
    const rows = this.database
      .prepare("SELECT id, embedding FROM memories")
      .all() as unknown as Array<{ id: string; embedding: Uint8Array | null }>;
    for (const r of rows) {
      const emb = decodeEmbedding(r.embedding);
      if (emb) {
        const vec = Float32Array.from(emb);
        cache.set(r.id, { vec, norm: vecNorm(vec) });
      }
    }
    this.vecCache = cache;
    return cache;
  }

  private cachePut(id: string, emb: number[] | undefined): void {
    if (!this.vecCache) return;
    if (!emb || !emb.length) {
      this.vecCache.delete(id);
      return;
    }
    const vec = Float32Array.from(emb);
    this.vecCache.set(id, { vec, norm: vecNorm(vec) });
  }

  private cacheDelete(id: string): void {
    this.vecCache?.delete(id);
  }

  stats(): { count: number; categories: number } {
    const c = this.database.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    const cat = this.database.prepare("SELECT COUNT(DISTINCT category) AS n FROM memories WHERE category IS NOT NULL").get() as {
      n: number;
    };
    return { count: c.n, categories: cat.n };
  }

  clear(): void {
    this.database.exec("DELETE FROM memories;");
    this.vecCache = null;
  }

  forget(id: string): boolean {
    const info = this.database.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.cacheDelete(id);
    return Number(info.changes) > 0;
  }

  list(limit = 50): Memory[] {
    const rows = this.database
      .prepare("SELECT id, text, category, createdAt, embedding FROM memories ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as unknown as MemoryRow[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      createdAt: r.createdAt,
      embedding: decodeEmbedding(r.embedding),
    }));
  }

  private genId(): string {
    return randomBytes(6).toString("hex");
  }

  private currentVersion(id: string): number {
    const r = this.database.prepare("SELECT version FROM memories WHERE id = ?").get(id) as { version: number } | undefined;
    return r?.version ?? 0;
  }

  private recordHistory(row: Omit<HistoryRow, "historyId">): void {
    this.database
      .prepare(
        `INSERT INTO memory_history(memoryId, op, oldText, newText, oldCategory, newCategory, reason, model, version, createdAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.memoryId,
        row.op,
        row.oldText,
        row.newText,
        row.oldCategory,
        row.newCategory,
        row.reason,
        row.model,
        row.version,
        row.createdAt,
      );
  }

  getById(id: string): Memory | undefined {
    const r = this.database
      .prepare("SELECT id, text, category, createdAt, embedding FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    if (!r) return undefined;
    return { id: r.id, text: r.text, category: r.category, createdAt: r.createdAt, embedding: decodeEmbedding(r.embedding) };
  }

  // Smart-path add: stable (content-independent) id so UPDATE can change text
  // while keeping the same id; records an ADD history entry.
  async insert(
    text: string,
    category: string | null,
    config: EmbeddingConfig,
    reason: string,
    model?: string | null,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const clean = text.trim();
    const id = this.genId();
    let embedding: number[] | undefined;
    if (config.enabled) [embedding] = await embedTexts([clean], config, signal);
    const now = Date.now();
    this.database
      .prepare("INSERT INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(id, clean, category, now, now, 1, encodeEmbedding(embedding));
    this.cachePut(id, embedding);
    this.recordHistory({
      memoryId: id,
      op: "ADD",
      oldText: null,
      newText: clean,
      oldCategory: null,
      newCategory: category,
      reason,
      model: model ?? null,
      version: 1,
      createdAt: now,
    });
    return { id };
  }

  async update(
    id: string,
    fields: { text?: string; category?: string | null },
    config: EmbeddingConfig,
    reason: string,
    model?: string | null,
    signal?: AbortSignal,
  ): Promise<{ version: number } | undefined> {
    const cur = this.getById(id);
    if (!cur) return undefined;
    const newText = (fields.text ?? cur.text).trim();
    const newCategory = fields.category === undefined ? cur.category : fields.category;
    const version = this.currentVersion(id) + 1;
    const now = Date.now();
    let embedding = cur.embedding;
    if (config.enabled && newText !== cur.text) [embedding] = await embedTexts([newText], config, signal);
    this.database
      .prepare("UPDATE memories SET text = ?, category = ?, updatedAt = ?, version = ?, embedding = ? WHERE id = ?")
      .run(newText, newCategory, now, version, encodeEmbedding(embedding), id);
    this.cachePut(id, embedding);
    this.recordHistory({
      memoryId: id,
      op: "UPDATE",
      oldText: cur.text,
      newText,
      oldCategory: cur.category,
      newCategory,
      reason,
      model: model ?? null,
      version,
      createdAt: now,
    });
    return { version };
  }

  remove(id: string, reason: string, model?: string | null): boolean {
    const cur = this.getById(id);
    if (!cur) return false;
    const version = this.currentVersion(id) + 1;
    const now = Date.now();
    this.database.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.cacheDelete(id);
    this.recordHistory({
      memoryId: id,
      op: "DELETE",
      oldText: cur.text,
      newText: null,
      oldCategory: cur.category,
      newCategory: null,
      reason,
      model: model ?? null,
      version,
      createdAt: now,
    });
    return true;
  }

  history(memoryId?: string, limit = 200): HistoryRow[] {
    const rows = memoryId
      ? this.database.prepare("SELECT * FROM memory_history WHERE memoryId = ? ORDER BY historyId DESC LIMIT ?").all(memoryId, limit)
      : this.database.prepare("SELECT * FROM memory_history ORDER BY historyId DESC LIMIT ?").all(limit);
    return rows as unknown as HistoryRow[];
  }

  // "Undo this change": restore the state BEFORE the selected history entry.
  async rollback(historyId: number, config: EmbeddingConfig, signal?: AbortSignal): Promise<{ id: string } | undefined> {
    const row = this.database.prepare("SELECT * FROM memory_history WHERE historyId = ?").get(historyId) as
      | HistoryRow
      | undefined;
    if (!row) return undefined;
    const cur = this.getById(row.memoryId);
    const now = Date.now();
    if (row.oldText === null) {
      // Undo an ADD → remove (if still present).
      if (cur) {
        const version = this.currentVersion(row.memoryId) + 1;
        this.database.prepare("DELETE FROM memories WHERE id = ?").run(row.memoryId);
        this.cacheDelete(row.memoryId);
        this.recordHistory({
          memoryId: row.memoryId,
          op: "ROLLBACK",
          oldText: cur.text,
          newText: null,
          oldCategory: cur.category,
          newCategory: null,
          reason: `rollback #${historyId}`,
          model: null,
          version,
          createdAt: now,
        });
      }
      return { id: row.memoryId };
    }
    const clean = row.oldText.trim();
    let embedding: number[] | undefined;
    if (config.enabled) [embedding] = await embedTexts([clean], config, signal);
    if (cur) {
      const version = this.currentVersion(row.memoryId) + 1;
      this.database
        .prepare("UPDATE memories SET text = ?, category = ?, updatedAt = ?, version = ?, embedding = ? WHERE id = ?")
        .run(clean, row.oldCategory, now, version, encodeEmbedding(embedding), row.memoryId);
      this.cachePut(row.memoryId, embedding);
      this.recordHistory({
        memoryId: row.memoryId,
        op: "ROLLBACK",
        oldText: cur.text,
        newText: clean,
        oldCategory: cur.category,
        newCategory: row.oldCategory,
        reason: `rollback #${historyId}`,
        model: null,
        version,
        createdAt: now,
      });
    } else {
      this.database
        .prepare("INSERT INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
        .run(row.memoryId, clean, row.oldCategory, now, now, 1, encodeEmbedding(embedding));
      this.cachePut(row.memoryId, embedding);
      this.recordHistory({
        memoryId: row.memoryId,
        op: "ROLLBACK",
        oldText: null,
        newText: clean,
        oldCategory: null,
        newCategory: row.oldCategory,
        reason: `rollback #${historyId}`,
        model: null,
        version: 1,
        createdAt: now,
      });
    }
    return { id: row.memoryId };
  }

  // Idempotent naive path (MEMORY_SMART=0): same text -> same id -> replaces.
  async save(
    text: string,
    category: string | null,
    config: EmbeddingConfig,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const clean = text.trim();
    const id = createHash("sha1").update(clean.toLowerCase()).digest("hex").slice(0, 12);

    let embedding: number[] | undefined;
    if (config.enabled) {
      [embedding] = await embedTexts([clean], config, signal);
    }

    const now = Date.now();
    this.database
      .prepare("INSERT OR REPLACE INTO memories(id, text, category, createdAt, updatedAt, version, embedding) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(id, clean, category, now, now, 1, encodeEmbedding(embedding));
    this.cachePut(id, embedding);
    this.recordHistory({
      memoryId: id,
      op: "ADD",
      oldText: null,
      newText: clean,
      oldCategory: null,
      newCategory: category,
      reason: "save",
      model: null,
      version: 1,
      createdAt: now,
    });

    return { id };
  }

  async recall(
    query: string,
    topK: number,
    config: EmbeddingConfig,
    signal?: AbortSignal,
  ): Promise<MemoryHit[]> {
    const rows = this.database
      .prepare("SELECT id, text, category, createdAt, embedding FROM memories")
      .all() as unknown as MemoryRow[];
    if (!rows.length) return [];

    const memories: Memory[] = rows.map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      createdAt: r.createdAt,
      embedding: decodeEmbedding(r.embedding),
    }));

    const canUseVectors = config.enabled && memories.some((m) => m.embedding);
    let scored: MemoryHit[];

    if (canUseVectors) {
      const [q] = await embedTexts([query], config, signal);
      scored = memories.map((memory) => ({
        memory,
        score: memory.embedding ? cosine(q, memory.embedding) : 0,
      }));
    } else {
      scored = memories.map((memory) => ({
        memory,
        score: keywordScore(query, memory.text),
      }));
    }

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  }
}
