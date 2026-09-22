import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ftsSearch, initIndexDb, tokenize, writeIndex } from './indexDb';

describe('wiki search index', () => {
  it('tokenizes CJK as bigrams and ranks a title hit above body-only text', () => {
    expect(tokenize('权限模型')).toEqual(expect.arrayContaining(['权限', '限模', '模型', '权限模型']));
    const dir = mkdtempSync(join(tmpdir(), 'wiki-fts-'));
    initIndexDb(dir);
    writeIndex(dir, [
      { id: 'title', title: '权限模型', type: 'concept', relPath: 'wiki/concepts/auth.md', content: '其他', links: [] },
      { id: 'body', title: '其他', type: 'concept', relPath: 'wiki/concepts/other.md', content: '权限模型在正文', links: [] },
    ]);
    const hits = ftsSearch(dir, '权限模型', 10);
    expect(hits[0].id).toBe('title');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });
});
