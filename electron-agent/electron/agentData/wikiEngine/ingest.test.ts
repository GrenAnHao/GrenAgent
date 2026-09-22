import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

function fileBlock(path: string, content: string): string {
  return `<<<FILE path="${path}">>>\n${content}\n<<<END>>>`;
}

function conceptAuthPage(): string {
  return `---
type: concept
title: Auth
description: authentication concept
sources:
  - note.md
---

# Auth

Authentication overview.
`;
}

function sourceNotePage(): string {
  return `---
type: source
title: note
description: source summary
sources:
  - note.md
---

# note

Source summary for note.md.
`;
}

function conceptBPage(source = 'b.md'): string {
  return `---
type: concept
title: Beta
description: beta concept
sources:
  - ${source}
---

# Beta

Beta concept.
`;
}

function sourceBPage(): string {
  return `---
type: source
title: b
description: source b
sources:
  - b.md
---

# b

Source summary for b.md.
`;
}

/** Mock complete: FILE blocks on generate; merge/overview behave as labeled. */
function makeComplete(opts?: {
  failSources?: Set<string>;
  failOverview?: boolean;
  onCall?: (system: string, prompt: string, label?: string) => void;
}) {
  let calls = 0;
  const labels: string[] = [];
  const complete = async (system: string, prompt: string, label?: string): Promise<string> => {
    calls += 1;
    labels.push(label ?? '');
    opts?.onCall?.(system, prompt, label);

    if (opts?.failOverview && label === 'overview') {
      throw new Error('overview boom');
    }

    if (label?.startsWith('analysis:')) {
      return 'plan: extract Auth concept and source page';
    }

    if (label?.startsWith('generate:')) {
      const tag = label.slice('generate:'.length);
      const sourceName = tag.split('#')[0];
      if (opts?.failSources?.has(sourceName)) {
        throw new Error(`extract failed: ${sourceName}`);
      }
      if (sourceName === 'note.md' || sourceName.startsWith('note.md')) {
        return (
          fileBlock('wiki/concepts/auth.md', conceptAuthPage()) +
          '\n' +
          fileBlock('wiki/sources/note.md', sourceNotePage())
        );
      }
      if (sourceName === 'b.md' || sourceName.startsWith('b.md')) {
        return (
          fileBlock('wiki/concepts/beta.md', conceptBPage()) +
          '\n' +
          fileBlock('wiki/sources/b.md', sourceBPage())
        );
      }
      if (sourceName === 'merge-small.md' || sourceName.startsWith('merge-small.md')) {
        return fileBlock(
          'wiki/concepts/topic.md',
          `---
type: concept
title: Topic
sources:
  - merge-small.md
---

NEW SMALL
`,
        );
      }
      if (sourceName === 'merge-large.md' || sourceName.startsWith('merge-large.md')) {
        return fileBlock(
          'wiki/concepts/topic.md',
          `---
type: concept
title: Topic
sources:
  - merge-large.md
---

NEW LARGE FRAGMENT
`,
        );
      }
      if (sourceName === 'merge-locked.md' || sourceName.startsWith('merge-locked.md')) {
        return fileBlock(
          'wiki/concepts/topic.md',
          `---
type: concept
title: Topic
sources:
  - merge-locked.md
---

SHOULD NOT APPLY
`,
        );
      }
      return fileBlock(
        'wiki/sources/fallback.md',
        `---
type: source
title: fallback
sources:
  - ${sourceName}
---

fallback
`,
      );
    }

    if (label === 'merge-rewrite') {
      return `---
type: concept
title: Topic
sources:
  - merge-small.md
---

REWRITTEN FULL PAGE
`;
    }

    if (label === 'merge-append') {
      return 'APPENDED INCREMENT';
    }

    if (label === 'overview') {
      return 'This wiki covers Auth and related topics via [[Auth]].';
    }

    return '';
  };
  return {
    complete,
    get calls() {
      return calls;
    },
    get labels() {
      return labels;
    },
  };
}

