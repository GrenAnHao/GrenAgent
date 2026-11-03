import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { CodeRetrievalResult } from '../../agentData/codeRetrievalResult';
import { indexDataVersion, observeRead } from './readConsistency';

const row = (text: string): CodeRetrievalResult => ({ content: [{ type: 'text', text }], isError: false, structuredContent: { schemaVersion: 1, rows: [], nodes: [], edges: [] } });

describe('observeRead', () => {
  it('retries once when the version changes and marks the result mixed if it changes again', async () => {
    const versions = [1, 2, 3, 4];
    let reads = 0;
    const result = await observeRead(() => versions.shift(), async () => { reads += 1; return row(String(reads)); });
    expect(reads).toBe(2);
    expect(result.content[0].text).toBe('2');
    expect(result.structuredContent.meta).toEqual({ consistency: 'mixed' });
  });

  it('keeps the retried result when the second attempt is stable', async () => {
    const versions = [1, 2, 5, 5];
    let reads = 0;
    const result = await observeRead(() => versions.shift(), async () => { reads += 1; return row('ok'); });
    expect(reads).toBe(2);
    expect(result.structuredContent.meta).toBeUndefined();
  });

  it('sees a commit on a long-lived read-only connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-version-'));
    const root = dir;
    const file = join(root, '.codegraph', 'codegraph.db');
    try {
      mkdirSync(join(root, '.codegraph'));
      const writer = new DatabaseSync(file);
      writer.exec('PRAGMA journal_mode=WAL');
      writer.exec('CREATE TABLE t(x)');
      const cache = new Map<string, DatabaseSync>();
      const before = indexDataVersion(root, cache);
      writer.exec('INSERT INTO t VALUES (1)');
      const after = indexDataVersion(root, cache);
      expect(after).toBeGreaterThan(before!);
      writer.close();
      for (const db of cache.values()) db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
