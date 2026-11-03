/**
 * Persistent repository knowledge engine. Dedicated Node service only; no HTTP or
 * Python runtime. Adapted from the MIT RepoWiki workspace implementation.
 * Generation is staged, evidence checked, then committed atomically. User text
 * is always merged against the last generated baseline, never blindly replaced.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { diffArrays } from "diff";
import { scanRepository, scanRepositoryAsync, checkAborted, readSourceFile, hash, canonicalJson, safeRelative, matches } from "./scanner.js";
import { ProjectFiles, PROJECT_CACHE_DATABASE, pageStorageToken, type ProjectFacts } from "./project-files.js";
import { migrateWorkspace, type MigrationResult } from "./migration.js";
export type { MigrationResult } from "./migration.js";
export const ENGINE_VERSION = "workspace-ts-v1.0";
export const MAX_MARKDOWN_BYTES = 2_000_000;
export const MAX_CONTEXT_FILES = 60;
export const MAX_CONTEXT_CHARS = 120_000;
export const MAX_FILE_CONTEXT_CHARS = 12_000;
type Data = Record<string, any>;
export type ContentTarget = "wiki" | "cards";
export interface PageDefinition {
  id: string;
  title: string;
  goal: string;
  patterns: string[];
  depends_on: string[];
  category?: string;
}
export interface WikiPlan {
  include: string[];
  exclude: string[];
  pages: PageDefinition[];
}
export interface GenerationProvider {
  name: string;
  cache_key: string;
  generate_page(context: Data): Promise<Data> | Data;
}
export type Progress = (event: Data) => void;
export type DatabaseLike = Pick<DatabaseSync, "exec" | "prepare" | "close">;
export interface WorkspaceEngineOptions {
  databaseFactory?: (filename: string) => DatabaseLike;
  legacyDataDir?: string;
  /** The host must settle only after its snapshot worker has exited, including cancellation. */
  snapshotLegacy?: (from: string, to: string, signal?: AbortSignal) => Promise<MigrationResult>;
}

/** Only these deliberately authored messages are suitable for presentation. */
export class WorkspaceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "WorkspaceError";
  }
}
const now = () => new Date().toISOString();
const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const namespace = (value: Data, target: ContentTarget = "wiki") => hash(target === "wiki" ? [value.branch, value.language] : [value.branch, value.language, "knowledge-cards-v1"]).slice(0, 24);
function checkedTarget(target: unknown): ContentTarget {
  if (target !== "wiki" && target !== "cards") throw new WorkspaceError("Invalid generation target");
  return target;
}
const summaryOf = (markdown: string): string => markdown.replace(/```[\s\S]*?```/g, "").split(/\r?\n/).filter(line => line.trim() && !/^\s*(?:#|>|\||---)/.test(line) && !/^\s*\*\*(?:分类|Category|本卡目标|Card goal|验证边界|Verification boundary)\*\*/i.test(line)).join(" ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const workspaceIdentity = (root: string): string => {
  const normalized = path.resolve(root).replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const lineArray = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const sourceLines = (value: string) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((_, index, rows) => index < rows.length - 1 || rows[index] !== "");
export function walkEdges(seeds: Iterable<string>, edges: string[][], reverse = false): Set<string> {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    const [source, target] = reverse ? [edge[1], edge[0]] : edge;
    if (!graph.has(source)) graph.set(source, new Set());
    graph.get(source)!.add(target);
  }
  const result = new Set(seeds),
    pending = [...result];
  while (pending.length) for (const target of graph.get(pending.pop()!) ?? []) if (!result.has(target)) {
    result.add(target);
    pending.push(target);
  }
  return result;
}

/** Conservative line merge. Conflicts return unchanged human text, not markers. */
export function three_way_merge(base: string, ours: string, theirs: string): [string, boolean] {
  if (ours === base || ours === theirs) return [theirs, false];
  if (theirs === base) return [ours, false];
  const original = lineArray(base);
  // A pathological diff must not monopolize the service process. A bounded
  // fallback is an explicit conflict, never a guessed merge or dropped text.
  if (original.length > 50_000 || lineArray(ours).length > 50_000 || lineArray(theirs).length > 50_000) return [ours, true];
  type Edit = {
    start: number;
    end: number;
    replacement: string[];
  };
  const edits = (text: string): Edit[] | undefined => {
    const result: Edit[] = [];
    let index = 0;
    let active: Edit | undefined;
    const changes = diffArrays(original, lineArray(text), {
      timeout: 200,
      maxEditLength: 10_000
    });
    if (!changes) return undefined;
    for (const change of changes) {
      if (!change.added && !change.removed) {
        if (active) {
          result.push(active);
          active = undefined;
        }
        index += change.value.length;
      } else {
        active ??= {
          start: index,
          end: index,
          replacement: []
        };
        if (change.removed) {
          index += change.value.length;
          active.end = index;
        }
        if (change.added) active.replacement.push(...change.value);
      }
    }
    if (active) result.push(active);
    return result;
  };
  const local = edits(ours),
    remote = edits(theirs);
  if (!local || !remote || local.length * remote.length > 1_000_000) return [ours, true];
  const combined = [...local];
  for (const incoming of remote) {
    let duplicate = false;
    for (const existing of local) {
      if (canonicalJson(incoming) === canonicalJson(existing)) {
        duplicate = true;
        break;
      }
      const {
          start: lo,
          end: hi
        } = incoming,
        {
          start: x,
          end: y
        } = existing;
      if (Math.max(lo, x) < Math.min(hi, y) || lo === hi && x <= lo && lo <= y || x === y && lo <= x && x <= hi) return [ours, true];
    }
    if (!duplicate) combined.push(incoming);
  }
  for (const edit of combined.sort((a, b) => b.start - a.start || b.end - a.end)) original.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  return [original.join(""), false];
}
export function validate_plan(value: unknown): WikiPlan {
  if (!object(value)) throw new WorkspaceError("wiki_plan must be an object");
  const include = value.include ?? ["**"],
    exclude = value.exclude ?? [],
    definitions = value.pages;
  for (const [key, patterns] of Object.entries({
    include,
    exclude
  })) {
    if (!Array.isArray(patterns) || patterns.length > 100 || patterns.some(item => typeof item !== "string")) throw new WorkspaceError(`${key} must be a list of at most 100 path patterns`);
    for (const pattern of patterns) safeRelative(pattern, true);
  }
  if (!include.length) throw new WorkspaceError("At least one include pattern is required");
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 80) throw new WorkspaceError("Plan must define 1–80 pages");
  const ids = new Set<string>();
  const pages: PageDefinition[] = [];
  for (const page of definitions) {
    if (!object(page)) throw new WorkspaceError("Each page must be an object");
    const slug = safeRelative(page.id ?? "");
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(slug) || ids.has(slug)) throw new WorkspaceError("Page IDs must be unique safe slugs");
    ids.add(slug);
    const title = page.title,
      goal = page.goal ?? "",
      patterns = page.patterns ?? ["**"],
      dependencies = page.depends_on ?? [];
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new WorkspaceError("Page title must contain 1–200 characters");
    if (typeof goal !== "string" || goal.length > 4000) throw new WorkspaceError("Page goal must be a string of at most 4000 characters");
    if (!Array.isArray(patterns) || !patterns.length || patterns.length > 100) throw new WorkspaceError("Each page needs 1–100 source patterns");
    for (const pattern of patterns) safeRelative(pattern, true);
    if (!Array.isArray(dependencies) || dependencies.length > 80 || dependencies.some(dep => typeof dep !== "string")) throw new WorkspaceError("depends_on must be a list of page IDs");
    pages.push({
      id: slug,
      title,
      goal,
      patterns: [...patterns],
      depends_on: [...new Set<string>(dependencies)].sort()
    });
  }
  for (const page of pages) if (page.depends_on.some(dep => !ids.has(dep) || dep === page.id)) throw new WorkspaceError("Unknown or self-referential page dependency");
  const pending = new Map(pages.map(page => [page.id, new Set(page.depends_on)]));
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => !deps.size).map(([id]) => id);
    if (!ready.length) throw new WorkspaceError("Page dependencies must not contain cycles");
    for (const id of ready) pending.delete(id);
    for (const deps of pending.values()) for (const id of ready) deps.delete(id);
  }
  return {
    include: [...include],
    exclude: [...exclude],
    pages
  };
}
function defaultPlan(paths: string[], language: string): WikiPlan {
  const zh = language.startsWith("zh");
  const pages: PageDefinition[] = [{
    id: "overview",
    title: zh ? "项目概览" : "Overview",
    goal: "Explain purpose, boundaries, and source coverage; distinguish evidence from inference.",
    patterns: ["**"],
    depends_on: []
  }, {
    id: "architecture",
    title: zh ? "系统架构" : "Architecture",
    goal: "Explain modules and actual dependency relationships, include a Mermaid diagram.",
    patterns: ["**"],
    depends_on: []
  }, {
    id: "getting-started",
    title: zh ? "开发指南" : "Getting started",
    goal: "Describe setup and reading order using configuration and README evidence only; do not invent commands.",
    patterns: ["README*", "**/README*", "pyproject.toml", "package.json", "requirements.txt", "Makefile", "src/**", "app/**"],
    depends_on: []
  }];
  for (const directory of [...new Set(paths.filter(file => file.includes("/")).map(file => file.split("/")[0]))].sort().slice(0, 12)) {
    let slug = directory.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || hash(directory).slice(0, 8);
    if (pages.some(page => page.id === `modules/${slug}`)) slug += "-" + hash(directory).slice(0, 8);
    pages.push({
      id: `modules/${slug}`,
      title: zh ? `${directory} 模块` : `${directory} module`,
      goal: `Explain responsibilities and public entry points of ${directory}; cite actual source lines.`,
      patterns: [`${directory}/**`],
      depends_on: []
    });
  }
  return {
    include: ["**"],
    exclude: [".repowiki-workspace/**", ".repowiki-node/**", "wiki-output/**"],
    pages
  };
}

