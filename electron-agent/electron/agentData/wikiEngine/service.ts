// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWikiGraph, graphMultiHopSearch } from './graph';
import {
  cascadeDeleteWikiPagesWithRefs,
  deleteSourceFiles,
} from './ingest/cascade';
import { createRefreshingLimit, getGlobalLlmConcurrency } from './ingest/concurrency';
import { runIngestIncremental } from './ingest/runIncremental';
import {
  evictWikiDb,
  ftsSearch,
  initIndexDb,
  readSourceStates,
  writeIndex,
  writeIndexAndSources,
  withWriteDb,
  type WikiIndexPage,
} from './indexDb';
import { createLlmClient, type CompleteFn } from './llm';
import { createLogger } from './logger';

const log = createLogger('wiki-service');
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

export type WikiAssetDetail = WikiAsset & {
  internalStatus: string | null;
  syncError: string | null;
  pageCount: number | null;
  summary: string | null;
  version: number;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
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

const HOP_LIMIT = 5;
const DEFAULT_LIMIT = 20;
const DEFAULT_HOP = 0;
const DEFAULT_DECAY = 0.5;
const DEFAULT_MIN_SCORE = 0.1;
const RELATED_CAP = 10;
const EXPANSION_CAP = 200;
const HIDDEN_TYPES = new Set(['query']);

export type WikiSearchOptions = {
  hop?: number;
  decay?: number;
  minScore?: number;
  limit?: number;
};

export type WikiRelatedPage = {
  title: string;
  path: string;
  type: string;
  direction: 'out' | 'in' | 'both';
};

export type WikiResultLink = {
  source: string;
  target: string;
  weight: number;
};

export type WikiSearchHit = {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  hop: number;
  via?: string;
  related: WikiRelatedPage[];
};

export type WikiSearchResponse = {
  results: WikiSearchHit[];
  links: WikiResultLink[];
  count: number;
};

type PageMeta = {
  id: string;
  title: string;
  type: string;
  relPath: string;
  snippet: string;
};

type PageGraphAdj = {
  outAdj: Map<string, Set<string>>;
  inAdj: Map<string, Set<string>>;
  degree: Map<string, number>;
};

function idFromPath(relPath: string): string {
  return relPath.replace(/^wiki\//, '').replace(/\.md$/, '');
}

function validateSearchOptions(options: WikiSearchOptions = {}): {
  hop: number;
  decay: number;
  minScore: number;
  limit: number;
} {
  const hop = options.hop ?? DEFAULT_HOP;
  const decay = options.decay ?? DEFAULT_DECAY;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (!Number.isInteger(hop) || hop < 0 || hop > HOP_LIMIT) {
    throw new Error(`invalid hop: must be integer 0..${HOP_LIMIT}`);
  }
  if (typeof decay !== 'number' || Number.isNaN(decay) || decay < 0 || decay > 1) {
    throw new Error('invalid decay: must be number in 0..1');
  }
  if (typeof minScore !== 'number' || Number.isNaN(minScore) || minScore < 0) {
    throw new Error('invalid minScore: must be number >= 0');
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('invalid limit: must be positive integer');
  }
  return { hop, decay, minScore, limit };
}

function loadPageGraph(
  metaById: Map<string, PageMeta>,
  edgeRows: Array<{ source_id: string; target_id: string }>,
): PageGraphAdj {
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  for (const m of metaById.values()) {
    if (HIDDEN_TYPES.has(m.type)) continue;
    outAdj.set(m.id, new Set());
    inAdj.set(m.id, new Set());
    degree.set(m.id, 0);
  }

  for (const { source_id: s, target_id: t } of edgeRows) {
    if (!outAdj.has(s) || !inAdj.has(t)) continue;
    outAdj.get(s)!.add(t);
    inAdj.get(t)!.add(s);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  return { outAdj, inAdj, degree };
}

function buildRelated(
  pageId: string,
  pg: PageGraphAdj,
  metaById: Map<string, PageMeta>,
): WikiRelatedPage[] {
  const out = pg.outAdj.get(pageId) ?? new Set<string>();
  const inn = pg.inAdj.get(pageId) ?? new Set<string>();
  const all = new Set<string>([...out, ...inn]);
  const items: WikiRelatedPage[] = [];
  for (const nbId of all) {
    const nbMeta = metaById.get(nbId);
    if (!nbMeta) continue;
    const isOut = out.has(nbId);
    const isIn = inn.has(nbId);
    const direction: WikiRelatedPage['direction'] =
      isOut && isIn ? 'both' : isOut ? 'out' : 'in';
    items.push({ title: nbMeta.title, path: nbMeta.relPath, type: nbMeta.type, direction });
  }
  items.sort((a, b) => {
    const da = pg.degree.get(idFromPath(a.path)) ?? 0;
    const db = pg.degree.get(idFromPath(b.path)) ?? 0;
    return db - da;
  });
  return items.slice(0, RELATED_CAP);
}

function buildResultLinks(
  resultIds: string[],
  pg: PageGraphAdj,
  metaById: Map<string, PageMeta>,
): WikiResultLink[] {
  const inResults = new Set(resultIds);
  const seen = new Set<string>();
  const links: WikiResultLink[] = [];
  for (const id of resultIds) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const out = pg.outAdj.get(id) ?? new Set<string>();
    for (const target of out) {
      if (!inResults.has(target)) continue;
      const key = [id, target].sort().join(':::');
      if (seen.has(key)) continue;
      seen.add(key);
      const targetMeta = metaById.get(target);
      links.push({
        source: meta.relPath,
        target: targetMeta ? targetMeta.relPath : target,
        weight: 1,
      });
    }
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

export type IngestResult =
  | { kind: 'ok' }
  | { kind: 'busy'; status: 'pending' | 'processing'; step: string | null };

export class WikiService {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly complete: CompleteFn;
  private readonly cancelled = new Set<string>();
  private readonly buildQueues = new Map<string, Promise<void>>();
  private readonly globalLlmLimit = createRefreshingLimit(getGlobalLlmConcurrency);

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

  private rowToDetail(row: {
    wiki_id: string;
    name: string;
    status: string;
    internal_status: string | null;
    sync_error: string | null;
    page_count: number | null;
    summary: string | null;
    version: number;
    last_sync_at: string | null;
    created_at: string;
    updated_at: string;
  }): WikiAssetDetail {
    return {
      ...this.rowToAsset(row),
      internalStatus: row.internal_status,
      syncError: row.sync_error,
      pageCount: row.page_count,
      summary: row.summary,
      version: row.version,
      lastSyncAt: row.last_sync_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private selectDetail(wikiId: string): WikiAssetDetail {
    assertSafeWikiId(wikiId);
    const row = this.db
      .prepare(
        `SELECT wiki_id, name, status, internal_status, sync_error, page_count, summary,
                version, last_sync_at, created_at, updated_at
         FROM wiki_assets WHERE wiki_id = ?`,
      )
      .get(wikiId) as
      | {
          wiki_id: string;
          name: string;
          status: string;
          internal_status: string | null;
          sync_error: string | null;
          page_count: number | null;
          summary: string | null;
          version: number;
          last_sync_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) throw new Error(`not_found: wiki ${wikiId}`);
    return this.rowToDetail(row);
  }

  list(): WikiAssetDetail[] {
    const rows = this.db
      .prepare(
        `SELECT wiki_id, name, status, internal_status, sync_error, page_count, summary,
                version, last_sync_at, created_at, updated_at
         FROM wiki_assets ORDER BY created_at ASC, wiki_id ASC`,
      )
      .all() as Array<{
      wiki_id: string;
      name: string;
      status: string;
      internal_status: string | null;
      sync_error: string | null;
      page_count: number | null;
      summary: string | null;
      version: number;
      last_sync_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => this.rowToDetail(row));
  }

  read(wikiId: string): WikiAssetDetail {
    return this.selectDetail(wikiId);
  }

  update(wikiId: string, patch: { name?: string; summary?: string | null }): WikiAssetDetail {
    this.requireAsset(wikiId);
    const now = new Date().toISOString();
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('invalid wiki name');
      this.db
        .prepare('UPDATE wiki_assets SET name = ?, updated_at = ? WHERE wiki_id = ?')
        .run(name, now, wikiId);
    }
    if (patch.summary !== undefined) {
      this.db
        .prepare('UPDATE wiki_assets SET summary = ?, updated_at = ? WHERE wiki_id = ?')
        .run(patch.summary, now, wikiId);
    }
    return this.selectDetail(wikiId);
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

  readRaw(wikiId: string, filename: string): string {
    const asset = this.requireAsset(wikiId);
    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const safe = this.resolveRawPath(sourcesDir, filename);
    try {
      return readFileSync(safe, 'utf8');
    } catch {
      throw new Error(`not_found: raw ${filename}`);
    }
  }

  removeRaw(wikiId: string, filename: string): void {
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);

    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const safe = this.resolveRawPath(sourcesDir, filename);
    deleteSourceFiles(asset.dir, [safe]);
    withWriteDb(asset.dir, (db) => {
      db.prepare('DELETE FROM source WHERE filename = ?').run(filename);
    });
    this.rebuildPageIndex(asset);
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

  /**
   * Overwrite wiki/purpose.md or wiki/schema.md only. No locked injection; not writePage.
   */
  writeTemplate(wikiId: string, name: string, content: string): void {
    if (name !== 'purpose' && name !== 'schema') throw new Error('forbidden_path');
    const asset = this.requireAsset(wikiId);
    this.assertWritable(asset);
    if (typeof content !== 'string') throw new Error('invalid_path');
    if (Buffer.byteLength(content, 'utf8') > PAGE_WRITE_MAX_BYTES) throw new Error('too_large');
    const target = join(asset.dir, 'wiki', `${name}.md`);
    writeFileSync(target, content, 'utf8');
    this.rebuildPageIndex(asset);
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

    if (ref.startsWith('raw/')) {
      const rawRoot = resolve(join(asset.dir, 'raw'));
      const rawWithSep = rawRoot.endsWith(sep) ? rawRoot : rawRoot + sep;
      const candidates = ref.endsWith('.md') || ref.endsWith('.txt') ? [ref] : [ref, `${ref}.md`];
      for (const c of candidates) {
        const full = resolve(asset.dir, c);
        if (full !== rawRoot && !full.startsWith(rawWithSep)) throw new Error('not_found');
        if (existsSync(full) && statSync(full).isFile()) return readFileSync(full, 'utf8');
      }
      throw new Error('not_found');
    }

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
    cascadeDeleteWikiPagesWithRefs(asset.dir, [safe]);
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
    cascadeDeleteWikiPagesWithRefs(asset.dir, paths);
    this.rebuildPageIndex(asset);
  }

  search(wikiId: string, query: string, options?: WikiSearchOptions): WikiSearchResponse {
    const empty: WikiSearchResponse = { results: [], links: [], count: 0 };
    const asset = this.requireAsset(wikiId);
    if (asset.status !== 'ready') return empty;

    const { hop, decay, minScore, limit } = validateSearchOptions(options);
    const seedPoolSize = Math.max(limit, hop > 0 ? limit * 2 : limit);
    const rawSeeds = ftsSearch(asset.dir, query, seedPoolSize);
    if (rawSeeds.length === 0) return empty;

    const db = new DatabaseSync(join(asset.dir, 'index.db'));
    try {
      const metaRows = db
        .prepare('SELECT page_id, title, type, rel_path, snippet FROM page_meta')
        .all() as Array<{
        page_id: string;
        title: string;
        type: string;
        rel_path: string;
        snippet: string;
      }>;
      const metaById = new Map<string, PageMeta>();
      for (const row of metaRows) {
        metaById.set(row.page_id, {
          id: row.page_id,
          title: row.title,
          type: row.type,
          relPath: row.rel_path,
          snippet: row.snippet,
        });
      }
      const edgeRows = db
        .prepare('SELECT source_id, target_id FROM graph_edge')
        .all() as Array<{ source_id: string; target_id: string }>;
      const pg = loadPageGraph(metaById, edgeRows);

      let hits: Array<{ id: string; score: number; hop: number; via?: string }>;
      if (hop === 0) {
        hits = rawSeeds.slice(0, limit).map((s) => ({ id: s.id, score: s.score, hop: 0 }));
      } else {
        const graph = createWikiGraph(
          [...metaById.values()]
            .filter((m) => !HIDDEN_TYPES.has(m.type))
            .map((m) => ({ id: m.id, label: m.title })),
          edgeRows.map((e) => ({ source: e.source_id, target: e.target_id })),
        );
        hits = graphMultiHopSearch(graph, rawSeeds, {
          hop,
          decay,
          minScore,
          maxNodes: EXPANSION_CAP,
        }).slice(0, limit);
      }

      const results: WikiSearchHit[] = [];
      const resultIds: string[] = [];
      for (const hit of hits) {
        const meta = metaById.get(hit.id);
        if (!meta) continue;
        const result: WikiSearchHit = {
          path: meta.relPath,
          title: meta.title,
          snippet: meta.snippet,
          score: hit.score,
          type: meta.type,
          hop: hit.hop,
          related: buildRelated(meta.id, pg, metaById),
        };
        if (hit.hop > 0 && hit.via) result.via = hit.via;
        results.push(result);
        resultIds.push(meta.id);
      }

      const links = buildResultLinks(resultIds, pg, metaById);
      return { results, links, count: results.length };
    } finally {
      db.close();
    }
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

  /**
   * Delete a wiki in any status. processing/pending marks cancel so the worker
   * skips ready/failed and finishes with an idempotent cleanup.
   */
  remove(wikiId: string): void {
    assertSafeWikiId(wikiId);
    const row = this.db
      .prepare('SELECT wiki_id, status FROM wiki_assets WHERE wiki_id = ?')
      .get(wikiId) as { wiki_id: string; status: string } | undefined;
    if (!row) throw new Error(`not_found: wiki ${wikiId}`);

    if (row.status === 'pending' || row.status === 'processing') {
      this.cancelled.add(wikiId);
    }
    this.cleanupResources(wikiId);
  }

  private cleanupResources(wikiId: string): void {
    try {
      evictWikiDb(wikiId);
    } catch {
      /* ignore */
    }
    try {
      this.db.prepare('DELETE FROM wiki_assets WHERE wiki_id = ?').run(wikiId);
    } catch {
      /* ignore */
    }
    try {
      const sources = this.readSources();
      if (wikiId in sources) {
        delete sources[wikiId];
        this.writeSources(sources);
      }
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(this.root, wikiId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  private finishCancelled(wikiId: string): void {
    this.cleanupResources(wikiId);
    this.cancelled.delete(wikiId);
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

  /**
   * Explicit ingest. Returns a Promise that resolves when this run finishes
   * (tests can await). pending/processing → busy without re-queueing.
   */
  async ingest(wikiId: string): Promise<IngestResult> {
    const asset = this.requireAsset(wikiId);
    const row = this.db
      .prepare('SELECT status, internal_status, version FROM wiki_assets WHERE wiki_id = ?')
      .get(wikiId) as
      | { status: string; internal_status: string | null; version: number }
      | undefined;
    if (!row) throw new Error(`not_found: wiki ${wikiId}`);

    if (row.status === 'pending' || row.status === 'processing') {
      return {
        kind: 'busy',
        status: row.status,
        step: row.internal_status,
      };
    }

    const sourcesDir = join(asset.dir, 'raw', 'sources');
    const hasSource =
      existsSync(sourcesDir) &&
      readdirSync(sourcesDir).some((name) => {
        const full = join(sourcesDir, name);
        try {
          return statSync(full).isFile() && (name.endsWith('.md') || name.endsWith('.txt'));
        } catch {
          return false;
        }
      });
    if (!hasSource) {
      throw new Error('no source documents to ingest');
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE wiki_assets
         SET status = 'pending', internal_status = NULL, sync_error = NULL,
             version = version + 1, updated_at = ?
         WHERE wiki_id = ?`,
      )
      .run(now, wikiId);

    const job = this.enqueueBuild(wikiId);
    await job;
    return { kind: 'ok' };
  }

  private enqueueBuild(wikiId: string): Promise<void> {
    const prev = this.buildQueues.get(wikiId) ?? Promise.resolve();
    const job = prev
      .catch(() => {
        /* keep queue alive after prior failure */
      })
      .then(() => this.runBuild(wikiId));
    this.buildQueues.set(wikiId, job);
    return job.finally(() => {
      if (this.buildQueues.get(wikiId) === job) this.buildQueues.delete(wikiId);
    });
  }

  private setStatus(
    wikiId: string,
    patch: {
      status?: string;
      internal_status?: string | null;
      sync_error?: string | null;
      page_count?: number | null;
      last_sync_at?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    const cur = this.db
      .prepare(
        'SELECT status, internal_status, sync_error, page_count, last_sync_at FROM wiki_assets WHERE wiki_id = ?',
      )
      .get(wikiId) as
      | {
          status: string;
          internal_status: string | null;
          sync_error: string | null;
          page_count: number | null;
          last_sync_at: string | null;
        }
      | undefined;
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE wiki_assets SET
           status = ?, internal_status = ?, sync_error = ?,
           page_count = ?, last_sync_at = ?, updated_at = ?
         WHERE wiki_id = ?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.internal_status !== undefined ? patch.internal_status : cur.internal_status,
        patch.sync_error !== undefined ? patch.sync_error : cur.sync_error,
        patch.page_count !== undefined ? patch.page_count : cur.page_count,
        patch.last_sync_at !== undefined ? patch.last_sync_at : cur.last_sync_at,
        now,
        wikiId,
      );
  }

  private isCancelled(wikiId: string): boolean {
    if (this.cancelled.has(wikiId)) return true;
    const row = this.db.prepare('SELECT 1 FROM wiki_assets WHERE wiki_id = ?').get(wikiId);
    return !row;
  }

  private async runBuild(wikiId: string): Promise<void> {
    if (this.isCancelled(wikiId)) {
      this.finishCancelled(wikiId);
      return;
    }

    const asset = this.requireAsset(wikiId);
    this.setStatus(wikiId, {
      status: 'processing',
      internal_status: 'scanning',
      sync_error: null,
    });

    try {
      if (this.isCancelled(wikiId)) {
        this.finishCancelled(wikiId);
        return;
      }

      this.setStatus(wikiId, { status: 'processing', internal_status: 'ingesting' });

      const llm = createLlmClient(this.complete);
      let oldStates = new Map<string, { sha256: string; status: 'uploaded' | 'ingested' | 'failed' }>();
      try {
        oldStates = readSourceStates(asset.dir);
      } catch {
        /* fresh */
      }

      const outcome = await runIngestIncremental(
        asset.dir,
        oldStates,
        llm,
        this.globalLlmLimit(),
      );

      if (this.isCancelled(wikiId)) {
        this.finishCancelled(wikiId);
        return;
      }

      this.setStatus(wikiId, { status: 'processing', internal_status: 'rebuilding-index' });

      const pages = this.scanWikiPages(asset);
      writeIndexAndSources(asset.dir, pages, outcome.processed, outcome.deletedSources);
      evictWikiDb(wikiId);

      const attempted = outcome.processed.length;
      const failed = outcome.processed.filter((p) => !p.ok);
      if (attempted > 0 && failed.length === attempted) {
        const first = failed[0];
        const msg =
          `all source documents failed to ingest` +
          (first ? `; first failure: ${first.filename}: ${first.error ?? 'unknown'}` : '');
        if (this.isCancelled(wikiId)) {
          this.finishCancelled(wikiId);
          return;
        }
        this.setStatus(wikiId, {
          status: 'failed',
          internal_status: null,
          sync_error: msg.slice(0, 500),
        });
        throw new Error(msg);
      }

      if (this.isCancelled(wikiId)) {
        this.finishCancelled(wikiId);
        return;
      }

      this.setStatus(wikiId, {
        status: 'ready',
        internal_status: null,
        sync_error: null,
        page_count: pages.length,
        last_sync_at: new Date().toISOString(),
      });
      log.info('ingest ready', { wikiId, pages: pages.length });
    } catch (err) {
      if (this.isCancelled(wikiId)) {
        this.finishCancelled(wikiId);
        return;
      }
      const row = this.db
        .prepare('SELECT status FROM wiki_assets WHERE wiki_id = ?')
        .get(wikiId) as { status: string } | undefined;
      // already marked failed above for all-sources-failed
      if (row?.status === 'failed') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(wikiId, {
        status: 'failed',
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      throw err;
    }
  }
}
