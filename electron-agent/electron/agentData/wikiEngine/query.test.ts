import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

function pageId(path: string): string {
  return path.replace(/^wiki\//, '').replace(/\.md$/, '');
}

describe('wiki query search and cancel ingest', () => {
  it('expands hop search with decay via related and links', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-query-hop-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: 'hop-search' });

    // Page ids stay A/B; titles avoid FTS stop-words (bare "A" tokenizes to empty).
    service.writePage(
      wiki.wikiId,
      'A',
      `---
type: concept
title: Alpha
---

Alpha links to [[B]].
`,
    );
    service.writePage(
      wiki.wikiId,
      'B',
      `---
type: concept
title: Beta
---

Body of Beta.
`,
    );
    db.prepare(`UPDATE wiki_assets SET status = 'ready' WHERE wiki_id = ?`).run(wiki.wikiId);

    const hop0 = service.search(wiki.wikiId, 'Alpha', { hop: 0 });
    expect(hop0.results.map((r) => pageId(r.path))).toEqual(['A']);
    for (const r of hop0.results) {
      expect(r).toEqual(
        expect.objectContaining({
          path: expect.any(String),
          title: expect.any(String),
          snippet: expect.any(String),
          score: expect.any(Number),
          type: expect.any(String),
          hop: 0,
          related: expect.any(Array),
        }),
      );
      expect(r.related!.length).toBeLessThanOrEqual(10);
    }
    expect(hop0.links).toEqual(expect.any(Array));

    const hop1 = service.search(wiki.wikiId, 'Alpha', { hop: 1, decay: 0.5 });
    const ids = hop1.results.map((r) => pageId(r.path));
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    const hitA = hop1.results.find((r) => pageId(r.path) === 'A')!;
    const hitB = hop1.results.find((r) => pageId(r.path) === 'B')!;
    expect(hitB.score).toBeCloseTo(hitA.score * 0.5, 5);
    expect(hitB.via).toBe('Alpha');
    expect(hitB.hop).toBe(1);
    expect(hitB.related!.length).toBeLessThanOrEqual(10);
    expect(hop1.links.some((l) => pageId(l.source) === 'A' && pageId(l.target) === 'B')).toBe(true);
  });

  it('writePage rebuilds index so search and graph see [[A]] without ingest', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-query-write-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => '' });
    const wiki = service.create({ name: 'write-index' });

    service.writePage(
      wiki.wikiId,
      'A',
      `---
type: concept
title: Alpha
---

Anchor Alpha.
`,
    );
    service.writePage(
      wiki.wikiId,
      'concepts/new-page',
      `---
type: concept
title: New Page
---

Links to [[A]].
`,
    );
    db.prepare(`UPDATE wiki_assets SET status = 'ready' WHERE wiki_id = ?`).run(wiki.wikiId);

    const found = service.search(wiki.wikiId, 'New');
    expect(found.results.some((r) => pageId(r.path) === 'concepts/new-page')).toBe(true);
    const edges = service.graph(wiki.wikiId);
    expect(
      edges.some(
        (e) => e.source_id === 'concepts/new-page' && e.target_id === 'A',
      ),
    ).toBe(true);
  });

  it('remove during ingest before model returns cleans wiki without ready or failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-query-cancel-'));
    const db = new DatabaseSync(':memory:');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const complete = async (): Promise<string> => {
      entered();
      await gate;
      return '<<<FILE path="wiki/concepts/auth.md">>>\n---\ntype: concept\ntitle: Auth\n---\n# Auth\n<<<END>>>';
    };

    const service = new WikiService({ root, db, complete });
    const wiki = service.create({ name: 'cancel-ingest' });
    service.writeRaw(wiki.wikiId, 'note.md', '# note\n\nContent for ingest.');

    const ingestPromise = service.ingest(wiki.wikiId);
    await enteredPromise;
    service.remove(wiki.wikiId);
    release();
    await ingestPromise;

    expect(() => service.readPage(wiki.wikiId, 'concepts/auth')).toThrow(/not_found/);
    expect(existsSync(wiki.dir)).toBe(false);
    const row = db.prepare('SELECT status FROM wiki_assets WHERE wiki_id = ?').get(wiki.wikiId) as
      | { status: string }
      | undefined;
    expect(row).toBeUndefined();
  });
});
