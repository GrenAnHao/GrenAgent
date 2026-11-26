import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from './workspaceService.js';

// Bump on any change to the parser's summary semantics (titles, hidden sessions, transfer roots, etc.).
const VERSION = 1;
export const SESSION_SUMMARY_FILENAME = 'session-summaries.v1.json';
type Stamp = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev'>;
interface Row extends Stamp { path: string; value: SessionRecord | null }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
function validRow(v: unknown): v is Row {
  if (!object(v) || typeof v.path !== 'string' || !['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(k => Number.isFinite(v[k]))) return false;
  if (v.value === null) return true;
  const r = v.value;
  return object(r) && typeof r.hidden === 'boolean' && object(r.info) && r.info.path === v.path &&
    typeof r.info.id === 'string' && nullableString(r.info.cwd) && nullableString(r.info.timestamp) && nullableString(r.info.name) &&
    r.info.archived === undefined && Array.isArray(r.retentionRoots) && r.retentionRoots.every(root => typeof root === 'string') &&
    r.subagent === undefined;
}

/** Only callers that already enumerated/stat'ed a source file may look up its display summary.
 * Never use a disk hit as authority to open, edit or delete anything. */
export class SessionSummaryCache {
  private readonly path: string;
  private readonly rows = new Map<string, Row>();
  private opened?: Promise<void>;
  private revision = 0;
  private saved = 0;
  private saving = Promise.resolve();

  constructor(agentDir: string) { this.path = join(agentDir, SESSION_SUMMARY_FILENAME); }

  open(): Promise<void> { return this.opened ??= this.load(); }

  private async load(): Promise<void> {
    try {
      const doc: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!object(doc) || doc.version !== VERSION || !Array.isArray(doc.rows)) return;
      for (const row of doc.rows) {
        if (validRow(row)) this.rows.set(row.path, row);
      }
    } catch { /* Absence, unreadable or malformed: JSONL is the source. */ }
  }

  get(path: string, s: Stamp): SessionRecord | null | undefined {
    const r = this.rows.get(path);
    return r && r.size === s.size && r.mtimeMs === s.mtimeMs && r.ctimeMs === s.ctimeMs && r.ino === s.ino && r.dev === s.dev
      ? r.value : undefined;
  }

  put(path: string, s: Stamp, value: SessionRecord | null): void {
    const summary = value && {
      info: { ...value.info, name: value.hidden ? null : value.info.name }, hidden: value.hidden, retentionRoots: value.retentionRoots,
    };
    const previous = this.get(path, s);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(summary)) return;
    const row: Row = { path, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev, value: summary };
    this.rows.set(path, row);
    this.revision++;
  }

  drop(path: string): void { if (this.rows.delete(path)) this.revision++; }

  keepOnly(present: Set<string>): void {
    for (const key of this.rows.keys()) if (!present.has(key)) this.drop(key);
  }

  /** Coalesce concurrent list completions; no per-file rewrites and no torn published index. */
  flush(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const revision = this.revision;
      if (this.saved === revision) return;
      const tmp = this.path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(tmp, JSON.stringify({ version: VERSION, rows: [...this.rows.values()] }), { flag: 'wx', mode: 0o600 });
        await rename(tmp, this.path);
        this.saved = revision;
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
        // A read-only profile can still list all its history. A later list retries the cache write.
      }
    });
    return this.saving;
  }
}
