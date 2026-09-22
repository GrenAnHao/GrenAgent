// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  evictWikiDb,
  ftsSearch,
  initIndexDb,
  writeIndex,
  withWriteDb,
  type WikiIndexPage,
} from './indexDb';

/** Default purpose — software engineering knowledge base. */
const DEFAULT_PURPOSE = `This knowledge base accumulates and organizes engineering knowledge of software systems,
including system architecture, module design, data flow, deployment models, permission models, etc.
By ingesting requirement documents, architecture designs, meeting notes, RFCs, technical decisions and other
source documents, it builds a structured, cross-referenced knowledge graph to help team members quickly
understand the system landscape and the rationale behind design decisions.`;

/** Default schema skeleton — software engineering knowledge base. */
const DEFAULT_SCHEMA = `# Page types
- entity — a concrete component or role in the system; must declare a kind field
- concept — an abstract design idea (system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework, etc.)
- source — one summary page per ingested source document; must declare a source_type field
Other types (comparison, synthesis, etc.) may be created as needed.

# Fields / sections per type
- entity:
    - kind: module | service | platform | external_system | user_role | other (required)
    - definition: responsibility / purpose
    - key attributes: key properties
    - relationships: relationships to other entities
- concept:
    - definition: concept definition
    - significance: importance / role
    - related entities: associated entities
    - common topics: system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework
- source:
    - source_type: requirement | architecture | meeting | rfc | decision | other (required)
    - source document summary
- Use OKF sections where applicable: # Schema / # Examples / # Citations

# Naming & language
- slug: lowercase, spaces→hyphens
- Output language: follow the source document — do not switch`;

const SOURCES_FILE = 'wiki-sources.json';

const WIKI_DIRS = [
  'raw/sources',
  'wiki/entities',
  'wiki/concepts',
  'wiki/sources',
  'wiki/comparisons',
  'wiki/synthesis',
  '.llm-wiki',
] as const;

const DEFAULT_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    'wiki/schema.md',
    `---\ntype: schema\ntitle: Wiki Schema\n---\n\n${DEFAULT_SCHEMA}\n`,
  ],
  [
    'wiki/purpose.md',
    `---\ntype: purpose\ntitle: Wiki Purpose\n---\n\n${DEFAULT_PURPOSE}\n`,
  ],
  [
    'wiki/index.md',
    '---\ntype: index\ntitle: Index\n---\n\n# Index\n\n## Entities\n\n## Concepts\n\n## Sources\n',
  ],
];

type CompleteFn = (input: unknown) => Promise<string>;

export type WikiCreateInput = {
  name: string;
  wikiId?: string;
};

export type WikiAsset = {
  wikiId: string;
  name: string;
  status: string;
  dir: string;
};

export type WikiRawSource = {
  filename: string;
  sha256: string;
  size: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
};

const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const RAW_WRITE_MAX = 50;
const RAW_ALLOWED_EXT = new Set(['.md', '.txt']);

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const PAGE_BATCH_MAX = 20;

/** Wiki-root structural pages only (resolved relative path, lowercased, forward slashes). */
const PAGE_FORBIDDEN_REL = new Set(['index.md', 'schema.md', 'purpose.md']);

function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith('\n') ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const rest = content.slice(fmMatch[0].length);
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === 'true') return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, 'locked: true');
    return {
      content: `---\n${newFmBody}\n---\n${rest}`,
      lockedInjected: true,
    };
  }
  const newFmBody =
    fmBody.length === 0 || fmBody.endsWith('\n')
      ? `${fmBody}locked: true`
      : `${fmBody}\nlocked: true`;
  return {
    content: `---\n${newFmBody}\n---\n${rest}`,
    lockedInjected: true,
  };
}

function isForbiddenResolvedPage(wikiDir: string, safePath: string): boolean {
  const rel = relative(resolve(wikiDir), resolve(safePath))
    .replace(/\\/g, '/')
    .toLowerCase();
  return PAGE_FORBIDDEN_REL.has(rel);
}

function extractFrontmatterFields(content: string): { title: string; type: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : 'other',
  };
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

