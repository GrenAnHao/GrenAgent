// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initIndexDb } from './indexDb';

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

function assertSafeWikiId(wikiId: string): void {
  if (
    !wikiId ||
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
}
