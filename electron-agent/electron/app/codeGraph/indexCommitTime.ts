import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIndexed } from './indexProbe';

// Desktop-owned metadata lives with the index it describes, not with a path in
// application settings. Replacing/removing the database also replaces/removes this receipt.
const COMMIT_KEY = 'grenagent.last_content_commit';
const database = (workspace: string) => join(workspace, '.codegraph', 'codegraph.db');

export function recordIndexCommit(workspace: string): void {
  if (!isIndexed(workspace)) return;
  let db: DatabaseSync | undefined;
  try {
    // mode=rw opens an existing DB only. Never recreate a database removed by another tool.
    db = new DatabaseSync(pathToFileURL(database(workspace)).href + '?mode=rw', { timeout: 500 });
    const at = Date.now();
    db.prepare(
      `INSERT INTO project_metadata(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).run(COMMIT_KEY, 'complete', at);
  } catch (error) {
    // The SDK has already committed. A receipt failure cannot undo that work.
    console.warn('[codegraph] could not record the index completion time:', error);
  } finally {
    db?.close();
  }
}

export function indexCommitTime(workspace: string, fileTime: number | null, complete: boolean): number | null {
  // Older/CLI indexes have no desktop receipt. The SDK stamps a completed full
  // build in project_metadata even when unchanged files keep their old indexed_at.
  let at = complete ? (fileTime ?? 0) : 0;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(database(workspace), { readOnly: true });
    const stamp = db
      .prepare(
        `SELECT MAX(updated_at) AS at FROM project_metadata
      WHERE key IN (?, 'index_state') AND value='complete'`,
      )
      .get(COMMIT_KEY)?.at;
    if (typeof stamp === 'number') at = Math.max(at, stamp);
  } catch {
    // Older schemas can still have a real per-file timestamp; never use the check clock.
  } finally {
    db?.close();
  }
  return at > 0 ? at : null;
}
