import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initIndexDb, withWriteDb } from './indexDb';

describe('index.db', () => {
  it('creates the four tables and rolls back a failed write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-index-'));
    initIndexDb(dir);
    const db = new DatabaseSync(join(dir, 'index.db'));
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as Array<{ name: string }>;
    expect(names.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining(['wiki_fts', 'page_meta', 'graph_edge', 'source']),
    );
    db.close();
    expect(() => withWriteDb(dir, (write) => {
      write.prepare(`INSERT INTO page_meta(page_id,title,type,rel_path,snippet) VALUES(?,?,?,?,?)`).run('a', 'A', 'concept', 'wiki/concepts/a.md', '');
      throw new Error('boom');
    })).toThrow('boom');
    const check = new DatabaseSync(join(dir, 'index.db'));
    expect(check.prepare('SELECT COUNT(*) AS n FROM page_meta').get()).toEqual({ n: 0 });
    check.close();
  });
});