function assetStatus(db: DatabaseSync, wikiId: string): {
  status: string;
  sync_error: string | null;
  internal_status: string | null;
} {
  return db
    .prepare('SELECT status, sync_error, internal_status FROM wiki_assets WHERE wiki_id = ?')
    .get(wikiId) as {
    status: string;
    sync_error: string | null;
    internal_status: string | null;
  };
}

describe('wiki ingest', () => {
  it('extracts note.md into concepts/auth and sources/note', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete();
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '抽取' });
    service.writeRaw(wiki.wikiId, 'note.md', '# Auth notes\n\nAuthentication matters.');

    const result = await service.ingest(wiki.wikiId);
    expect(result).toEqual({ kind: 'ok' });
    expect(mock.calls).toBeGreaterThan(0);

    const auth = readFileSync(join(wiki.dir, 'wiki/concepts/auth.md'), 'utf8');
    const note = readFileSync(join(wiki.dir, 'wiki/sources/note.md'), 'utf8');
    expect(auth).toContain('Auth');
    expect(note).toContain('note');
    expect(service.listRaw(wiki.wikiId)[0].status).toBe('ingested');
    expect(assetStatus(db, wiki.wikiId).status).toBe('ready');
  });

  it('skips unchanged ingested sources without calling complete again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete();
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '跳过' });
    service.writeRaw(wiki.wikiId, 'note.md', 'same content');
    await service.ingest(wiki.wikiId);
    const afterFirst = mock.calls;

    await service.ingest(wiki.wikiId);
    expect(mock.calls).toBe(afterFirst);
    expect(service.listRaw(wiki.wikiId)[0].status).toBe('ingested');
  });

  it('re-extracts when source is failed even if hash is unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete();
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '失败重抽' });
    service.writeRaw(wiki.wikiId, 'note.md', 'same content');
    await service.ingest(wiki.wikiId);
    const afterFirst = mock.calls;

    const index = new DatabaseSync(join(wiki.dir, 'index.db'));
    index.prepare(`UPDATE source SET status = 'failed', ingest_error = 'boom' WHERE filename = ?`).run(
      'note.md',
    );
    index.close();

    await service.ingest(wiki.wikiId);
    expect(mock.calls).toBeGreaterThan(afterFirst);
    expect(service.listRaw(wiki.wikiId)[0].status).toBe('ingested');
  });

  it('keeps success pages and marks ready when one source fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete({ failSources: new Set(['b.md']) });
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '部分失败' });
    service.writeRaw(wiki.wikiId, 'note.md', 'note body');
    service.writeRaw(wiki.wikiId, 'b.md', 'b body');

    await service.ingest(wiki.wikiId);

    expect(existsSync(join(wiki.dir, 'wiki/concepts/auth.md'))).toBe(true);
    expect(assetStatus(db, wiki.wikiId).status).toBe('ready');
    const rows = service.listRaw(wiki.wikiId);
    expect(rows.find((r) => r.filename === 'note.md')?.status).toBe('ingested');
    expect(rows.find((r) => r.filename === 'b.md')?.status).toBe('failed');
  });

  it('marks library failed when all sources throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete({ failSources: new Set(['note.md', 'b.md']) });
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '全失败' });
    service.writeRaw(wiki.wikiId, 'note.md', 'a');
    service.writeRaw(wiki.wikiId, 'b.md', 'b');

    await expect(service.ingest(wiki.wikiId)).rejects.toThrow(/note\.md|b\.md/);
    const st = assetStatus(db, wiki.wikiId);
    expect(st.status).toBe('failed');
    expect(st.sync_error).toMatch(/note\.md|b\.md/);
  });

  it('rewrites small pages, appends large pages, and skips locked pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const seen: string[] = [];
    const mock = makeComplete({
      onCall: (_s, _p, label) => {
        if (label === 'merge-rewrite' || label === 'merge-append') seen.push(label);
      },
    });
    const service = new WikiService({ root, db, complete: mock.complete });

    // small rewrite
    const small = service.create({ name: '小页重写' });
    writeFileSync(
      join(small.dir, 'wiki/concepts/topic.md'),
      `---
type: concept
title: Topic
sources:
  - old.md
---

OLD SMALL
`,
      'utf8',
    );
    service.writeRaw(small.wikiId, 'merge-small.md', 'new small source');
    await service.ingest(small.wikiId);
    expect(seen).toContain('merge-rewrite');
    expect(readFileSync(join(small.dir, 'wiki/concepts/topic.md'), 'utf8')).toContain(
      'REWRITTEN FULL PAGE',
    );

    // large append
    seen.length = 0;
    const large = service.create({ name: '大页追加' });
    const oldBody = 'X'.repeat(4001);
    writeFileSync(
      join(large.dir, 'wiki/concepts/topic.md'),
      `---
type: concept
title: Topic
sources:
  - old.md
---

${oldBody}
`,
      'utf8',
    );
    service.writeRaw(large.wikiId, 'merge-large.md', 'new large source');
    await service.ingest(large.wikiId);
    expect(seen).toContain('merge-append');
    const largeContent = readFileSync(join(large.dir, 'wiki/concepts/topic.md'), 'utf8');
    expect(largeContent).toContain(oldBody);
    expect(largeContent).toContain('APPENDED INCREMENT');

    // locked skip — source still ingested
    const locked = service.create({ name: '锁定跳过' });
    writeFileSync(
      join(locked.dir, 'wiki/concepts/topic.md'),
      `---
type: concept
title: Topic
locked: true
sources:
  - old.md
---

LOCKED BODY
`,
      'utf8',
    );
    service.writeRaw(locked.wikiId, 'merge-locked.md', 'locked source');
    await service.ingest(locked.wikiId);
    expect(readFileSync(join(locked.dir, 'wiki/concepts/topic.md'), 'utf8')).toContain('LOCKED BODY');
    expect(service.listRaw(locked.wikiId)[0].status).toBe('ingested');
  });

  it('writes overview when enough pages exist, and stays ready if overview fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
    const db = new DatabaseSync(':memory:');
    const mock = makeComplete();
    const service = new WikiService({ root, db, complete: mock.complete });
    const wiki = service.create({ name: '综述' });
    service.writeRaw(wiki.wikiId, 'note.md', 'auth notes');
    await service.ingest(wiki.wikiId);
    expect(existsSync(join(wiki.dir, 'wiki/overview.md'))).toBe(true);
    expect(readFileSync(join(wiki.dir, 'wiki/overview.md'), 'utf8')).toContain('Auth');

    const root2 = mkdtempSync(join(tmpdir(), 'wiki-ingest-ov-'));
    const db2 = new DatabaseSync(':memory:');
    const mock2 = makeComplete({ failOverview: true });
    const service2 = new WikiService({ root: root2, db: db2, complete: mock2.complete });
    const wiki2 = service2.create({ name: '综述失败' });
    service2.writeRaw(wiki2.wikiId, 'note.md', 'auth notes');
    await service2.ingest(wiki2.wikiId);
    expect(assetStatus(db2, wiki2.wikiId).status).toBe('ready');
  });

  it('throws without sources and returns busy while pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-ingest-'));
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
    const empty = service.create({ name: '无原文' });
    await expect(service.ingest(empty.wikiId)).rejects.toThrow();
    expect(calls).toBe(0);

    const busyWiki = service.create({ name: '忙碌' });
    service.writeRaw(busyWiki.wikiId, 'note.md', 'x');
    db.prepare(`UPDATE wiki_assets SET status = 'pending' WHERE wiki_id = ?`).run(busyWiki.wikiId);
    const busy = await service.ingest(busyWiki.wikiId);
    expect(busy).toEqual(
      expect.objectContaining({ kind: 'busy', status: 'pending' }),
    );
    expect(calls).toBe(0);
  });
});
