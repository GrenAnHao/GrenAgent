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

  it('searches every workspace when no workspace is supplied and reports each page origin', () => {
    const db = new DatabaseSync(':memory:'); const store = new WikiStore(db);
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide A', '# API\nsearchable alpha');
    store.replacePage({ workspace: '/b' }, 'guide', 'Guide B', '# API\nsearchable beta');

    const all = store.search({}, 'searchable');
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.workspace).sort()).toEqual(['/a', '/b']);
    expect(store.search({ workspace: '/a' }, 'searchable')).toHaveLength(1);
    db.close();
  });

  it('aggregates the overview across every workspace when scoped globally', () => {
    const db = new DatabaseSync(':memory:'); const store = new WikiStore(db);
    store.replacePage({ workspace: '/a' }, 'one', 'One', 'body');
    store.replacePage({ workspace: '/b' }, 'two', 'Two', 'body');

    expect(store.overview({})).toMatchObject({ pages: 2 });
    expect(store.overview({ workspace: '/a' })).toMatchObject({ pages: 1 });
    db.close();
  });
});
