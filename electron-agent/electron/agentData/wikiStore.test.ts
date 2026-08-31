import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { WikiStore, chunkMarkdown } from './wikiStore';

describe('WikiStore', () => {
  it('chunks markdown with headings and source lines', () => { const chunks = chunkMarkdown('# Intro\nhello\n## API\nworld', 'README.md'); expect(chunks).toHaveLength(2); expect(chunks[1]).toMatchObject({ title: 'API', startLine: 3, endLine: 4 }); });
  it('replaces and searches pages by workspace', () => { const db = new DatabaseSync(':memory:'); const store = new WikiStore(db); store.replacePage({ workspace: '/a' }, 'guide', 'Guide', '# API\nsearchable'); store.replacePage({ workspace: '/b' }, 'guide', 'Guide', '# API\nsearchable'); expect(store.search({ workspace: '/a' }, 'searchable')).toHaveLength(1); expect(store.search({ workspace: '/c' }, 'searchable')).toHaveLength(0); db.close(); });
  it('keeps the previous page when the replacement transaction fails', () => {
    const db = new DatabaseSync(':memory:'); const store = new WikiStore(db);
    store.replacePage({ workspace: '/a' }, 'guide', 'Old', 'old body');
    db.exec('DROP TABLE wiki_fts');
    expect(() => store.replacePage({ workspace: '/a' }, 'guide', 'New', 'new body')).toThrow();
    const row = db.prepare('SELECT title, content FROM wiki_pages WHERE workspace=? AND page=?').get('/a', 'guide') as { title: string; content: string };
    expect(row).toEqual({ title: 'Old', content: 'old body' });
    db.close();
  });
});