/** Deterministic, bounded topic planning from actual scanned evidence, never sample prose. */
function cardPlan(project: Data, paths: string[]): WikiPlan {
  const zh = project.language.startsWith("zh"),
    pages: PageDefinition[] = [];
  const add = (slug: string, title: string, category: string, selected: string[], goal: string) => {
    if (!selected.length || pages.length >= 12) return;
    pages.push({
      id: `cards/${slug}`,
      title,
      category,
      goal: `Create one concise evidence-backed knowledge card. ${goal} Explain constraints and practical implications only when visible in supplied source; distinguish inference. Do not invent product behavior.`,
      patterns: selected.slice(0, 100),
      depends_on: []
    });
  };
  const topics: [string, string, string, RegExp, string][] = [["project-boundaries", zh ? "项目边界与运行入口" : "Project boundaries and entry points", zh ? "项目概览" : "Overview", /(?:^|\/)(?:readme[^/]*|package\.json|pyproject\.toml|cargo\.toml|go\.mod|main\.[^/]+|index\.[^/]+)$/i, "Summarize evidenced repository purpose, entry points, and setup boundaries."], ["interfaces", zh ? "接口与调用约定" : "Interfaces and calling conventions", zh ? "接口与协议" : "Interfaces", /(?:^|\/)(?:api|routes?|controllers?|handlers?|endpoints?|rpc|contracts?)(?:\/|[._-])/i, "Describe actual input/output contracts and calling relationships."], ["persistence", zh ? "数据与持久化约束" : "Data and persistence constraints", zh ? "数据与存储" : "Data", /(?:^|\/)[^/]*(?:storage|database|persist|repository|schema|migration|store)[^/]*(?:\/|$)/i, "Describe actual data ownership, persistence operations, and integrity constraints."], ["safety", zh ? "校验与安全边界" : "Validation and safety boundaries", zh ? "约束与安全" : "Safety", /(?:^|\/)[^/]*(?:auth|security|permission|validat|guard|saniti)[^/]*(?:\/|$)/i, "Describe observed validation and trust boundaries; do not claim security guarantees beyond source."], ["verification", zh ? "测试与验证要点" : "Tests and verification", zh ? "验证与测试" : "Verification", /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|[._-])|\.(?:test|spec)\./i, "Summarize assertions actually implemented and their verification limits."]];
  for (const [slug, title, category, pattern, goal] of topics) add(slug, title, category, paths.filter(file => pattern.test(file)), goal);
  const directories = [...new Set(paths.filter(file => file.includes("/")).map(file => {
    const parts = file.split("/");
    return ["src", "app", "lib", "packages"].includes(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
  }))].sort();
  for (const directory of directories) add(`module-${hash(directory).slice(0, 12)}`, zh ? `${directory} 的职责与依赖` : `${directory}: responsibilities and dependencies`, zh ? "模块知识" : "Modules", paths.filter(file => file.startsWith(directory + "/")), `Describe responsibilities and observable dependencies of ${directory}.`);
  if (!pages.length && paths.length) add("source-entry", zh ? "源码阅读入口" : "Source reading entry", zh ? "源码知识" : "Source", paths, "Describe actual symbols and dependencies visible in these source files.");
  return {
    include: [...project.plan.include],
    exclude: [...project.plan.exclude],
    pages
  };
}
export class WorkspaceEngine {
  readonly data_dir: string;
  private db: DatabaseLike;
  private generating = new Set<string>();
  private readonly files = new Map<string, ProjectFiles>();
  private readonly dirtyProjects = new Set<string>();
  private readonly scans = new Map<string, {
    context: ReturnType<typeof scanRepository>;
    scanned_at: string;
  }>();
  private readonly scanFlights = new Map<string, {
    controller: AbortController;
    promise: Promise<ReturnType<typeof scanRepository>>;
    users: number;
  }>();
  private readonly legacyDataDir: string;
  private readonly snapshotLegacy: NonNullable<WorkspaceEngineOptions["snapshotLegacy"]>;
  constructor(data_dir: string, options: WorkspaceEngineOptions = {}) {
    mkdirSync(data_dir, {
      recursive: true
    });
    this.data_dir = realpathSync(data_dir);
    this.legacyDataDir = options.legacyDataDir ?? this.data_dir;
    this.snapshotLegacy = options.snapshotLegacy ?? (async (from, to, signal) => {
      // Direct/standalone compatibility. Embedded hosts inject an interruptible
      // worker running the same validated copy-first algorithm.
      checkAborted(signal);
      const result = migrateWorkspace(from, to);
      checkAborted(signal);
      return result;
    });
    const dbPath = path.join(this.data_dir, PROJECT_CACHE_DATABASE);
    if (existsSync(dbPath) && (lstatSync(dbPath).isSymbolicLink() || !lstatSync(dbPath).isFile())) throw new WorkspaceError("Workspace database must be a regular file");
    let openedCache: DatabaseLike | undefined;
    try {
      openedCache = options.databaseFactory ? options.databaseFactory(dbPath) : new DatabaseSync(dbPath);
      this.db = openedCache;
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS snapshots (project_id TEXT, namespace TEXT, data TEXT NOT NULL, PRIMARY KEY(project_id, namespace));
      CREATE TABLE IF NOT EXISTS pages (project_id TEXT, namespace TEXT, slug TEXT, data TEXT NOT NULL, PRIMARY KEY(project_id, namespace, slug));
      CREATE TABLE IF NOT EXISTS generation_cache (fingerprint TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generation_checkpoints (project_id TEXT NOT NULL, namespace TEXT NOT NULL, run_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id, namespace, run_id, fingerprint));
      CREATE TABLE IF NOT EXISTS cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      const identityVersion = "workspace-language-portable-v1";
      if (this.db.prepare("SELECT value FROM cache_metadata WHERE key='project_identity'").get()?.value !== identityVersion) {
        // Only the disposable projection changes identity. Portable facts and the
        // original workspace.sqlite3 are never rewritten by a cache upgrade.
        this.db.exec("BEGIN IMMEDIATE; DELETE FROM projects; DELETE FROM pages; DELETE FROM snapshots; DELETE FROM revisions; DELETE FROM generation_checkpoints; COMMIT;");
        this.db.prepare("INSERT OR REPLACE INTO cache_metadata VALUES ('project_identity',?)").run(identityVersion);
      }
    } catch (error) {
      try { openedCache?.close(); } catch { /* Failed cache handles must not remain open. */ }
      const failure = new WorkspaceError("Repo Wiki cache is unavailable; project files are unchanged. Remove or rebuild the disposable project-index.sqlite3 and retry.", 503);
      failure.cause = error;
      throw failure;
    }
  }
  close(): void {
    if (this.generating.size) throw new WorkspaceError("Generation must finish or be canceled before closing the workspace", 409);
    for (const flight of this.scanFlights.values()) flight.controller.abort();
    this.scanFlights.clear();
    this.db.close();
  }
  private transaction<T>(id: string, operation: () => T): T {
    this.refreshProject(id);
    this.dirtyProjects.clear();
    this.db.exec("BEGIN IMMEDIATE");
    let filesPublished = false;
    try {
      const result = operation();
      for (const id of this.dirtyProjects) this.files.get(id)!.commit(this.exportFacts(id));
      filesPublished = this.dirtyProjects.size > 0;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the triggering failure; facts are never rolled back. */ }
      if (filesPublished) {
        const recovery = new WorkspaceError("Knowledge files were saved, but the cache update failed. Reload the project or rebuild its disposable cache.", 503);
        recovery.cause = error;
        throw recovery;
      }
      throw error;
    }
  }
  private project(id: string): Data {
    this.files.get(id)?.assertReadable();
    const row = this.db.prepare("SELECT data FROM projects WHERE id=?").get(id);
    if (!row) throw new WorkspaceError("Project not found", 404);
    return JSON.parse(String(row.data));
  }
  private saveProject(project: Data): void {
    this.dirtyProjects.add(project.id);
    this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(project.id, canonicalJson(project));
  }
  private snapshot(id: string, ns: string): Data {
    const row = this.db.prepare("SELECT data FROM snapshots WHERE project_id=? AND namespace=?").get(id, ns);
    return row ? JSON.parse(String(row.data)) : {
      hashes: {},
      edges: [],
      identity: {}
    };
  }
  private pages(id: string, ns: string): Record<string, Data> {
    const pages = Object.create(null);
    for (const row of this.db.prepare("SELECT slug,data FROM pages WHERE project_id=? AND namespace=?").all(id, ns)) pages[String(row.slug)] = JSON.parse(String(row.data));
    return pages;
  }
  private revision(): number {
    return Number(this.db.prepare("INSERT INTO revisions DEFAULT VALUES").run().lastInsertRowid);
  }
  private savePage(id: string, ns: string, page: Data): void {
    this.dirtyProjects.add(id);
    if (page.kind === "card") page.summary = summaryOf(page.markdown);
    page.storage_token = pageStorageToken(page);
    this.db.prepare("INSERT OR REPLACE INTO pages VALUES (?,?,?,?)").run(id, ns, page.id, canonicalJson(page));
  }
  private async scan(project: Data, signal?: AbortSignal) {
    checkAborted(signal);
    const key = canonicalJson([project.id, project.path, project.plan.include, project.plan.exclude, project.language]);
    let flight = this.scanFlights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = scanRepositoryAsync(project.path, {
        include: project.plan.include,
        exclude: project.plan.exclude,
        dataDir: this.data_dir,
        language: project.language
      }, controller.signal);
      flight = {
        controller,
        promise,
        users: 0
      };
      this.scanFlights.set(key, flight);
      const saved = flight;
      void promise.finally(() => {
        if (this.scanFlights.get(key) === saved) this.scanFlights.delete(key);
      }).catch(() => {});
    }
    const current = flight;
    current.users++;
    return new Promise<ReturnType<typeof scanRepository>>((resolve, reject) => {
      let ended = false;
      const finish = (callback: () => void) => {
        if (ended) return;
        ended = true;
        signal?.removeEventListener("abort", abort);
        current.users--;
        callback();
      };
      const abort = () => finish(() => {
        if (current.users === 0) {
          if (this.scanFlights.get(key) === current) this.scanFlights.delete(key);
          current.controller.abort();
        }
        reject(signal?.reason instanceof Error ? signal.reason : new WorkspaceError("Operation canceled", 499));
      });
      signal?.addEventListener("abort", abort, {
        once: true
      });
      if (signal?.aborted) abort();
      current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  private currentNamespace(project: Data, target: ContentTarget = "wiki"): string {
    if (!project.current_identity && project.active_namespaces?.[target]) return project.active_namespaces[target];
    return namespace(project.current_identity ?? project.identity ?? {
      branch: "local",
      language: project.language
    }, target);
  }
  private pageNamespace(project: Data, slug: string): string {
    const wiki = this.currentNamespace(project);
    if (own(this.pages(project.id, wiki), slug)) return wiki;
    return this.currentNamespace(project, "cards");
  }
  private knowledgeState(project: Data, target: ContentTarget, ns: string, pages: Data[]): Data {
    const snapshot = this.snapshot(project.id, ns);
    const legacy = project.last_run;
    const compatibleLegacy = target === "wiki" && pages.length > 0 && Boolean(snapshot.updated_at) && (legacy?.target ?? "wiki") === "wiki" && legacy?.identity?.branch === snapshot.identity?.branch && legacy?.identity?.language === snapshot.identity?.language;
    return {
      count: pages.filter(page => page.status !== "archived").length,
      namespace: ns,
      native_catalogue: snapshot.nativeCatalogue,
      engine: snapshot.engine,
      native_coverage: snapshot.engine === 'qoder-wiki-local-v1' ? snapshot.coverage : undefined,
      native_publication_id: snapshot.nativePublicationId,
      identity: snapshot.identity ?? {},
      updated_at: snapshot.updated_at ?? null,
      last_run: snapshot.last_run ?? (compatibleLegacy ? legacy : null),
      status: snapshot.updated_at ? "generated" : "not_generated"
    };
  }
  private importFacts(facts: ProjectFacts, store: ProjectFiles): void {
    const p = facts.project;
    const portableId = p.id;
    p.portable_id = portableId;
    p.id = hash(["repo-wiki-runtime-project-v1", workspaceIdentity(store.root), store.language, portableId]).slice(0, 24);
    this.files.set(p.id, store);
    this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(p.id, canonicalJson(p));
    this.db.prepare("DELETE FROM pages WHERE project_id=?").run(p.id);
    this.db.prepare("DELETE FROM snapshots WHERE project_id=?").run(p.id);
    let revision = Number(p.next_revision) || 0;
    for (const [ns, pages] of Object.entries(facts.pages)) for (const page of Object.values(pages)) {
      revision = Math.max(revision, page.revision);
      this.db.prepare("INSERT OR REPLACE INTO pages VALUES (?,?,?,?)").run(p.id, ns, page.id, canonicalJson(page));
    }
    for (const [ns, snapshot] of Object.entries(facts.snapshots)) this.db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)").run(p.id, ns, canonicalJson(snapshot));
    const max = Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS revision FROM revisions").get()!.revision);
    if (revision > max) this.db.prepare("INSERT INTO revisions(id) VALUES (?)").run(revision);
  }
  private exportFacts(id: string): ProjectFacts {
    const project = this.project(id),
      pages: ProjectFacts["pages"] = {},
      snapshots: ProjectFacts["snapshots"] = {};
    for (const row of this.db.prepare("SELECT namespace,slug,data FROM pages WHERE project_id=?").all(id)) (pages[String(row.namespace)] ??= Object.create(null))[String(row.slug)] = JSON.parse(String(row.data));
    for (const row of this.db.prepare("SELECT namespace,data FROM snapshots WHERE project_id=?").all(id)) snapshots[String(row.namespace)] = JSON.parse(String(row.data));
    project.next_revision = Number(this.db.prepare("SELECT COALESCE(MAX(id),0) AS revision FROM revisions").get()!.revision);
    return {
      project,
      pages,
      snapshots
    };
  }
  private refreshProject(id: string): void {
    const old = this.project(id);
    let store = this.files.get(id);
    if (!store) {
      store = new ProjectFiles(old.path, old.language);
      this.files.set(id, store);
    }
    const facts = store.load();
    if (facts.project.id !== old.portable_id) throw new WorkspaceError("Project facts identity changed; hydrate the current project before continuing", 409);
    if (old.current_identity) facts.project.current_identity = old.current_identity;
    this.importFacts(facts, store);
  }
  /** Rebuild the disposable projection after an external publication. */
  refreshKnowledgeProject(id: string, identity?: {branch:string;language:string}): void { this.refreshProject(id); if (identity) { const project = this.project(id); project.current_identity = identity; this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(id, canonicalJson(project)); } }
  /** Reuse a completed kernel scan for the existing read-only changes projection. */
  recordKnowledgeScan(id: string, context: ReturnType<typeof scanRepository>): void {
    const project = this.project(id); project.current_identity = context.identity;
    this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(id, canonicalJson(project));
    this.scans.set(id, { context, scanned_at: now() });
  }
  private retireProject(id: string): void {
    this.files.delete(id);
    this.scans.delete(id);
    for (const [key, flight] of this.scanFlights) if (JSON.parse(key)[0] === id) {
      this.scanFlights.delete(key);
      flight.controller.abort();
    }
    this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    this.db.prepare("DELETE FROM pages WHERE project_id=?").run(id);
    this.db.prepare("DELETE FROM snapshots WHERE project_id=?").run(id);
  }
  private root(input: string): string {
    if (typeof input !== "string" || !input.trim()) throw new WorkspaceError("Repository path is required");
    const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
    if (!existsSync(expanded) || !statSync(expanded).isDirectory()) throw new WorkspaceError("Repository directory does not exist", 404);
    return realpathSync(expanded);
  }
  private openProject(root: string, language: string, name?: string | null, facts?: ProjectFacts): Data {
    if (name != null && (typeof name !== "string" || name.length > 200)) throw new WorkspaceError("Project name must be at most 200 characters");
    const store = new ProjectFiles(root, language);
    if (store.present) facts = store.load();
    if (!facts) {
      let plan = defaultPlan([], language);
      const planPath = path.join(root, "wiki_plan.json");
      if (existsSync(planPath)) {
        const st = lstatSync(planPath);
        if (st.isSymbolicLink() || !st.isFile() || st.size > 100000) throw new WorkspaceError("wiki_plan.json must be a regular file no larger than 100 KB");
        try {
          plan = validate_plan(JSON.parse(new TextDecoder("utf-8", {
            fatal: true
          }).decode(readFileSync(planPath))));
        } catch (e) {
          if (e instanceof WorkspaceError) throw e;
          throw new WorkspaceError("wiki_plan.json must contain valid UTF-8 JSON");
        }
      }
      facts = {
        project: {
          id: randomUUID().replaceAll("-", "").slice(0, 12),
          name: name || path.basename(root),
          path: root,
          language,
          watch: false,
          plan,
          created_at: now(),
          updated_at: now(),
          last_run: null,
          identity: {
            branch: "local",
            language
          },
          next_revision: 0
        },
        pages: {},
        snapshots: {}
      };
    }
    if (!store.present) {
      store.commit(facts);
      facts = store.load();
    }
    this.importFacts(facts, store);
    return this.get_project(facts.project.id);
  }
  create_project(input: string, language = "zh", name?: string | null): Data {
    const root = this.root(input),
      store = new ProjectFiles(root, language);
    if (!store.present && existsSync(path.join(this.legacyDataDir, "workspace.sqlite3"))) throw new WorkspaceError("Legacy project requires asynchronous hydration before creating knowledge", 409);
    return this.openProject(root, language, name);
  }
  async hydrate_project(input: string, language = "zh", name?: string | null, options: {
    signal?: AbortSignal;
  } = {}): Promise<Data> {
    checkAborted(options.signal);
    const root = this.root(input),
      store = new ProjectFiles(root, language);
    for (const [id, known] of this.files) if (known.root === root && known.language === language) {
      try {
        known.assertReadable();
        if (known.readPortableIdentity() === this.project(id).portable_id) return this.get_project(id);
        this.retireProject(id);
        break;
      } catch (e) {
        if (!(e instanceof WorkspaceError) || e.status !== 409) throw e;
        break;
      }
    }
    let facts: ProjectFacts | undefined;
    if (!store.present && existsSync(path.join(this.legacyDataDir, "workspace.sqlite3"))) {
      await new Promise<void>(resolve => setImmediate(resolve));
      checkAborted(options.signal);
      const temporary = mkdtempSync(path.join(os.tmpdir(), "repowiki-legacy-copy-")),
        copyPath = path.join(temporary, "snapshot");
      let copy: DatabaseSync | undefined;
      try {
        const receipt = await this.snapshotLegacy(this.legacyDataDir, copyPath, options.signal);
        checkAborted(options.signal);
        copy = new DatabaseSync(path.join(copyPath, "workspace.sqlite3"), {
          readOnly: true
        });
        const key = (value: string) => process.platform === "win32" ? path.resolve(value).replace(/^\\\\\?\\/, "").toLowerCase() : path.resolve(value);
        const matches = copy.prepare("SELECT data FROM projects").all().map(r => JSON.parse(String(r.data))).filter(p => key(p.path) === key(root) && p.language === language);
        if (matches.length > 1) throw new WorkspaceError("Ambiguous legacy project migration", 409);
        if (matches.length) {
          const project = matches[0];
          project.path = root;
          project.watch = false;
          facts = {
            project,
            pages: {},
            snapshots: {},
            migration: {
              schema_version: 1,
              legacy_project_id: project.id,
              source_hashes: receipt.source_hashes,
              completed_at: receipt.completed_at,
              source_mode: receipt.source_mode
            }
          };
          for (const row of copy.prepare("SELECT namespace,slug,data FROM pages WHERE project_id=?").all(project.id)) (facts.pages[String(row.namespace)] ??= Object.create(null))[String(row.slug)] = JSON.parse(String(row.data));
          for (const row of copy.prepare("SELECT namespace,data FROM snapshots WHERE project_id=?").all(project.id)) facts.snapshots[String(row.namespace)] = JSON.parse(String(row.data));
          project.active_namespaces = {};
          for (const [ns, pages] of Object.entries(facts.pages)) {
            const target = Object.values(pages).some(p => p.kind === "card") ? "cards" : "wiki";
            project.active_namespaces[target] ??= ns;
          }
          project.next_revision = Math.max(0, ...Object.values(facts.pages).flatMap(pages => Object.values(pages).map(p => p.revision)));
          project.identity = project.identity && Object.keys(project.identity).length ? project.identity : Object.values(facts.snapshots)[0]?.identity ?? {
            branch: "local",
            language
          };
        }
      } finally {
        copy?.close();
        if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith("repowiki-legacy-copy-")) rmSync(temporary, {
          recursive: true,
          force: true
        });
      }
    }
    checkAborted(options.signal);
    return this.openProject(root, language, name, facts);
  }
  list_projects(): Data[] {
    for (const store of this.files.values()) store.assertReadable();
    return this.db.prepare("SELECT data FROM projects ORDER BY rowid DESC").all().map(row => {
      const project = JSON.parse(String(row.data)),
        pages = Object.values(this.pages(project.id, this.currentNamespace(project))),
        cards = Object.values(this.pages(project.id, this.currentNamespace(project, "cards")));
      return {
        ...project,
        identity: project.current_identity ?? project.identity ?? {
          branch: "local",
          language: project.language
        },
        page_count: pages.filter(page => page.status !== "archived").length,
        card_count: cards.filter(page => page.status !== "archived").length,
        knowledge: {
          wiki: this.knowledgeState(project, "wiki", this.currentNamespace(project), pages),
          cards: this.knowledgeState(project, "cards", this.currentNamespace(project, "cards"), cards)
        },
        conflict_count: [...pages, ...cards].filter(page => page.status === "conflict").length
      };
    });
  }
  get_project(id: string): Data {
    const project = this.project(id),
      ns = this.currentNamespace(project),
      snapshot = this.snapshot(id, ns),
      pages = Object.values(this.pages(id, ns)),
      cardNamespace = this.currentNamespace(project, "cards"),
      cards = Object.values(this.pages(id, cardNamespace)).sort((a, b) => a.id.localeCompare(b.id));
    const order = new Map<string, number>(project.plan.pages.map((page: PageDefinition, index: number) => [page.id, index]));
    pages.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999) || a.id.localeCompare(b.id));
    return {
      ...project,
      plan_storage_token: hash(project.plan),
      pages,
      cards,
      page_count: pages.filter(page => page.status !== "archived").length,
      card_count: cards.filter(page => page.status !== "archived").length,
      knowledge: {
        wiki: this.knowledgeState(project, "wiki", ns, pages),
        cards: this.knowledgeState(project, "cards", cardNamespace, cards)
      },
      identity: Object.keys(snapshot.identity ?? {}).length ? snapshot.identity : project.current_identity ?? project.identity ?? {
        branch: "local",
        language: project.language
      },
      namespace: ns,
      native_catalogue: snapshot.nativeCatalogue,
      stats: {
        files: Object.keys(snapshot.hashes).length,
        pages: pages.filter(page => page.status !== "archived").length,
        cards: cards.filter(page => page.status !== "archived").length,
        dependencies: snapshot.edges.length,
        conflicts: pages.filter(page => page.status === "conflict").length,
        edited: pages.filter(page => page.status === "edited").length,
        coverage: snapshot.coverage ?? null
      }
    };
  }
  get_page(id: string, slug: string): Data {
    safeRelative(slug);
    this.refreshProject(id);
    const project = this.project(id);
    const page = this.pages(id, this.pageNamespace(project, slug))[slug];
    if (!page) throw new WorkspaceError("Page not found in this branch/language", 404);
    return page;
  }
  changes(id: string, target: ContentTarget = "wiki"): Data {
    checkedTarget(target);
    const project = this.project(id),
      cached = this.scans.get(id),
      context = cached?.context;
    if (!context) return {
      target,
      scan_state: "unknown",
      scanned_at: null,
      changed: [],
      added: [],
      deleted: [],
      renamed: [],
      affected_pages: [],
      identity: project.current_identity ?? project.identity ?? {},
      changed_count: 0,
      files: 0,
      edges: [],
      identity_changed: false
    };
    const {
        hashes,
        edges
      } = context,
      ns = namespace(context.identity, target),
      old = this.snapshot(id, ns),
      pages = this.pages(id, ns),
      previous = old.hashes,
      plan: WikiPlan = target === "cards" ? cardPlan(project, Object.keys(hashes).sort()) : project.plan;
    const added = Object.keys(hashes).filter(file => !own(previous, file)).sort(),
      deleted = Object.keys(previous).filter(file => !own(hashes, file)).sort(),
      changed = Object.keys(hashes).filter(file => own(previous, file) && hashes[file] !== previous[file]).sort();
    const remaining = [...added],
      renamed: {
        from: string;
        to: string;
      }[] = [];
    for (const before of deleted) {
      const after = remaining.find(file => hashes[file] === previous[before]);
      if (after) {
        renamed.push({
          from: before,
          to: after
        });
        remaining.splice(remaining.indexOf(after), 1);
      }
    }
    const impacted = walkEdges([...added, ...deleted, ...changed], [...old.edges, ...edges], true);
    let affected = new Set<string>();
    for (const page of plan.pages) {
      const prior = pages[page.id];
      const relatedTextChanged = prior && page.depends_on.some(dep => prior.related_page_hashes?.[dep] !== hash(pages[dep]?.markdown ?? ""));
      if (old.plan_hash !== hash(plan) || !prior || relatedTextChanged || [...impacted].some(file => matches(file, page.patterns)) || (prior.dependencies ?? []).some((file: string) => impacted.has(file))) affected.add(page.id);
    }
    affected = walkEdges(affected, plan.pages.flatMap(page => page.depends_on.map(dep => [page.id, dep])), true);
    return {
      target,
      scan_state: "ready",
      scanned_at: cached!.scanned_at,
      changed,
      added,
      deleted,
      renamed,
      affected_pages: [...affected].sort(),
      identity: context.identity,
      changed_count: changed.length + added.length + deleted.length,
      files: context.files.length,
      edges,
      identity_changed: ["branch", "commit", "language"].some(key => context.identity[key] !== old.identity?.[key])
    };
  }
  async scan_project(id: string, options: {
    target?: ContentTarget;
    signal?: AbortSignal;
  } = {}): Promise<Data> {
    checkedTarget(options.target ?? "wiki");
    this.refreshProject(id);
    const project = this.project(id);
    const context = await this.scan(project, options.signal);
    checkAborted(options.signal);
    project.current_identity = context.identity;
    this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(id, canonicalJson(project));
    this.scans.set(id, {
      context,
      scanned_at: now()
    });
    return this.changes(id, options.target ?? "wiki");
  }
  static validate_output(output: unknown, files: Record<string, Data>): Data {
    if (!object(output) || typeof output.markdown !== "string") throw new WorkspaceError("Provider returned invalid page content");
    const markdown = output.markdown;
    if (!markdown.trim() || Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new WorkspaceError("Provider page is empty or too large");
    const sources = output.sources;
    if (!Array.isArray(sources) || sources.length > 3000) throw new WorkspaceError("Provider must return a bounded source reference list");
    if (Object.keys(files).length && !sources.length) throw new WorkspaceError("Generated page must cite supplied source evidence");
    const validated: Data[] = [],
      seen = new Set<string>();
    for (const source of sources) {
      if (!object(source)) throw new WorkspaceError("Invalid source reference");
      const file = safeRelative(source.path ?? ""),
        start = source.start_line,
        end = source.end_line;
      if (!own(files, file) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > end || end > Math.max(1, sourceLines(files[file].content).length)) throw new WorkspaceError("Provider cited a missing file or out-of-range source lines");
      const key = canonicalJson([file, start, end]);
      if (!seen.has(key)) {
        validated.push({
          path: file,
          start_line: start,
          end_line: end,
          hash: files[file].hash
        });
        seen.add(key);
      }
    }
    // Inline links, angle autolinks, and reference definitions are all rendered
    // by Markdown. Validate each form rather than only the provider's preferred
    // inline syntax. Conservative rejection is safer than an invented citation.
    for (const match of markdown.matchAll(/(?:\]\(\s*<?|<|\]\s*:\s*<?)(source:[^\s)>]+)/g)) {
      const citation = /^source:([^#]+)#L(\d+)(?:-L?(\d+))?$/.exec(match[1]);
      if (!citation) throw new WorkspaceError("Markdown contains a malformed source citation");
      let file: string;
      try {
        file = decodeURIComponent(citation[1]);
      } catch {
        throw new WorkspaceError("Markdown contains an invalid source citation");
      }
      const start = Number(citation[2]),
        end = Number(citation[3] ?? citation[2]);
      if (!own(files, file) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > Math.max(1, sourceLines(files[file].content).length)) throw new WorkspaceError("Markdown contains an invalid source citation");
    }
    return {
      markdown,
      sources: validated
    };
  }
  async generate(id: string, provider: GenerationProvider, force = false, progress?: Progress, target: ContentTarget = "wiki", options: {
    signal?: AbortSignal;
    resumeRunId?: string;
  } = {}): Promise<Data> {
    checkedTarget(target);
    if (options.resumeRunId !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.resumeRunId)) throw new WorkspaceError("Invalid generation task identity");
    if (this.generating.has(id)) throw new WorkspaceError("Generation is already running for this project", 409);
    this.generating.add(id);
    try {
      return await this.generateStaged(id, provider, force, progress, target, options.signal, options.resumeRunId);
    } finally {
      this.generating.delete(id);
    }
  }
  private async generateStaged(id: string, provider: GenerationProvider, force: boolean, progress?: Progress, target: ContentTarget = "wiki", signal?: AbortSignal, resumeRunId?: string): Promise<Data> {
    const emit = (stage: string, amount: number, message: string, extra: Data = {}) => progress?.({
      stage,
      progress: amount,
      message,
      target,
      ...extra
    });
    checkAborted(signal);
    this.refreshProject(id);
    emit("scanning", 3, "Scanning source files and resolving dependencies");
    const project = this.project(id),
      context = await this.scan(project, signal),
      {
        hashes,
        edges
      } = context,
      ns = namespace(context.identity, target),
      previous = this.pages(id, ns);
    // Only the latest task in a namespace needs its unpublished page outputs.
    // Force bypasses the shared cache, but must not repeat this task's paid work.
    if (resumeRunId) this.db.prepare("DELETE FROM generation_checkpoints WHERE project_id=? AND namespace=? AND run_id<>?").run(id, ns, resumeRunId);
    project.current_identity = context.identity;
    this.db.prepare("INSERT OR REPLACE INTO projects VALUES (?,?)").run(id, canonicalJson(project));
    this.scans.set(id, {
      context,
      scanned_at: now()
    });
    const files: Record<string, Data> = Object.create(null);
    for (const file of context.files) files[file.path] = {
      ...file,
      hash: hashes[file.path]
    };
    const plan: WikiPlan = target === "cards" ? cardPlan(project, Object.keys(hashes).sort()) : project.plan,
      staged: Record<string, Data> = Object.create(null),
      pending = [...plan.pages];
    const opposite = this.pages(id, this.currentNamespace(project, target === "wiki" ? "cards" : "wiki"));
    if (plan.pages.some(page => own(opposite, page.id))) throw new WorkspaceError("Wiki and card IDs collide; rename the wiki page before generating cards", 409);
    const result: Data = {
      generated: 0,
      target,
      cached: 0,
      resumed: 0,
      unchanged: 0,
      merged: 0,
      conflicts: 0,
      archived: 0,
      identity: context.identity,
      provider: provider.name ?? "unknown",
      pages: [],
      started_at: now()
    };
    while (pending.length) {
      checkAborted(signal);
      const index = pending.findIndex(page => page.depends_on.every(dep => own(staged, dep)));
      if (index < 0) throw new WorkspaceError("Page dependencies must not contain cycles");
      const page = pending.splice(index, 1)[0],
        direct = new Set(Object.keys(files).filter(file => matches(file, page.patterns))),
        dependencies = new Set([...walkEdges(direct, edges)].filter(file => own(files, file)));
      const selected: Record<string, Data> = Object.create(null),
        truncated: string[] = [];
      let budget = MAX_CONTEXT_CHARS;
      const priority = [...dependencies].sort((a, b) => Number(!direct.has(a)) - Number(!direct.has(b)) || a.localeCompare(b));
      for (const file of priority.slice(0, MAX_CONTEXT_FILES)) {
        if (budget <= 0) break;
        const original = files[file].content as string,
          limit = Math.min(MAX_FILE_CONTEXT_CHARS, budget);
        let excerpt = original.slice(0, limit);
        if (excerpt.length < original.length) {
          excerpt = excerpt.includes("\n") ? excerpt.slice(0, excerpt.lastIndexOf("\n") + 1) : "";
          truncated.push(file);
        }
        if (!excerpt) continue;
        selected[file] = {
          ...files[file],
          content: excerpt,
          truncated: excerpt.length < original.length,
          total_lines: Math.max(1, sourceLines(original).length)
        };
        budget -= excerpt.length;
      }
      const coverage = {
        available_files: dependencies.size,
        provided_files: Object.keys(selected).length,
        provided_characters: MAX_CONTEXT_CHARS - budget,
        truncated_files: truncated,
        omitted_files: [...dependencies].filter(file => !own(selected, file)).sort(),
        partial: Object.keys(selected).length < dependencies.size || Boolean(truncated.length)
      };
      const relevantEdges = edges.filter(edge => dependencies.has(edge[0]) && dependencies.has(edge[1]));
      const relatedPages = page.depends_on.map(dep => ({
        id: dep,
        markdown: staged[dep].markdown ?? previous[dep]?.markdown ?? ""
      }));
      const relatedHashes = Object.fromEntries(relatedPages.map(related => [related.id, hash(related.markdown)]));
      const fingerprint = hash({
        engine: ENGINE_VERSION,
        provider: provider.cache_key,
        project: project.path,
        namespace: ns,
        page,
        scope: [plan.include, plan.exclude],
        navigation: plan.pages.map(item => ({
          id: item.id,
          title: item.title
        })),
        sources: Object.fromEntries([...dependencies].sort().map(file => [file, hashes[file]])),
        edges: relevantEdges,
        page_dependencies: Object.fromEntries(page.depends_on.map(dep => [dep, {
          fingerprint: staged[dep].fingerprint,
          markdown_hash: relatedHashes[dep]
        }]))
      });
      const old = previous[page.id];
      emit("generating", 10 + Math.floor(75 * Object.keys(staged).length / plan.pages.length), `Preparing ${page.title}`, {
        page_id: page.id
      });
      if (!force && old && old.fingerprint === fingerprint && old.status !== "archived") {
        staged[page.id] = {
          unchanged: true,
          fingerprint,
          definition: page
        };
        result.unchanged++;
        continue;
      }
      const checkpoint = resumeRunId ? this.db.prepare("SELECT data FROM generation_checkpoints WHERE project_id=? AND namespace=? AND run_id=? AND fingerprint=?").get(id, ns, resumeRunId, fingerprint) : undefined;
      const cached = checkpoint ?? (force ? undefined : this.db.prepare("SELECT data FROM generation_cache WHERE fingerprint=?").get(fingerprint));
      let cachedOutput: Data | undefined;
      if (cached) {
        try { cachedOutput = WorkspaceEngine.validate_output(JSON.parse(String(cached.data)), selected); }
        catch { /* A corrupt derived output is a miss; fact-file failures are outside this guard. */ }
      }
      let output: Data;
      if (cachedOutput) {
        output = cachedOutput;
        if (checkpoint) result.resumed++; else result.cached++;
      } else {
        output = WorkspaceEngine.validate_output(await provider.generate_page({
          kind: target === "cards" ? "card" : "wiki",
          ...(target === "cards" ? {
            card_category: page.category ?? "源码知识"
          } : {}),
          page_id: page.id,
          title: page.title,
          goal: page.goal,
          language: project.language,
          files: Object.values(selected),
          direct_sources: [...direct].sort(),
          edges: relevantEdges,
          project_name: project.name,
          coverage,
          page_links: plan.pages.map(item => ({
            id: item.id,
            title: item.title
          })),
          related_pages: relatedPages
        }), selected);
        result.generated++;
      }
      checkAborted(signal);
      if (resumeRunId) this.db.prepare("INSERT OR REPLACE INTO generation_checkpoints VALUES (?,?,?,?,?)").run(id, ns, resumeRunId, fingerprint, canonicalJson(output));
      staged[page.id] = {
        ...output,
        fingerprint,
        definition: page,
        dependencies: [...dependencies].sort(),
        direct_sources: [...direct].sort(),
        related_page_hashes: relatedHashes,
        coverage
      };
      emit("generating", 10 + Math.floor(75 * Object.keys(staged).length / plan.pages.length), `Prepared ${page.title}`, {
        page_id: page.id,
        completed_pages: Object.keys(staged).length,
        total_pages: plan.pages.length
      });
    }
    emit("validating", 90, "Validating source snapshot and preserving manual edits");
    const final = await this.scan(project, signal);
    checkAborted(signal);
    if (canonicalJson(final.hashes) !== canonicalJson(hashes) || namespace(final.identity, target) !== ns || final.identity.commit !== context.identity.commit) throw new WorkspaceError("Repository changed during generation; no pages were written. Retry against the current worktree.", 409);
    emit("committing", 95, "Committing validated wiki changes");
    checkAborted(signal);
    this.transaction(id, () => {
      const current = this.project(id);
      if (canonicalJson(current.plan) !== canonicalJson(project.plan)) throw new WorkspaceError("wiki_plan changed during generation; no pages were written. Retry.", 409);
      const latest = this.pages(id, ns);
      for (const [slug, entry] of Object.entries(staged)) {
        if (entry.unchanged) {
          result.pages.push({
            id: slug,
            action: "unchanged"
          });
          continue;
        }
        const old = latest[slug];
        let [markdown, conflict] = old ? three_way_merge(old.baseline ?? "", old.markdown, entry.markdown) : [entry.markdown, false] as [string, boolean];
        if (old?.status === "conflict" && old.pending_markdown !== entry.markdown) {
          markdown = old.markdown;
          conflict = true;
        }
        if (conflict) result.conflicts++;else if (old && old.markdown !== old.baseline && markdown !== entry.markdown) result.merged++;
        const page: Data = {
          id: slug,
          kind: target === "cards" ? "card" : "wiki",
          ...(target === "cards" ? {
            category: entry.definition.category ?? "源码知识"
          } : {}),
          title: entry.definition.title,
          goal: entry.definition.goal,
          markdown,
          baseline: conflict && old ? old.baseline ?? "" : entry.markdown,
          pending_markdown: conflict ? entry.markdown : null,
          status: conflict ? "conflict" : markdown !== entry.markdown ? "edited" : "ready",
          revision: this.revision(),
          sources: conflict && old ? old.sources ?? [] : entry.sources,
          pending_sources: conflict ? entry.sources : null,
          dependencies: entry.dependencies,
          direct_sources: entry.direct_sources,
          related_page_hashes: entry.related_page_hashes,
          coverage: entry.coverage,
          fingerprint: entry.fingerprint,
          identity: context.identity,
          provider: result.provider,
          updated_at: now()
        };
        this.savePage(id, ns, page);
        this.db.prepare("INSERT OR REPLACE INTO generation_cache VALUES (?,?)").run(entry.fingerprint, canonicalJson({
          markdown: entry.markdown,
          sources: entry.sources
        }));
        result.pages.push({
          id: slug,
          action: page.status
        });
      }
      for (const [slug, page] of Object.entries(latest)) if (!own(staged, slug) && page.status !== "archived") {
        Object.assign(page, {
          status: "archived",
          revision: this.revision(),
          updated_at: now()
        });
        this.savePage(id, ns, page);
        result.archived++;
      }
      const snapshot = {
        hashes,
        edges,
        plan_hash: hash(plan),
        identity: context.identity,
        updated_at: now(),
        definitions: plan.pages,
        target,
        coverage: {
          ...context.coverage,
          included: Object.keys(files).length,
          scope_note: "Scanner limits and wiki_plan exclusions apply; dependencies are best-effort static imports."
        }
      };
      result.completed_at = now();
      Object.assign(snapshot, {
        last_run: result
      });
      this.db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)").run(id, ns, canonicalJson(snapshot));
      Object.assign(current, {
        last_run: result,
        identity: context.identity,
        updated_at: now()
      });
      this.saveProject(current);
    });
    emit("complete", 100, target === "cards" ? "Knowledge cards saved; human edits preserved" : "Wiki saved; human edits preserved");
    return result;
  }
  private checkMarkdown(markdown: unknown): asserts markdown is string {
    if (typeof markdown !== "string" || Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new WorkspaceError("Markdown must be a string no larger than 2 MB");
  }
  edit_page(id: string, slug: string, markdown: string, expected_revision: number, expected_storage_token?: string): Data {
    this.refreshProject(id);
    this.checkMarkdown(markdown);
    safeRelative(slug);
    return this.transaction(id, () => {
      const project = this.project(id),
        ns = this.pageNamespace(project, slug),
        page = this.pages(id, ns)[slug];
      if (!page) throw new WorkspaceError("Page not found in this branch/language", 404);
      if (page.revision !== expected_revision || expected_storage_token !== undefined && page.storage_token !== expected_storage_token) throw new WorkspaceError("Revision conflict: reload the latest page before saving", 409);
      Object.assign(page, {
        markdown,
        revision: this.revision(),
        updated_at: now()
      });
      if (!["conflict", "archived"].includes(page.status)) page.status = markdown !== page.baseline ? "edited" : "ready";
      this.savePage(id, ns, page);
      return page;
    });
  }
  resolve_page(id: string, slug: string, markdown: string, expected_revision: number, expected_storage_token?: string): Data {
    this.refreshProject(id);
    this.checkMarkdown(markdown);
    safeRelative(slug);
    return this.transaction(id, () => {
      const project = this.project(id),
        ns = this.pageNamespace(project, slug),
        page = this.pages(id, ns)[slug];
      if (!page) throw new WorkspaceError("Page not found in this branch/language", 404);
      if (page.revision !== expected_revision || expected_storage_token !== undefined && page.storage_token !== expected_storage_token) throw new WorkspaceError("Revision conflict: reload the latest page before resolving", 409);
      if (page.status !== "conflict" || page.pending_markdown == null) throw new WorkspaceError("This page has no unresolved generation conflict");
      page.baseline = page.pending_markdown;
      Object.assign(page, {
        markdown,
        sources: page.pending_sources ?? [],
        pending_markdown: null,
        pending_sources: null,
        status: markdown !== page.baseline ? "edited" : "ready",
        revision: this.revision(),
        updated_at: now()
      });
      this.savePage(id, ns, page);
      return page;
    });
  }
  update_plan(id: string, input: unknown, expected_plan_storage_token?: string): Data {
    this.refreshProject(id);
    const plan = validate_plan(input);
    this.transaction(id, () => {
      const project = this.project(id);
      if (expected_plan_storage_token !== undefined && hash(project.plan) !== expected_plan_storage_token) throw new WorkspaceError("Plan revision conflict: reload before saving", 409);
      const cards = this.pages(id, this.currentNamespace(project, "cards"));
      if (plan.pages.some(page => own(cards, page.id))) throw new WorkspaceError("Wiki page IDs must not collide with existing knowledge cards", 409);
      Object.assign(project, {
        plan,
        updated_at: now()
      });
      this.saveProject(project);
    });
    return this.get_project(id);
  }
  set_watch(id: string, enabled: boolean): Data {
    this.refreshProject(id);
    if (typeof enabled !== "boolean") throw new WorkspaceError("Watch enabled must be a boolean");
    this.transaction(id, () => {
      const project = this.project(id);
      Object.assign(project, {
        watch: enabled,
        updated_at: now()
      });
      this.saveProject(project);
    });
    return this.get_project(id);
  }
  export_markdown(id: string, target: ContentTarget = "wiki"): Record<string, string> {
    checkedTarget(target);
    this.refreshProject(id);
    const project = this.get_project(id),
      files: Record<string, string> = Object.create(null),
      manifest: Data = {
        version: 1,
        project_id: id,
        namespace: project.knowledge[target].namespace,
        identity: project.knowledge[target].identity,
        target,
        pages: Object.create(null)
      };
    for (const page of target === "cards" ? project.cards : project.pages) {
      if (page.status === "archived") continue;
      const filename = safeRelative(`${page.id}.md`);
      files[filename] = page.markdown;
      manifest.pages[filename] = {
        revision: page.revision,
        content_hash: hash(page.markdown),
        baseline: page.markdown,
        sources: page.sources
      };
    }
    files[".repowiki-manifest.json"] = JSON.stringify(manifest, null, 2);
    return files;
  }
  import_markdown(id: string, files: Record<string, string>, target: ContentTarget = "wiki"): Data {
    this.refreshProject(id);
    checkedTarget(target);
    if (!object(files) || Object.keys(files).length < 1 || Object.keys(files).length > 100) throw new WorkspaceError("Import must contain 1–100 files");
    if (Object.values(files).reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0) > 10_000_000) throw new WorkspaceError("Import exceeds the 10 MB limit");
    return this.transaction(id, () => {
      const project = this.project(id),
        ns = this.currentNamespace(project, target),
        pages = this.pages(id, ns);
      let manifest: Data | undefined;
      if (own(files, ".repowiki-manifest.json")) {
        try {
          manifest = JSON.parse(files[".repowiki-manifest.json"]);
        } catch {
          throw new WorkspaceError("Invalid Markdown manifest");
        }
        if (!object(manifest) || manifest.version !== 1 || manifest.project_id !== id || manifest.namespace !== ns || (manifest.target ?? "wiki") !== target || !object(manifest.pages)) throw new WorkspaceError("Markdown manifest belongs to a different project, branch, or language");
      }
      const prepared: [Data, string][] = [];
      for (const [filename, input] of Object.entries(files)) {
        safeRelative(filename);
        if (filename === ".repowiki-manifest.json") continue;
        this.checkMarkdown(input);
        let markdown = input;
        if (!filename.endsWith(".md") || !own(pages, filename.slice(0, -3))) throw new WorkspaceError("Only Markdown files for existing pages can be imported");
        const page = pages[filename.slice(0, -3)];
        if (["conflict", "archived"].includes(page.status)) throw new WorkspaceError("Resolve conflicts or restore the page before importing");
        if (manifest) {
          const exported = manifest.pages[filename];
          if (!object(exported) || typeof exported.baseline !== "string" || hash(exported.baseline) !== exported.content_hash) throw new WorkspaceError("Missing or corrupt Markdown manifest page");
          const [merged, conflict] = three_way_merge(exported.baseline, page.markdown, markdown);
          if (conflict) throw new WorkspaceError(`Import conflict for ${filename}: current page and imported file overlap; no files were imported`, 409);
          markdown = merged;
        } else if (page.markdown !== page.baseline && markdown !== page.markdown) throw new WorkspaceError(`Import would overwrite manual edits in ${filename}; export with manifest first`, 409);
        prepared.push([page, markdown]);
      }
      for (const [page, markdown] of prepared) {
        Object.assign(page, {
          markdown,
          revision: this.revision(),
          updated_at: now(),
          status: markdown !== page.baseline ? "edited" : "ready"
        });
        this.savePage(id, ns, page);
      }
      return {
        imported: prepared.length,
        pages: prepared.map(([page]) => page.id)
      };
    });
  }
  read_source(id: string, input: string, start_line = 1, end_line?: number | null): Data {
    const file = safeRelative(input),
      project = this.project(id),
      context = this.scans.get(id)?.context,
      snapshot = this.snapshot(id, this.currentNamespace(project)),
      within = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep); },
      protectedData = within(project.path, this.data_dir) && within(this.data_dir, path.join(project.path, ...file.split("/"))),
      allowed = !protectedData && matches(file, project.plan.include) && !matches(file, project.plan.exclude),
      covered = context ? context.files.some(item => item.path === file) : !snapshot.updated_at || own(snapshot.hashes, file),
      source = allowed && covered ? readSourceFile(project.path, file) : undefined;
    if (!source) throw new WorkspaceError("Source is missing, excluded, unsafe, or outside scan coverage", 404);
    const lines = sourceLines(source.content),
      total = Math.max(1, lines.length);
    end_line ??= Math.min(total, start_line + 199);
    if (!Number.isInteger(start_line) || !Number.isInteger(end_line) || start_line < 1 || start_line > end_line || end_line > total) throw new WorkspaceError("Source line range is invalid");
    if (end_line - start_line > 1999) throw new WorkspaceError("Source reads are limited to 2000 lines");
    return {
      path: file,
      content: lines.slice(start_line - 1, end_line).join("\n"),
      total_lines: total,
      start_line,
      end_line,
      hash: hash(source.content)
    };
  }
}