function assertSafeWikiId(wikiId: string): void {
  if (
    !wikiId ||
    wikiId !== wikiId.trim() ||
    wikiId === '.' ||
    wikiId === SOURCES_FILE ||
    wikiId.includes('..') ||
    wikiId.includes('/') ||
    wikiId.includes('\\') ||
    wikiId.includes(sep)
  ) {
    throw new Error(`invalid wikiId: ${wikiId}`);
  }
}

export class WikiService {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly complete: CompleteFn;

  constructor(opts: { root: string; db: DatabaseSync; complete: CompleteFn }) {
    this.root = opts.root;
    this.db = opts.db;
    this.complete = opts.complete;
    this.ensureAssetsTable();
  }

  private ensureAssetsTable(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS wiki_assets (
  wiki_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  internal_status TEXT,
  sync_error TEXT,
  page_count INTEGER,
  summary TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
  }

  private sourcesPath(): string {
    return join(this.root, SOURCES_FILE);
  }

  private readSources(): Record<string, string> {
    const path = this.sourcesPath();
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeSources(map: Record<string, string>): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.sourcesPath(), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  private initProject(dir: string): void {
    for (const rel of WIKI_DIRS) {
      mkdirSync(join(dir, rel), { recursive: true });
    }
    for (const [rel, content] of DEFAULT_FILES) {
      const full = join(dir, rel);
      if (!existsSync(full)) writeFileSync(full, content, 'utf8');
    }
    initIndexDb(dir);
  }

  private rowToAsset(row: {
    wiki_id: string;
    name: string;
    status: string;
  }): WikiAsset {
    return {
      wikiId: row.wiki_id,
      name: row.name,
      status: row.status,
      dir: join(this.root, row.wiki_id),
    };
  }

  create(input: WikiCreateInput): WikiAsset {
    const name = input.name.trim();
    if (!name) throw new Error('invalid wiki name');

    const existing = this.db
      .prepare('SELECT wiki_id, name, status FROM wiki_assets WHERE name = ?')
      .get(name) as { wiki_id: string; name: string; status: string } | undefined;
    if (existing) {
      const dir = join(this.root, existing.wiki_id);
      this.initProject(dir);
      const sources = this.readSources();
      if (sources[existing.wiki_id] !== dir) {
        sources[existing.wiki_id] = dir;
        this.writeSources(sources);
      }
      return this.rowToAsset(existing);
    }

    const wikiId = input.wikiId ?? randomUUID();
    assertSafeWikiId(wikiId);

    const now = new Date().toISOString();
    const dir = join(this.root, wikiId);
    this.initProject(dir);

    this.db
      .prepare(
        `INSERT INTO wiki_assets(
          wiki_id, name, status, internal_status, sync_error, page_count, summary,
          version, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, 'draft', NULL, NULL, 0, NULL, 0, NULL, ?, ?)`,
      )
      .run(wikiId, name, now, now);

    const sources = this.readSources();
    sources[wikiId] = dir;
    this.writeSources(sources);

    return { wikiId, name, status: 'draft', dir };
  }

  private requireAsset(wikiId: string): WikiAsset {
    assertSafeWikiId(wikiId);
    const row = this.db
      .prepare('SELECT wiki_id, name, status FROM wiki_assets WHERE wiki_id = ?')
      .get(wikiId) as { wiki_id: string; name: string; status: string } | undefined;
    if (!row) throw new Error(`not_found: wiki ${wikiId}`);
    return this.rowToAsset(row);
  }

  private assertWritable(asset: WikiAsset): void {
    if (asset.status === 'processing') throw new Error('processing');
  }

  private assertRawFilename(filename: string): void {
    if (!filename) throw new Error('invalid_path');
    if (filename.includes('/') || filename.includes('\\')) throw new Error('invalid_path');
    if (filename === '.' || filename === '..') throw new Error('invalid_path');
    if (filename !== filename.trim()) throw new Error('invalid_path');
    for (let i = 0; i < filename.length; i++) {
      const code = filename.charCodeAt(i);
      if (code < 32 || code === 127) throw new Error('invalid_path');
    }
    const ext = extname(filename).toLowerCase();
    if (!RAW_ALLOWED_EXT.has(ext)) throw new Error('invalid_path');
    const stem = filename.slice(0, filename.length - ext.length);
    if (!stem) throw new Error('invalid_path');
  }

  private resolveRawPath(sourcesDir: string, filename: string): string {
    this.assertRawFilename(filename);
    const base = resolve(sourcesDir);
    const safe = resolve(base, filename);
    const dirWithSep = base.endsWith(sep) ? base : base + sep;
    if (safe === base || !safe.startsWith(dirWithSep)) throw new Error('invalid_path');
    return safe;
  }

  private sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  private readExistingContent(safePath: string): string | null {
    try {
      return readFileSync(safePath, 'utf8');
    } catch {
      return null;
    }
  }

  private rollbackRawWrites(
    written: Array<{ safePath: string; previous: string | null }>,
  ): void {
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i];
      try {
        if (item.previous === null) {
          unlinkSync(item.safePath);
        } else {
          writeFileSync(item.safePath, item.previous, 'utf8');
        }
      } catch {
        // best-effort restore
      }
    }
  }

