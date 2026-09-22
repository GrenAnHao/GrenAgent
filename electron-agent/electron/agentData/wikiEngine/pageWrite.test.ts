import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

function makeService() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-page-'));
  const db = new DatabaseSync(':memory:');
  const service = new WikiService({ root, db, complete: async () => '' });
  return { root, db, service };
}

describe('wiki page write', () => {
  it('injects locked true and rejects structural pages and escapes', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '产品' });
    const written = service.writePage(wiki.wikiId, 'concepts/auth', '# 权限');
    expect(written.lockedInjected).toBe(true);
    expect(service.readPage(wiki.wikiId, 'concepts/auth')).toContain('locked: true');
    expect(() => service.writePage(wiki.wikiId, 'purpose', 'x')).toThrow(/forbidden_path/);
    expect(() => service.removePage(wiki.wikiId, 'schema.md')).toThrow(/forbidden_path/);
    expect(() => service.writePage(wiki.wikiId, '../outside', 'x')).toThrow(/invalid_path/);
    expect(() => service.writePage(wiki.wikiId, 'concepts/big', 'x'.repeat(512 * 1024 + 1))).toThrow(
      /too_large/,
    );
  });

  it('rejects wiki/purpose.md and index.md and purpose as forbidden', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '结构拒绝' });
    expect(() => service.writePage(wiki.wikiId, 'wiki/purpose.md', 'x')).toThrow(/forbidden_path/);
    expect(() => service.writePage(wiki.wikiId, 'index.md', 'x')).toThrow(/forbidden_path/);
    expect(() => service.writePage(wiki.wikiId, 'purpose', 'x')).toThrow(/forbidden_path/);
    expect(() => service.removePage(wiki.wikiId, 'wiki/index')).toThrow(/forbidden_path/);
  });

  it('allows writing log and reads back locked true', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '日志页' });
    const written = service.writePage(wiki.wikiId, 'log', '# log body');
    expect(written.lockedInjected).toBe(true);
    expect(service.readPage(wiki.wikiId, 'log')).toContain('locked: true');
  });

  it('listPages is empty in draft but readPage returns written content', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '草稿可读' });
    expect(wiki.status).toBe('draft');
    service.writePage(wiki.wikiId, 'concepts/auth', '# 权限');
    expect(service.listPages(wiki.wikiId)).toEqual([]);
    expect(service.readPage(wiki.wikiId, 'concepts/auth')).toContain('# 权限');
  });

  it('indexes concepts/auth into page_meta after write', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '索引页' });
    service.writePage(wiki.wikiId, 'concepts/auth', '# 权限');
    const index = new DatabaseSync(join(wiki.dir, 'index.db'));
    try {
      const row = index
        .prepare('SELECT page_id, title FROM page_meta WHERE page_id = ?')
        .get('concepts/auth') as { page_id: string; title: string } | undefined;
      expect(row).toEqual(expect.objectContaining({ page_id: 'concepts/auth' }));
    } finally {
      index.close();
    }
  });

  it('rejects batches over 20 for writePages readPages removePages', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '批量上限' });
    const pages = Array.from({ length: 21 }, (_, i) => ({
      ref: `concepts/p${i}`,
      content: `# p${i}`,
    }));
    expect(() => service.writePages(wiki.wikiId, pages)).toThrow(/20/);
    const refs = pages.map((p) => p.ref);
    expect(() => service.readPages(wiki.wikiId, refs)).toThrow(/20/);
    expect(() => service.removePages(wiki.wikiId, refs)).toThrow(/20/);
  });

  it('throws not_found for missing wiki or missing page', () => {
    const { service } = makeService();
    expect(() => service.readPage('missing-wiki-id', 'concepts/auth')).toThrow(/not_found/);
    const wiki = service.create({ name: '缺页' });
    expect(() => service.readPage(wiki.wikiId, 'concepts/missing')).toThrow(/not_found/);
  });

  it('rejects write and remove while processing', () => {
    const { service, db } = makeService();
    const wiki = service.create({ name: '处理中' });
    db.prepare(`UPDATE wiki_assets SET status = 'processing' WHERE wiki_id = ?`).run(wiki.wikiId);
    expect(() => service.writePage(wiki.wikiId, 'concepts/auth', 'x')).toThrow(/processing/);
    expect(() => service.removePage(wiki.wikiId, 'concepts/auth')).toThrow(/processing/);
  });
});
