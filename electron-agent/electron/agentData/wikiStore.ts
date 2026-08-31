import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface WikiScope { workspace: string }
export interface WikiChunk { id: string; page: string; title: string; content: string; sourcePath: string; startLine: number; endLine: number; hash: string }
export interface WikiOverview { pages: number; latestUpdatedAt: number | null }

export class WikiStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS wiki_pages (workspace TEXT NOT NULL, page TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source_path TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace,page));
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(workspace UNINDEXED, page UNINDEXED, title, content);`);
  }

  replacePage(scope: WikiScope, page: string, title: string, content: string, sourcePath = page): WikiChunk[] {
    const chunks = chunkMarkdown(content, sourcePath, title).map((chunk) => ({ ...chunk, id: createHash('sha256').update(`${scope.workspace}:${page}:${chunk.hash}`).digest('hex').slice(0, 32), page }));
    this.db.exec('BEGIN');
    try {
      const tx = this.db.prepare('INSERT INTO wiki_pages(workspace,page,title,content,source_path,content_hash,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace,page) DO UPDATE SET title=excluded.title,content=excluded.content,source_path=excluded.source_path,content_hash=excluded.content_hash,updated_at=excluded.updated_at');
      tx.run(scope.workspace, page, title, content, sourcePath, hash(content), Date.now());
      this.db.prepare('DELETE FROM wiki_fts WHERE workspace=? AND page=?').run(scope.workspace, page);
      this.db.prepare('INSERT INTO wiki_fts(workspace,page,title,content) VALUES(?,?,?,?)').run(scope.workspace, page, title, content);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return chunks;
  }

  search(scope: WikiScope, query: string, limit = 20): Array<{ page: string; title: string; snippet: string }> {
    const rows = this.db.prepare("SELECT page,title,snippet(wiki_fts,3,'', '', '...', 24) as snippet FROM wiki_fts WHERE workspace=? AND wiki_fts MATCH ? LIMIT ?").all(scope.workspace, query.trim(), Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ page: String(row.page), title: String(row.title), snippet: String(row.snippet) }));
  }

  overview(scope: WikiScope): WikiOverview {
    const row = this.db.prepare('SELECT count(*) as pages, max(updated_at) as latestUpdatedAt FROM wiki_pages WHERE workspace=?').get(scope.workspace) as { pages: number; latestUpdatedAt: number | null };
    return { pages: Number(row.pages), latestUpdatedAt: row.latestUpdatedAt == null ? null : Number(row.latestUpdatedAt) };
  }

  deleteWorkspace(scope: WikiScope): void { this.db.prepare('DELETE FROM wiki_pages WHERE workspace=?').run(scope.workspace); this.db.prepare('DELETE FROM wiki_fts WHERE workspace=?').run(scope.workspace); }
}

export function chunkMarkdown(content: string, sourcePath: string, fallbackTitle = 'Untitled'): Array<Omit<WikiChunk, 'id' | 'page'>> {
  const lines = content.split(/\r?\n/); const chunks: Array<Omit<WikiChunk, 'id' | 'page'>> = []; let start = 0; let title = fallbackTitle;
  const flush = (end: number) => { const body = lines.slice(start, end).join('\n').trim(); if (!body) return; chunks.push({ title, content: body, sourcePath, startLine: start + 1, endLine: end, hash: hash(body) }); };
  lines.forEach((line, index) => { const heading = /^(#{1,6})\s+(.+)$/.exec(line); if (!heading) return; flush(index); title = heading[2].trim(); start = index; }); flush(lines.length); return chunks;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
