import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WikiService } from './service';

describe('create wiki', () => {
  it('writes default templates, four tables, and a draft row without overwriting templates', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-root-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => 'unused' });
    const created = service.create({ name: '产品' });
    expect(created.status).toBe('draft');
    expect(existsSync(join(created.dir, 'wiki/purpose.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'wiki/schema.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'wiki/index.md'))).toBe(true);
    expect(existsSync(join(created.dir, 'raw/sources'))).toBe(true);
    expect(existsSync(join(created.dir, '.llm-wiki'))).toBe(true);
    expect(existsSync(join(created.dir, 'index.db'))).toBe(true);
    writeFileSync(join(created.dir, 'wiki/purpose.md'), '自定义', 'utf8');
    const again = service.create({ name: '产品' });
    expect(again.wikiId).toBe(created.wikiId);
    expect(again.status).toBe('draft');
    expect(readFileSync(join(created.dir, 'wiki/purpose.md'), 'utf8')).toBe('自定义');
  });

  it('rejects a dot wikiId and does not write index.db under root', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-root-'));
    const db = new DatabaseSync(':memory:');
    const service = new WikiService({ root, db, complete: async () => 'unused' });
    expect(() => service.create({ name: '坏', wikiId: '.' })).toThrow();
    expect(existsSync(join(root, 'index.db'))).toBe(false);
  });
});
