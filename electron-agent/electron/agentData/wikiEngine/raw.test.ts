import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

describe('wiki raw sources', () => {
  it('records uploaded sources and does not call the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    let calls = 0;
    const service = new WikiService({
      root,
      db,
      complete: async () => {
        calls += 1;
        return '';
      },
    });
    const wiki = service.create({ name: '产品' });
    service.writeRaw(wiki.wikiId, 'note.md', '第一版');
    service.writeRaw(wiki.wikiId, 'note.md', '第一版');
    service.writeRaw(wiki.wikiId, 'note.md', '第二版');
    const rows = service.listRaw(wiki.wikiId);
    expect(rows).toEqual([expect.objectContaining({ filename: 'note.md', status: 'uploaded' })]);
    expect(calls).toBe(0);
    expect(() => service.writeRaw(wiki.wikiId, 'big.md', 'x'.repeat(5 * 1024 * 1024 + 1))).toThrow(
      /too_large/,
    );
  });

  it('keeps ingested status and created_at when sha256 is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: '哈希未变' });
    service.writeRaw(wiki.wikiId, 'note.md', '同一内容');
    const before = service.listRaw(wiki.wikiId)[0];
    expect(before.status).toBe('uploaded');

    const index = new DatabaseSync(join(wiki.dir, 'index.db'));
    index
      .prepare(`UPDATE source SET status = 'ingested', ingest_error = 'boom' WHERE filename = ?`)
      .run('note.md');
    index.close();

    service.writeRaw(wiki.wikiId, 'note.md', '同一内容');
    const after = service.listRaw(wiki.wikiId)[0];
    expect(after.status).toBe('ingested');
    expect(after.ingest_error).toBe('boom');
    expect(after.created_at).toBe(before.created_at);
  });

  it('resets to uploaded and clears ingest_error when sha256 changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: '哈希变化' });
    service.writeRaw(wiki.wikiId, 'note.md', '旧内容');
    const before = service.listRaw(wiki.wikiId)[0];

    const index = new DatabaseSync(join(wiki.dir, 'index.db'));
    index
      .prepare(`UPDATE source SET status = 'ingested', ingest_error = 'boom' WHERE filename = ?`)
      .run('note.md');
    index.close();

    service.writeRaw(wiki.wikiId, 'note.md', '新内容');
    const after = service.listRaw(wiki.wikiId)[0];
    expect(after.status).toBe('uploaded');
    expect(after.ingest_error).toBeNull();
    expect(after.created_at).toBe(before.created_at);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('rejects more than 50 files in writeRawMany', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: '批量上限' });
    const files = Array.from({ length: 51 }, (_, i) => ({
      filename: `f${i}.md`,
      content: 'x',
    }));
    expect(() => service.writeRawMany(wiki.wikiId, files)).toThrow(/50/);
  });

  it('rejects write and remove while processing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: '处理中' });
    service.writeRaw(wiki.wikiId, 'keep.md', 'ok');
    db.prepare(`UPDATE wiki_assets SET status = 'processing' WHERE wiki_id = ?`).run(wiki.wikiId);

    expect(() => service.writeRaw(wiki.wikiId, 'a.md', 'x')).toThrow(/processing/);
    expect(() => service.writeRawMany(wiki.wikiId, [{ filename: 'b.md', content: 'x' }])).toThrow(
      /processing/,
    );
    expect(() => service.removeRaw(wiki.wikiId, 'keep.md')).toThrow(/processing/);
  });

  it('allows removeRaw while draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-raw-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: '草稿可删' });
    expect(wiki.status).toBe('draft');
    service.writeRaw(wiki.wikiId, 'gone.md', 'bye');
    expect(service.listRaw(wiki.wikiId)).toHaveLength(1);
    service.removeRaw(wiki.wikiId, 'gone.md');
    expect(service.listRaw(wiki.wikiId)).toEqual([]);
  });
});