  private upsertSource(
    db: DatabaseSync,
    entry: { filename: string; sha256: string; size: number },
  ): void {
    const now = new Date().toISOString();
    const old = db.prepare('SELECT sha256 FROM source WHERE filename = ?').get(entry.filename) as
      | { sha256: string }
      | undefined;
    if (!old) {
      db.prepare(
        `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
         VALUES (?, ?, ?, 'uploaded', ?, ?, NULL, NULL, NULL)`,
      ).run(entry.filename, entry.sha256, entry.size, now, now);
      return;
    }
    if (old.sha256 !== entry.sha256) {
      db.prepare(
        `UPDATE source SET sha256 = ?, size = ?, status = 'uploaded', updated_at = ?, ingest_error = NULL
         WHERE filename = ?`,
      ).run(entry.sha256, entry.size, now, entry.filename);
    }
  }

  writeRaw(wikiId: string, filename: string, content: string): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);

    const size = Buffer.byteLength(content, 'utf8');
    if (size > RAW_WRITE_MAX_BYTES) throw new Error('too_large');

    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const safe = this.resolveRawPath(sourcesDir, filename);
    const previous = this.readExistingContent(safe);
    mkdirSync(sourcesDir, { recursive: true });
    const written: Array<{ safePath: string; previous: string | null }> = [];
    try {
      writeFileSync(safe, content, 'utf8');
      written.push({ safePath: safe, previous });
      withWriteDb(asset.dir, (db) => {
        this.upsertSource(db, { filename, sha256: this.sha256(content), size });
      });
    } catch (err) {
      this.rollbackRawWrites(written);
      throw err;
    }
  }

  writeRawMany(wikiId: string, files: Array<{ filename: string; content: string }>): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const plans: Array<{
      filename: string;
      safePath: string;
      content: string;
      size: number;
      previous: string | null;
    }> = [];
    for (const { filename, content } of files) {
      if (typeof content !== 'string') throw new Error('invalid_path');
      const size = Buffer.byteLength(content, 'utf8');
      if (size > RAW_WRITE_MAX_BYTES) throw new Error('too_large');
      const safePath = this.resolveRawPath(sourcesDir, filename);
      plans.push({
        filename,
        safePath,
        content,
        size,
        previous: this.readExistingContent(safePath),
      });
    }

    mkdirSync(sourcesDir, { recursive: true });
    const written: Array<{ safePath: string; previous: string | null }> = [];
    try {
      for (const p of plans) {
        writeFileSync(p.safePath, p.content, 'utf8');
        written.push({ safePath: p.safePath, previous: p.previous });
      }
      withWriteDb(asset.dir, (db) => {
        for (const p of plans) {
          this.upsertSource(db, {
            filename: p.filename,
            sha256: this.sha256(p.content),
            size: p.size,
          });
        }
      });
    } catch (err) {
      this.rollbackRawWrites(written);
      throw err;
    }
  }
  listRaw(wikiId: string): WikiRawSource[] {
    const asset = this.requireAsset(wikiId);
    const db = new DatabaseSync(join(asset.dir, 'index.db'));
    try {
      return db
        .prepare(
          `SELECT filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error
           FROM source ORDER BY filename`,
        )
        .all() as WikiRawSource[];
    } finally {
      db.close();
    }
  }

  removeRaw(wikiId: string, filename: string): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);

    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (existsSync(safe)) unlinkSync(safe);
    withWriteDb(asset.dir, (db) => {
      db.prepare('DELETE FROM source WHERE filename = ?').run(filename);
    });
  }

  private resolvePagePath(wikiDir: string, ref: string, opts: { allowMissing?: boolean }): string {
    if (!ref || ref.includes('..') || ref.startsWith('/') || ref.startsWith('\\')) {
      throw new Error('invalid_path');
    }
    const cleanRef = ref.replace(/^wiki\//, '');
    if (!cleanRef || cleanRef.includes('..')) throw new Error('invalid_path');

    const base = resolve(wikiDir);
    const baseWithSep = base.endsWith(sep) ? base : base + sep;
    const candidates = cleanRef.endsWith('.md') ? [cleanRef] : [cleanRef + '.md', cleanRef];

    for (const c of candidates) {
      const safe = resolve(base, c);
      if (safe === base || !safe.startsWith(baseWithSep)) continue;
      if (opts.allowMissing) {
        if (c.endsWith('.md')) return safe;
        continue;
      }
      if (existsSync(safe)) return safe;
    }

    if (opts.allowMissing) {
      const forced = cleanRef.endsWith('.md') ? cleanRef : `${cleanRef}.md`;
      const safe = resolve(base, forced);
      if (safe === base || !safe.startsWith(baseWithSep)) throw new Error('invalid_path');
      return safe;
    }
    throw new Error('not_found');
  }

  private scanWikiPages(asset: WikiAsset): WikiIndexPage[] {
    const wikiDir = join(asset.dir, 'wiki');
    const pages: WikiIndexPage[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (entry === 'media') continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith('.md')) continue;
        let content = '';
        try {
          content = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const rel = full.slice(wikiDir.length + 1).replace(/\\/g, '/');
        const id = rel.replace(/\.md$/, '');
        const fm = extractFrontmatterFields(content);
        pages.push({
          id,
          title: fm.title || basename(entry, '.md'),
          type: fm.type,
          relPath: `wiki/${rel}`,
          content,
          links: extractWikilinks(content),
        });
      }
    };
    walk(wikiDir);
    return pages;
  }

  private rebuildPageIndex(asset: WikiAsset): void {
    const pages = this.scanWikiPages(asset);
    writeIndex(asset.dir, pages);
    evictWikiDb(asset.wikiId);
  }

  writePage(wikiId: string, ref: string, content: string): { lockedInjected: boolean } {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);

    if (Buffer.byteLength(content, 'utf8') > PAGE_WRITE_MAX_BYTES) throw new Error('too_large');

    const wikiDir = join(asset.dir, 'wiki');
    const safe = this.resolvePagePath(wikiDir, ref, { allowMissing: true });
    if (isForbiddenResolvedPage(wikiDir, safe)) throw new Error('forbidden_path');

    const { content: finalContent, lockedInjected } = injectLockedTrue(content);

    mkdirSync(join(safe, '..'), { recursive: true });
    writeFileSync(safe, finalContent, 'utf8');
    this.rebuildPageIndex(asset);
    return { lockedInjected };
  }

  writePages(
    wikiId: string,
    pages: Array<{ ref: string; content: string }>,
  ): Array<{ ref: string; lockedInjected: boolean }> {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);
    if (pages.length > PAGE_BATCH_MAX) {
      throw new Error(`pages exceeds max ${PAGE_BATCH_MAX}`);
    }

    const wikiDir = join(asset.dir, 'wiki');
    type Plan = {
      ref: string;
      safePath: string;
      finalContent: string;
      lockedInjected: boolean;
      previous: string | null;
    };
    const plans: Plan[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== 'string') throw new Error('invalid_path');
      if (Buffer.byteLength(content, 'utf8') > PAGE_WRITE_MAX_BYTES) throw new Error('too_large');
      const safePath = this.resolvePagePath(wikiDir, ref, { allowMissing: true });
      if (isForbiddenResolvedPage(wikiDir, safePath)) throw new Error('forbidden_path');
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      plans.push({
        ref,
        safePath,
        finalContent,
        lockedInjected,
        previous: this.readExistingContent(safePath),
      });
    }

    const written: Array<{ safePath: string; previous: string | null }> = [];
    try {
      for (const p of plans) {
        mkdirSync(join(p.safePath, '..'), { recursive: true });
        writeFileSync(p.safePath, p.finalContent, 'utf8');
        written.push({ safePath: p.safePath, previous: p.previous });
      }
      this.rebuildPageIndex(asset);
    } catch (err) {
      this.rollbackRawWrites(written);
      throw err;
    }
    return plans.map(({ ref, lockedInjected }) => ({ ref, lockedInjected }));
  }

  readPage(wikiId: string, ref: string): string {
    const asset = this.requireAsset(wikiId);
    const wikiDir = join(asset.dir, 'wiki');
    const safe = this.resolvePagePath(wikiDir, ref, { allowMissing: false });
    return readFileSync(safe, 'utf8');
  }

  readPages(wikiId: string, refs: string[]): Array<{ ref: string; content: string }> {
    const asset = this.requireAsset(wikiId);
    if (refs.length > PAGE_BATCH_MAX) {
      throw new Error(`refs exceeds max ${PAGE_BATCH_MAX}`);
    }
    const wikiDir = join(asset.dir, 'wiki');
    return refs.map((ref) => {
      const safe = this.resolvePagePath(wikiDir, ref, { allowMissing: false });
      return { ref, content: readFileSync(safe, 'utf8') };
    });
  }

  listPages(wikiId: string): Array<{ id: string; title: string; type: string; relPath: string }> {
    const asset = this.requireAsset(wikiId);
    if (asset.status !== 'ready') return [];
    return this.scanWikiPages(asset).map(({ id, title, type, relPath }) => ({
      id,
      title,
      type,
      relPath,
    }));
  }

  removePage(wikiId: string, ref: string): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);

    const wikiDir = join(asset.dir, 'wiki');
    const safe = this.resolvePagePath(wikiDir, ref, { allowMissing: false });
    if (isForbiddenResolvedPage(wikiDir, safe)) throw new Error('forbidden_path');
    unlinkSync(safe);
    this.rebuildPageIndex(asset);
  }

  removePages(wikiId: string, refs: string[]): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);
    if (refs.length > PAGE_BATCH_MAX) {
      throw new Error(`refs exceeds max ${PAGE_BATCH_MAX}`);
    }

    const wikiDir = join(asset.dir, 'wiki');
    const paths: string[] = [];
    for (const ref of refs) {
      const safe = this.resolvePagePath(wikiDir, ref, { allowMissing: false });
      if (isForbiddenResolvedPage(wikiDir, safe)) throw new Error('forbidden_path');
      paths.push(safe);
    }
    for (const safe of paths) {
      if (existsSync(safe)) unlinkSync(safe);
    }
    this.rebuildPageIndex(asset);
  }

  search(wikiId: string, query: string): Array<{ id: string; score: number }> {
    const asset = this.requireAsset(wikiId);
    if (asset.status !== 'ready') return [];
    return ftsSearch(asset.dir, query, 20);
  }

  graph(wikiId: string): Array<{ source_id: string; target_id: string }> {
    const asset = this.requireAsset(wikiId);
    if (asset.status !== 'ready') return [];
    const db = new DatabaseSync(join(asset.dir, 'index.db'));
    try {
      return db
        .prepare('SELECT source_id, target_id FROM graph_edge')
        .all() as Array<{ source_id: string; target_id: string }>;
    } finally {
      db.close();
    }
  }

  resetDraft(wikiId: string): void {
    this.requireAsset(wikiId);
    this.db
      .prepare(
        `UPDATE wiki_assets
         SET status = 'draft', internal_status = NULL, sync_error = NULL
         WHERE wiki_id = ? AND status IN ('pending', 'processing')`,
      )
      .run(wikiId);
  }
}
