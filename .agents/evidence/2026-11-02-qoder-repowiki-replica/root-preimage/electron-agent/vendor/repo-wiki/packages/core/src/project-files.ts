/** Project-owned facts. SQLite is only a disposable projection of these files. */
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hash, safeRelative, canonicalJson } from "./scanner.js";
import { WorkspaceError, validate_plan } from "./engine.js";
type Data = Record<string, any>;
export const PROJECT_WIKI_DIR = "docs/repo-wiki";
export const PROJECT_CACHE_DATABASE = "project-index.sqlite3";
export interface ProjectFacts {
  project: Data;
  pages: Record<string, Record<string, Data>>;
  snapshots: Record<string, Data>;
  migration?: Data;
}
export interface ProjectExecutionGuard {
  version: 1; scopeIdentity: string; taskId: string; ledgerId: string;
  controllerEpoch: string; ownerId: string; generation: number;
  claimId?: string; publicationId?: string; intentHash?: string; outputSetHash?: string;
}
export interface ProjectPublicationClaim {
  version: 1; taskId: string; claimId: string; publicationId: string; namespace: string;
  fence: { ledgerId: string; controllerEpoch: string; ownerId: string; generation: number };
  intentHash: string; outputSetHash: string;
}
export interface ProjectPublicationReceipt {
  version: 1; taskId: string; claimId: string; publicationId: string;
  ledgerId: string; generation: number; intentHash: string; outputSetHash: string;
  namespace: string; completedAt: string;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const decode = (v: Buffer) => new TextDecoder("utf-8", {
  fatal: true
}).decode(v);
const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
};
const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
function noLinks(root: string, target: string): void {
  if (!inside(root, target)) throw new WorkspaceError("Knowledge path is outside the project", 403);
  let p = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    if (!exists(p)) continue;
    if (fs.lstatSync(p).isSymbolicLink()) throw new WorkspaceError("Knowledge paths must not contain symbolic links", 403);
  }
}
function slug(value: string): string {
  safeRelative(value);
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) throw new WorkspaceError("Invalid knowledge page path");
  return value;
}
// Preserve logical IDs, while keeping Windows devices and case-folding out of
// filenames. The escape prefix itself is encoded, so this mapping is injective.
const fileSlug = (value: string) => slug(value).split("/").map(x => /^[a-z0-9_-]+$/.test(x) && !x.startsWith("_rw_") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(x) ? x : `_rw_${Buffer.from(x).toString("hex")}`).join("/");
export const pageStorageToken = (page: Data): string => {
  const value = clone(page);
  delete value.storage_token;
  delete value.content_hash;
  return hash(value);
};
function bytes(root: string, p: string, limit = 32_000_000): Buffer {
  noLinks(root, p);
  const st = fs.lstatSync(p);
  if (!st.isFile() || st.size > limit) throw new WorkspaceError("Knowledge file is not a bounded regular file");
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) throw new WorkspaceError("Knowledge file changed while opening", 409);
    const b = fs.readFileSync(fd);
    if (b.length > limit) throw new WorkspaceError("Knowledge file exceeds size limit");
    return b;
  } finally {
    fs.closeSync(fd);
  }
}
const byteHash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (root: string, p: string) => exists(p) ? byteHash(bytes(root, p)) : null;
function json(root: string, p: string, limit?: number): Data {
  try {
    const value = JSON.parse(decode(bytes(root, p, limit)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError("Invalid or unrecognized project knowledge JSON", 409);
  }
}
function durable(p: string, b: Buffer | string): void {
  fs.mkdirSync(path.dirname(p), {
    recursive: true
  });
  const fd = fs.openSync(p, "wx", 0o600);
  try {
    fs.writeFileSync(fd, b);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export class ProjectFiles {
  readonly directory: string;
  private observed = new Map<string, string | null>();
  private blocked = false;
  private lockDepth = 0;
  constructor(readonly root: string, readonly language: string) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,19}$/.test(language)) throw new WorkspaceError("Invalid language code");
    this.directory = path.join(root, PROJECT_WIKI_DIR, fileSlug(language));
    noLinks(root, this.directory);
  }
  get present(): boolean {
    return exists(this.directory);
  }
  assertReadable(): void {
    if (this.blocked) throw new WorkspaceError("Knowledge recovery conflict requires resolution", 409);
  }
  readPortableIdentity(): string {
    this.assertReadable();
    const project = json(this.root, this.target("project.json"), 100000);
    if (project.schema_version !== 1 || typeof project.id !== "string" || project.language !== this.language) throw new WorkspaceError("Unrecognized project knowledge format", 409);
    return project.id;
  }
  readExecutionGuard(): ProjectExecutionGuard | null {
    if (!this.present) return null;
    return this.locked(() => {
      this.recover();
      const file = this.target('.execution-guard.json');
      if (!exists(file)) return null;
      const value = json(this.root, file, 10000);
      if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation <= 0
        || ['scopeIdentity', 'taskId', 'ledgerId', 'controllerEpoch', 'ownerId'].some(key => typeof value[key] !== 'string' || !value[key]))
        throw new WorkspaceError('EXECUTION_FENCE_INVALID', 409);
      return value as ProjectExecutionGuard;
    });
  }
  private writeExecutionGuard(guard: ProjectExecutionGuard): void {
    const file = this.target('.execution-guard.json');
    const temporary = this.target(`.execution-guard-${randomUUID()}.tmp`);
    durable(temporary, canonicalJson(guard) + '\n');
    try { fs.renameSync(temporary, file); }
    finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  }
  installExecutionFence(guard: ProjectExecutionGuard): ProjectExecutionGuard {
    this.assertReadable();
    return this.locked(() => {
      const previous = this.readExecutionGuard();
      if (guard.version !== 1 || !Number.isSafeInteger(guard.generation) || guard.generation <= 0) throw new WorkspaceError('EXECUTION_FENCE_INVALID', 409);
      if (previous && canonicalJson(previous) === canonicalJson(guard)) return previous;
      if (previous && guard.generation <= previous.generation) throw new WorkspaceError('EXECUTION_FENCE_STALE', 409);
      this.writeExecutionGuard(guard);
      return guard;
    });
  }
  private assertPublicationFence(claim: ProjectPublicationClaim, requireClaim: boolean): ProjectExecutionGuard {
    const guard = this.readExecutionGuard();
    if (!guard || guard.taskId !== claim.taskId || guard.ledgerId !== claim.fence.ledgerId
      || guard.controllerEpoch !== claim.fence.controllerEpoch || guard.ownerId !== claim.fence.ownerId
      || guard.generation !== claim.fence.generation) throw new WorkspaceError('EXECUTION_FENCE_STALE', 409);
    if (requireClaim && (guard.claimId !== claim.claimId || guard.publicationId !== claim.publicationId
      || guard.intentHash !== claim.intentHash || guard.outputSetHash !== claim.outputSetHash)) throw new WorkspaceError('PUBLICATION_CLAIM_STALE', 409);
    return guard;
  }
  bindPublicationClaim(claim: ProjectPublicationClaim): void {
    this.locked(() => {
      const guard = this.assertPublicationFence(claim, false);
      this.writeExecutionGuard({ ...guard, claimId: claim.claimId, publicationId: claim.publicationId, intentHash: claim.intentHash, outputSetHash: claim.outputSetHash });
    });
  }
  private publicationFacts(facts: ProjectFacts, claim: ProjectPublicationClaim): ProjectFacts {
    if (!/^[a-f0-9]{24}$/.test(claim.namespace) || !facts.snapshots[claim.namespace]) throw new WorkspaceError('PUBLICATION_NAMESPACE_INVALID', 409);
    const candidate = clone(facts);
    delete candidate.project.last_publication;
    candidate.snapshots[claim.namespace].publicationId = claim.publicationId;
    return candidate;
  }
  publicationOutputHash(facts: ProjectFacts, claim: ProjectPublicationClaim): string {
    const output = this.outputs(this.publicationFacts(facts, claim));
    return hash([...output].map(([relative, content]) => [relative, hash(content)]).sort((a, b) => a[0].localeCompare(b[0])));
  }
  commitPublication(facts: ProjectFacts, claim: ProjectPublicationClaim): ProjectPublicationReceipt {
    return this.locked(() => {
      this.assertReadable();
      this.assertPublicationFence(claim, true);
      if (this.publicationOutputHash(facts, claim) !== claim.outputSetHash) throw new WorkspaceError('PUBLICATION_OUTPUT_CHANGED', 409);
      const candidate = this.publicationFacts(facts, claim);
      const receipt: ProjectPublicationReceipt = { version: 1, taskId: claim.taskId, claimId: claim.claimId, publicationId: claim.publicationId,
        ledgerId: claim.fence.ledgerId, generation: claim.fence.generation, intentHash: claim.intentHash, outputSetHash: claim.outputSetHash,
        namespace: claim.namespace, completedAt: new Date().toISOString() };
      candidate.project.last_publication = receipt;
      this.commitLocked(candidate, claim);
      return receipt;
    });
  }
  readPublicationReceipt(): ProjectPublicationReceipt | null {
    if (!this.present) return null;
    return this.locked(() => {
      this.recover();
      const receipt = json(this.root, this.target('project.json'), 100000).last_publication;
      if (!receipt) return null;
      if (receipt.version !== 1 || !Number.isSafeInteger(receipt.generation)
        || ['taskId', 'claimId', 'publicationId', 'ledgerId', 'intentHash', 'outputSetHash', 'namespace'].some(key => typeof receipt[key] !== 'string' || !receipt[key]))
        throw new WorkspaceError('PUBLICATION_RECEIPT_INVALID', 409);
      return receipt as ProjectPublicationReceipt;
    });
  }
  private target(relative: string): string {
    safeRelative(relative);
    const p = path.join(this.directory, ...relative.split("/"));
    noLinks(this.root, p);
    return p;
  }
  private cleanup(p: string): void {
    if (!inside(this.directory, p) || p === this.directory) throw new WorkspaceError("Invalid journal cleanup path");
    noLinks(this.root, p);
    fs.rmSync(p, {
      recursive: true,
      force: true
    });
  }
  private locked<T>(operation: () => T): T {
    if (this.lockDepth) return operation();
    const lock = this.target(".write-lock");
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = json(this.root, lock, 10000);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new WorkspaceError("Knowledge store is locked", 409);
      try {
        process.kill(owner.pid, 0);
        throw new WorkspaceError("Knowledge store is busy", 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, "wx", 0o600);
    }
    const stat = fs.fstatSync(fd);
    this.lockDepth++;
    try {
      fs.writeFileSync(fd, canonicalJson({
        pid: process.pid,
        instance: randomUUID()
      }));
      return operation();
    } finally {
      this.lockDepth--;
      fs.closeSync(fd);
      if (exists(lock)) {
        const current = fs.lstatSync(lock);
        if (current.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(lock);
      }
    }
  }
  private apply(journal: string): void {
    const manifest = json(this.root, path.join(journal, "transaction.json"));
    if (![1, 2].includes(manifest.version) || (manifest.version === 2 && (!manifest.publication?.claimId || !manifest.publication?.fence))
      || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new WorkspaceError("Unrecognized knowledge transaction", 409);
    for (const entry of manifest.files) {
      const target = this.target(entry.path),
        actual = digest(this.root, target);
      if (actual === entry.after) continue;
      if (actual !== entry.before) {
        this.blocked = true;
        throw new WorkspaceError("Knowledge recovery conflict: external files were preserved", 409);
      }
      const staged = path.join(journal, "new", ...String(entry.path).split("/"));
      if (digest(this.root, staged) !== entry.after) throw new WorkspaceError("Incomplete knowledge transaction", 409);
      fs.mkdirSync(path.dirname(target), {
        recursive: true
      });
      noLinks(this.root, target);
      fs.renameSync(staged, target);
    }
    this.cleanup(journal);
  }
  recover(): void {
    if (this.blocked) throw new WorkspaceError("Knowledge recovery conflict requires resolution", 409);
    if (!this.present) return;
    return this.locked(() => this.recoverLocked());
  }
  private recoverLocked(): void {
    const base = this.target(".transactions");
    if (!exists(base)) return;
    for (const entry of fs.readdirSync(base, {
      withFileTypes: true
    })) {
      const p = path.join(base, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new WorkspaceError("Invalid knowledge journal", 409);
      if (exists(path.join(p, "transaction.json"))) this.apply(p);
      // A journal without a prepared manifest has never changed a fact file.
      else this.cleanup(p);
    }
  }
  load(): ProjectFacts {
    return this.locked(() => this.loadLocked());
  }
  private loadLocked(): ProjectFacts {
    this.recover();
    this.observed.clear();
    const initialization = this.target("initialization.json");
    if (!exists(this.target("project.json")) && exists(initialization)) {
      const pending = json(this.root, initialization);
      if (pending.schema_version !== 1 || pending.facts?.project?.language !== this.language) throw new WorkspaceError("Invalid knowledge initialization receipt", 409);
      this.commit(pending.facts);
    }
    const get = (rel: string, limit?: number) => {
      const p = this.target(rel);
      const value = json(this.root, p, limit);
      this.observed.set(rel, digest(this.root, p));
      return value;
    };
    const project = get("project.json", 100000);
    if (project.schema_version !== 1 || typeof project.id !== "string" || project.language !== this.language) throw new WorkspaceError("Unrecognized project knowledge format", 409);
    project.path = this.root;
    project.plan = validate_plan(get("plan.json", 100000));
    const pages: ProjectFacts["pages"] = {},
      snapshots: ProjectFacts["snapshots"] = {};
    let revision = Number.isSafeInteger(project.next_revision) ? project.next_revision : 0;
    const nsRoot = this.target("namespaces");
    if (exists(nsRoot)) for (const ns of fs.readdirSync(nsRoot, {
      withFileTypes: true
    })) {
      if (!ns.isDirectory() || ns.isSymbolicLink() || !/^[a-f0-9]{24}$/.test(ns.name)) throw new WorkspaceError("Invalid knowledge namespace", 409);
      const prefix = `namespaces/${ns.name}`,
        state = get(`${prefix}/namespace.json`);
      if (state.schema_version !== 1 || !state.snapshot || !Array.isArray(state.pages)) throw new WorkspaceError("Invalid knowledge namespace metadata", 409);
      snapshots[ns.name] = state.snapshot;
      const entries: Record<string, Data> = Object.create(null);
      pages[ns.name] = entries;
      const collision = new Set<string>();
      for (const name of state.pages) {
        slug(name);
        const key = fileSlug(name);
        if (collision.has(key)) throw new WorkspaceError("Knowledge page names collide", 409);
        collision.add(key);
        const meta = get(`${prefix}/meta/${key}.json`),
          file = `${prefix}/pages/${key}.md`,
          p = this.target(file);
        const raw = bytes(this.root, p, 2_000_000),
          markdown = decode(raw);
        this.observed.set(file, byteHash(raw));
        if (meta.id !== name || !Number.isSafeInteger(meta.revision) || typeof meta.baseline !== "string" || !["ready", "edited", "conflict", "archived"].includes(meta.status)) throw new WorkspaceError("Invalid knowledge page metadata", 409);
        revision = Math.max(revision, meta.revision);
        entries[name] = {
          ...meta,
          markdown
        };
      }
    }
    // External Markdown does not update JSON revisions. Allocate a newer value
    // before handing text to callers, so existing numeric CAS remains safe.
    for (const entries of Object.values(pages)) for (const page of Object.values(entries)) {
      if (page.content_hash !== hash(page.markdown)) {
        page.revision = ++revision;
        if (!["conflict", "archived"].includes(page.status)) page.status = page.markdown === page.baseline ? "ready" : "edited";
      }
      delete page.content_hash;
      page.storage_token = pageStorageToken(page);
    }
    project.next_revision = revision;
    project.plan_storage_token = hash(project.plan);
    const migration = exists(this.target("migration.json")) ? get("migration.json") : undefined;
    return {
      project,
      pages,
      snapshots,
      ...(migration ? {
        migration
      } : {})
    };
  }
  commit(facts: ProjectFacts): void {
    if (this.blocked) throw new WorkspaceError("Knowledge recovery conflict requires resolution", 409);
    noLinks(this.root, this.directory);
    const fresh = !this.present;
    if (fresh) {
      fs.mkdirSync(path.dirname(this.directory), {
        recursive: true
      });
      noLinks(this.root, this.directory);
      fs.mkdirSync(this.directory); // exclusive; never take over a racing target
    }
    const created = fresh ? fs.lstatSync(this.directory) : undefined;
    try {
      return this.locked(() => {
        if (fresh) durable(this.target("initialization.json"), canonicalJson({
          schema_version: 1,
          facts
        }));
        this.commitLocked(facts);
      });
    } catch (error) {
      // Only undo our own still-empty reservation. Unknown or staged files stay.
      if (created && exists(this.directory)) {
        const current = fs.lstatSync(this.directory);
        if (current.ino === created.ino && current.dev === created.dev && fs.readdirSync(this.directory).length === 0) fs.rmdirSync(this.directory);
      }
      throw error;
    }
  }
  private outputs(facts: ProjectFacts): Map<string, string> {
    const output = new Map<string, string>();
    const project = clone(facts.project);
    if (typeof project.portable_id === "string") project.id = project.portable_id;
    delete project.portable_id;
    delete project.path;
    delete project.plan;
    delete project.plan_storage_token;
    project.schema_version = 1;
    output.set("plan.json", canonicalJson(facts.project.plan) + "\n");
    if (facts.migration) output.set("migration.json", canonicalJson(facts.migration) + "\n");
    for (const [ns, entries] of Object.entries(facts.pages)) {
      if (!/^[a-f0-9]{24}$/.test(ns)) throw new WorkspaceError("Invalid knowledge namespace");
      const prefix = `namespaces/${ns}`;
      output.set(`${prefix}/namespace.json`, canonicalJson({
        schema_version: 1,
        snapshot: facts.snapshots[ns] ?? {
          hashes: {},
          edges: [],
          identity: {}
        },
        pages: Object.keys(entries).sort()
      }) + "\n");
      for (const [id, page] of Object.entries(entries)) {
        const filename = fileSlug(id),
          meta = clone(page);
        delete meta.markdown;
        delete meta.storage_token;
        meta.content_hash = hash(page.markdown);
        output.set(`${prefix}/pages/${filename}.md`, page.markdown);
        output.set(`${prefix}/meta/${filename}.json`, canonicalJson(meta) + "\n");
      }
    }
    // Snapshot-only namespaces still need a manifest.
    for (const [ns, snapshot] of Object.entries(facts.snapshots)) if (!facts.pages[ns]) output.set(`namespaces/${ns}/namespace.json`, canonicalJson({
      schema_version: 1,
      snapshot,
      pages: []
    }) + "\n");
    output.set("project.json", canonicalJson(project) + "\n");
    return output;
  }
  private commitLocked(facts: ProjectFacts, publication?: ProjectPublicationClaim): void {
    const output = this.outputs(facts);
    const changes = [...output].filter(([rel, value]) => digest(this.root, this.target(rel)) !== hash(value));
    if (!changes.length) return;
    // Check the whole read set, including the plan, before publishing anything.
    for (const [rel, before] of this.observed) if (digest(this.root, this.target(rel)) !== before) throw new WorkspaceError("Knowledge file revision conflict; reload before saving", 409);
    for (const [rel] of changes) if (!this.observed.has(rel) && exists(this.target(rel))) throw new WorkspaceError("Knowledge destination conflict; unknown file was preserved", 409);
    const journal = this.target(`.transactions/${randomUUID()}`);
    fs.mkdirSync(journal, {
      recursive: true
    });
    const entries: Data[] = [];
    try {
      for (const [rel, value] of changes) {
        const target = this.target(rel),
          before = digest(this.root, target);
        durable(path.join(journal, "new", ...rel.split("/")), value);
        if (before !== null) durable(path.join(journal, "before", ...rel.split("/")), bytes(this.root, target));
        entries.push({
          path: rel,
          before,
          after: hash(value)
        });
      }
      durable(path.join(journal, "transaction.json"), canonicalJson({
        version: publication ? 2 : 1,
        ...(publication ? { publication } : {}),
        files: entries
      }));
      this.apply(journal);
      const initialization = this.target("initialization.json");
      if (exists(initialization)) fs.unlinkSync(initialization);
      for (const [rel, value] of output) this.observed.set(rel, hash(value));
    } catch (e) {
      if (!exists(path.join(journal, "transaction.json"))) this.cleanup(journal);else this.blocked = true;
      if (e instanceof WorkspaceError) throw e;
      const error = new WorkspaceError("Knowledge files could not be saved; check project permissions and retry", 409);
      error.cause = e;
      throw error;
    }
  }
}
