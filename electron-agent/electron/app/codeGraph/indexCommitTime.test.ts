import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { indexCommitTime, recordIndexCommit } from './indexCommitTime';

it('reads each index’s own completed build, never its check time or unfinished file rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'gren-index-timestamps-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    for (const [path, at] of [
      [a, 2000],
      [b, 8000],
    ] as const) {
      mkdirSync(join(path, '.codegraph'), { recursive: true });
      const db = new DatabaseSync(join(path, '.codegraph/codegraph.db'));
      db.exec('CREATE TABLE project_metadata(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
      db.prepare('INSERT INTO project_metadata VALUES(?,?,?)').run('index_state', 'complete', at);
      db.close();
    }
    expect(indexCommitTime(a, 100, true)).toBe(2000);
    expect(indexCommitTime(b, null, true)).toBe(8000);
    expect(indexCommitTime(a, 3000, true)).toBe(3000); // newer CLI incremental write
    expect(indexCommitTime(a, 100, true)).toBe(2000); // reading does not write
    recordIndexCommit(a);
    const committed = indexCommitTime(a, 100, true)!;
    const db = new DatabaseSync(join(a, '.codegraph/codegraph.db'));
    db.exec("UPDATE project_metadata SET value='partial' WHERE key='index_state'");
    db.close();
    expect(indexCommitTime(a, committed + 10_000, false)).toBe(committed);
    expect(indexCommitTime(b, null, true)).toBe(8000);
    const missing = join(root, 'not-indexed');
    expect(indexCommitTime(missing, null, true)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
