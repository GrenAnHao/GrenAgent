import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

function makeService() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-gates-'));
  const db = new DatabaseSync(':memory:');
  const service = new WikiService({ root, db, complete: async () => '' });
  return { root, db, service };
}

function setStatus(db: DatabaseSync, wikiId: string, status: string): void {
  db.prepare(`UPDATE wiki_assets SET status = ? WHERE wiki_id = ?`).run(status, wikiId);
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object' && 'results' in value) {
    return Array.isArray((value as { results: unknown }).results) &&
      (value as { results: unknown[] }).results.length === 0;
  }
  return false;
}

describe('wiki status gates', () => {
  it('allows raw and page write/remove for draft pending ready failed', () => {
    const { service, db } = makeService();
    const wiki = service.create({ name: '写入门' });

    for (const status of ['draft', 'pending', 'ready', 'failed'] as const) {
      setStatus(db, wiki.wikiId, status);
      const rawName = `src-${status}.md`;
      const pageRef = `concepts/page-${status}`;

      expect(() => service.writeRaw(wiki.wikiId, rawName, `body-${status}`)).not.toThrow();
      expect(() => service.removeRaw(wiki.wikiId, rawName)).not.toThrow();
      expect(() => service.writePage(wiki.wikiId, pageRef, `# ${status}`)).not.toThrow();
      expect(() => service.removePage(wiki.wikiId, pageRef)).not.toThrow();
    }

    expect(existsSync(join(wiki.dir, 'wiki/purpose.md'))).toBe(true);
    expect(existsSync(join(wiki.dir, 'wiki/schema.md'))).toBe(true);
    expect(existsSync(join(wiki.dir, 'wiki/index.md'))).toBe(true);
  });

  it('rejects raw and page write/remove while processing', () => {
    const { service, db } = makeService();
    const wiki = service.create({ name: '处理中拒绝' });
    service.writeRaw(wiki.wikiId, 'keep.md', 'ok');
    service.writePage(wiki.wikiId, 'concepts/keep', '# keep');
    setStatus(db, wiki.wikiId, 'processing');

    expect(() => service.writeRaw(wiki.wikiId, 'a.md', 'x')).toThrow(/processing/);
    expect(() => service.removeRaw(wiki.wikiId, 'keep.md')).toThrow(/processing/);
    expect(() => service.writePage(wiki.wikiId, 'concepts/a', 'x')).toThrow(/processing/);
    expect(() => service.removePage(wiki.wikiId, 'concepts/keep')).toThrow(/processing/);
  });

  it('returns empty listPages search graph when not ready but listRaw and readPage still work', () => {
    const { service, db } = makeService();
    const wiki = service.create({ name: '非 ready 空读' });
    service.writeRaw(wiki.wikiId, 'note.md', '原文');
    service.writePage(wiki.wikiId, 'concepts/auth', '# 权限');

    for (const status of ['draft', 'pending', 'processing', 'failed'] as const) {
      setStatus(db, wiki.wikiId, status);
      expect(service.listPages(wiki.wikiId)).toEqual([]);
      expect(isEmpty(service.search(wiki.wikiId, '权限'))).toBe(true);
      expect(isEmpty(service.graph(wiki.wikiId))).toBe(true);
      expect(service.listRaw(wiki.wikiId)).toEqual([
        expect.objectContaining({ filename: 'note.md', status: 'uploaded' }),
      ]);
      expect(service.readPage(wiki.wikiId, 'concepts/auth')).toContain('# 权限');
    }
  });

  it('resetDraft clears processing fields without deleting files or rewriting on construct', () => {
    const { service, db, root } = makeService();
    const wiki = service.create({ name: '重置草稿' });
    const purposeBefore = readFileSync(join(wiki.dir, 'wiki/purpose.md'), 'utf8');

    db.prepare(
      `UPDATE wiki_assets SET status = 'processing', internal_status = 'ingesting', sync_error = 'boom' WHERE wiki_id = ?`,
    ).run(wiki.wikiId);

    service.resetDraft(wiki.wikiId);

    const row = db
      .prepare('SELECT status, internal_status, sync_error FROM wiki_assets WHERE wiki_id = ?')
      .get(wiki.wikiId) as {
      status: string;
      internal_status: string | null;
      sync_error: string | null;
    };
    expect(row).toEqual({
      status: 'draft',
      internal_status: null,
      sync_error: null,
    });
    expect(readFileSync(join(wiki.dir, 'wiki/purpose.md'), 'utf8')).toBe(purposeBefore);
    expect(existsSync(join(wiki.dir, 'index.db'))).toBe(true);

    db.prepare(
      `UPDATE wiki_assets SET status = 'processing', internal_status = 'scanning', sync_error = 'stuck' WHERE wiki_id = ?`,
    ).run(wiki.wikiId);

    const again = new WikiService({ root, db, complete: async () => '' });
    const stuck = db
      .prepare('SELECT status, internal_status, sync_error FROM wiki_assets WHERE wiki_id = ?')
      .get(wiki.wikiId) as {
      status: string;
      internal_status: string | null;
      sync_error: string | null;
    };
    expect(stuck.status).toBe('processing');
    expect(stuck.internal_status).toBe('scanning');
    expect(stuck.sync_error).toBe('stuck');
    void again;
  });

  it('throws not_found for missing wiki on read list search and graph', () => {
    const { service } = makeService();
    const missing = 'missing-wiki-id';
    expect(() => service.readPage(missing, 'concepts/auth')).toThrow(/not_found/);
    expect(() => service.listPages(missing)).toThrow(/not_found/);
    expect(() => service.listRaw(missing)).toThrow(/not_found/);
    expect(() => service.search(missing, 'x')).toThrow(/not_found/);
    expect(() => service.graph(missing)).toThrow(/not_found/);
  });
});
