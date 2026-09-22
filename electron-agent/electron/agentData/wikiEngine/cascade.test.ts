import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

function makeService() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-cascade-'));
  const db = new DatabaseSync(':memory:');
  const service = new WikiService({ root, db, complete: async () => '' });
  return { root, db, service };
}

describe('wiki delete cascade', () => {
  it('removeRaw deletes exclusive pages and rewrites shared sources; skips purpose.md', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '级联删原文' });

    service.writeRaw(wiki.wikiId, 'note.md', 'note body');
    service.writeRaw(wiki.wikiId, 'other.md', 'other body');

    service.writePage(
      wiki.wikiId,
      'entities/A',
      `---
type: entity
title: A
sources:
  - note.md
---

# A
`,
    );
    service.writePage(
      wiki.wikiId,
      'entities/B',
      `---
type: entity
title: B
sources:
  - note.md
  - other.md
---

# B
`,
    );

    const purposePath = join(wiki.dir, 'wiki/purpose.md');
    const purposeBefore = `---
type: purpose
title: Wiki Purpose
sources:
  - note.md
---

# Purpose with note source
`;
    writeFileSync(purposePath, purposeBefore, 'utf8');

    service.removeRaw(wiki.wikiId, 'note.md');

    expect(existsSync(join(wiki.dir, 'wiki/entities/A.md'))).toBe(false);
    expect(existsSync(join(wiki.dir, 'wiki/entities/B.md'))).toBe(true);
    const bContent = readFileSync(join(wiki.dir, 'wiki/entities/B.md'), 'utf8');
    expect(bContent).toContain('other.md');
    expect(bContent).not.toMatch(/^\s*-\s*note\.md\s*$/m);
    expect(readFileSync(purposePath, 'utf8')).toBe(purposeBefore);
    expect(service.listRaw(wiki.wikiId).map((r) => r.filename)).toEqual(['other.md']);
  });

  it('removePage clears dangling wikilinks to display text; leaves index.md alone', () => {
    const { service } = makeService();
    const wiki = service.create({ name: '级联删页' });

    service.writePage(
      wiki.wikiId,
      'entities/A',
      `---
type: entity
title: A
---

# A
`,
    );
    service.writePage(
      wiki.wikiId,
      'entities/C',
      `---
type: entity
title: C
---

See [[A]] here.
`,
    );

    const indexPath = join(wiki.dir, 'wiki/index.md');
    const indexWithLink = `---
type: index
title: Index
---

# Index

[[A]]
`;
    writeFileSync(indexPath, indexWithLink, 'utf8');

    service.removePage(wiki.wikiId, 'entities/A');

    expect(existsSync(join(wiki.dir, 'wiki/entities/A.md'))).toBe(false);
    const cContent = readFileSync(join(wiki.dir, 'wiki/entities/C.md'), 'utf8');
    expect(cContent).not.toContain('[[A]]');
    expect(cContent).toContain('See A here.');
    expect(readFileSync(indexPath, 'utf8')).toContain('[[A]]');
  });
});
