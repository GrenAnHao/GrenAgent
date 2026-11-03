import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import rawFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceEngine, type GenerationProvider, type WorkspaceEngineOptions } from "../src/engine.js";
import { migrateWorkspace } from "../src/migration.js";
import * as scanner from "../src/scanner.js";
function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "repo-wiki-files-"));
  const root = path.join(base, "repo"),
    data = path.join(base, "data");
  fs.mkdirSync(root);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, "main.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "wiki_plan.json"), JSON.stringify({
    include: ["**"],
    exclude: ["wiki_plan.json"],
    pages: [{
      id: "overview",
      title: "Overview",
      patterns: ["**"],
      depends_on: []
    }]
  }));
  const engines: WorkspaceEngine[] = [];
  t.after(() => {
    for (const e of engines) {
      try {
        e.close();
      } catch {}
    }
    fs.rmSync(base, {
      recursive: true,
      force: true
    });
  });
  return {
    root,
    data,
    base,
    engine(options?: WorkspaceEngineOptions) {
      const e = new WorkspaceEngine(data, options);
      engines.push(e);
      return e;
    }
  };
}
const provider: GenerationProvider = {
  name: "fixture",
  cache_key: "fixture-v1",
  generate_page(c) {
    return {
      markdown: "# Source\n\n" + c.files.map((f: any) => f.content).join("\n"),
      sources: c.files.map((f: any) => ({
        path: f.path,
        start_line: 1,
        end_line: 1
      }))
    };
  }
};
test("hydrate is cheap and explicit asynchronous scan alone discovers source changes", async t => {
  const f = fixture(t),
    e = f.engine();
  assert.equal(typeof (e as any).hydrate_project, "function", "current root needs a cheap hydration API");
  const p = await (e as any).hydrate_project(f.root);
  assert.equal(e.changes(p.id).scan_state, "unknown");
  assert.equal(e.get_project(p.id).pages.length, 0);
  const scanned = await (e as any).scan_project(p.id);
  assert.deepEqual(scanned.added, ["main.ts"]);
  fs.writeFileSync(path.join(f.root, "new.ts"), "export const other = 2;\n");
  assert.deepEqual(e.changes(p.id).added, ["main.ts"]);
  assert.deepEqual((await (e as any).scan_project(p.id)).added, ["main.ts", "new.ts"]);
});
test("project Markdown and metadata survive deleting the disposable cache", async t => {
  const f = fixture(t),
    e = f.engine();
  assert.equal(typeof (e as any).hydrate_project, "function");
  const p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  const page = e.get_page(p.id, "overview");
  e.edit_page(p.id, "overview", page.markdown + "\nHuman paragraph\n", page.revision);
  const before = e.get_page(p.id, "overview");
  e.close();
  const files = fs.readdirSync(f.data);
  assert.ok(files.includes("project-index.sqlite3"));
  assert.equal(files.includes("workspace.sqlite3"), false);
  for (const n of files) if (n.startsWith("project-index.sqlite3")) fs.rmSync(path.join(f.data, n));
  const next = f.engine(),
    loaded = await (next as any).hydrate_project(f.root);
  assert.equal(loaded.id, p.id);
  assert.equal(next.get_page(p.id, "overview").markdown, before.markdown);
  assert.equal(next.get_page(p.id, "overview").baseline, before.baseline);
  assert.equal(next.get_page(p.id, "overview").revision, before.revision);
  assert.deepEqual(next.get_project(p.id).plan, p.plan);
});
test("external Markdown edits reject a stale UI revision and stay human-owned during generation", async t => {
  const f = fixture(t),
    e = f.engine();
  assert.equal(typeof (e as any).hydrate_project, "function");
  const p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  const old = e.get_page(p.id, "overview"),
    ns = e.get_project(p.id).namespace;
  const md = path.join(f.root, "docs/repo-wiki/zh/namespaces", ns, "pages/overview.md");
  fs.writeFileSync(md, old.markdown + "\nExternal human text\n");
  assert.throws(() => e.edit_page(p.id, "overview", "stale overwrite", old.revision), /conflict/i);
  assert.match(e.get_page(p.id, "overview").markdown, /External human text/);
  await e.generate(p.id, provider);
  assert.match(e.get_page(p.id, "overview").markdown, /External human text/);
});
test("hydration refuses unknown destination files instead of replacing them", async t => {
  const f = fixture(t),
    e = f.engine();
  assert.equal(typeof (e as any).hydrate_project, "function");
  const target = path.join(f.root, "docs/repo-wiki/zh");
  fs.mkdirSync(target, {
    recursive: true
  });
  fs.writeFileSync(path.join(target, "project.json"), "user-owned content");
  await assert.rejects((e as any).hydrate_project(f.root), /conflict|invalid|unrecognized/i);
  assert.equal(fs.readFileSync(path.join(target, "project.json"), "utf8"), "user-owned content");
});
test("current-root legacy migration is lossless, idempotent, and leaves source bytes untouched", async t => {
  const f = fixture(t);
  let snapshots = 0;
  const e = f.engine({ snapshotLegacy: async (from, to, signal) => {
    snapshots++;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted ?? false, false);
    return migrateWorkspace(from, to);
  } });
  assert.equal(typeof (e as any).hydrate_project, "function");
  const legacy = path.join(f.data, "workspace.sqlite3"),
    db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE pages(project_id TEXT,namespace TEXT,slug TEXT,data TEXT,PRIMARY KEY(project_id,namespace,slug));CREATE TABLE snapshots(project_id TEXT,namespace TEXT,data TEXT,PRIMARY KEY(project_id,namespace));CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE generation_cache(fingerprint TEXT PRIMARY KEY,data TEXT);");
  const plan = {
    include: ["**"],
    exclude: [],
    pages: [{
      id: "overview",
      title: "Overview",
      goal: "legacy",
      patterns: ["**"],
      depends_on: []
    }]
  };
  db.prepare("INSERT INTO projects VALUES (?,?)").run("legacy-a", JSON.stringify({
    id: "legacy-a",
    path: f.root,
    language: "zh",
    name: "Legacy",
    plan,
    watch: true
  }));
  db.prepare("INSERT INTO projects VALUES (?,?)").run("other", JSON.stringify({
    id: "other",
    path: path.join(f.base, "other"),
    language: "zh",
    name: "Other",
    plan
  }));
  const ns = scanner.hash(["local", "zh"]).slice(0, 24);
  const page = {
    id: "overview",
    title: "Overview",
    kind: "wiki",
    markdown: "Human text",
    baseline: "Original base",
    pending_markdown: "Candidate",
    pending_sources: [],
    sources: [],
    status: "conflict",
    revision: 7
  };
  db.prepare("INSERT INTO revisions VALUES (?)").run(7);
  db.prepare("INSERT INTO pages VALUES (?,?,?,?)").run("legacy-a", ns, "overview", JSON.stringify(page));
  db.prepare("INSERT INTO snapshots VALUES (?,?,?)").run("legacy-a", ns, JSON.stringify({
    hashes: {},
    edges: [],
    identity: {
      branch: "local",
      language: "zh"
    }
  }));
  db.close();
  const bytes = fs.readFileSync(legacy),
    p = await (e as any).hydrate_project(f.root);
  assert.equal(p.portable_id, "legacy-a");
  assert.equal(e.get_page(p.id, "overview").pending_markdown, "Candidate");
  assert.equal(e.get_page(p.id, "overview").baseline, "Original base");
  assert.equal(e.get_page(p.id, "overview").markdown, "Human text");
  assert.equal(p.plan.pages[0].goal, "legacy");
  assert.equal(p.watch, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "docs/repo-wiki/zh/migration.json"), "utf8")).legacy_project_id, "legacy-a");
  assert.deepEqual(fs.readFileSync(legacy), bytes);
  assert.equal(fs.existsSync(path.join(f.base, "other")), false);
  assert.equal((await (e as any).hydrate_project(f.root)).id, p.id);
  assert.equal(snapshots, 1);
  assert.deepEqual(fs.readFileSync(legacy), bytes);
});

test("canceled snapshot hydration waits for the injected worker exit before temporary cleanup", async t => {
  const f = fixture(t), controller = new AbortController();
  fs.writeFileSync(path.join(f.data, "workspace.sqlite3"), "the injected worker owns snapshot validation");
  let invoked = false, exited = false, temporary = "", stillPresentBeforeExit = false;
  const e = f.engine({ snapshotLegacy: async (_from, to, signal) => {
    invoked = true;
    temporary = path.dirname(to);
    fs.writeFileSync(path.join(temporary, "worker-owned.txt"), "working");
    return new Promise((_resolve, reject) => {
      const terminate = () => setTimeout(() => {
        stillPresentBeforeExit = fs.existsSync(temporary);
        exited = true;
        reject(new Error("snapshot worker canceled"));
      }, 10);
      if (signal?.aborted) terminate();
      else signal?.addEventListener("abort", terminate, { once: true });
    });
  } });
  const pending = e.hydrate_project(f.root, "zh", undefined, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /snapshot worker canceled/);
  assert.equal(invoked, true);
  assert.equal(exited, true);
  assert.equal(stillPresentBeforeExit, true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(path.join(f.root, "docs/repo-wiki")), false);
  assert.equal(fs.readFileSync(path.join(f.data, "workspace.sqlite3"), "utf8"), "the injected worker owns snapshot validation");
});
test("async scanner excludes generated documents and yields to cancellation", async t => {
  const f = fixture(t);
  assert.equal(typeof (scanner as any).scanRepositoryAsync, "function");
  const output = path.join(f.root, "docs/repo-wiki/zh");
  fs.mkdirSync(output, {
    recursive: true
  });
  fs.writeFileSync(path.join(output, "private.md"), "generated text");
  const result = await (scanner as any).scanRepositoryAsync(f.root, {});
  assert.equal(result.files.some((x: any) => x.path.startsWith("docs/repo-wiki/")), false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects((scanner as any).scanRepositoryAsync(f.root, {}, controller.signal), /abort|cancel/i);
});
test("Windows device names and case-distinct page IDs remain lossless without unsafe filenames", async t => {
  const f = fixture(t),
    e = f.engine();
  fs.writeFileSync(path.join(f.root, "wiki_plan.json"), JSON.stringify({
    include: ["**"],
    exclude: ["wiki_plan.json"],
    pages: ["NUL", "readme", "README"].map(id => ({
      id,
      title: id,
      patterns: ["**"],
      depends_on: []
    }))
  }));
  const p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  assert.deepEqual(e.get_project(p.id).pages.map((x: any) => x.id), ["NUL", "readme", "README"]);
  for (const id of ["NUL", "readme", "README"]) assert.match(e.get_page(p.id, id).markdown, /# Source/);
});
test("external plan changes invalidate saved plan tokens and async scan can cancel while traversing", async t => {
  const f = fixture(t),
    e = f.engine(),
    p = await (e as any).hydrate_project(f.root);
  const planPath = path.join(f.root, "docs/repo-wiki/zh/plan.json"),
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.pages[0].goal = "external goal";
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => e.update_plan(p.id, p.plan, p.plan_storage_token), /conflict/i);
  const controller = new AbortController();
  const pending = (e as any).scan_project(p.id, {
    signal: controller.signal
  });
  setImmediate(() => controller.abort(new Error("canceled traversal")));
  await assert.rejects(pending, /cancel/i);
});
test("prepared journal resumes without regenerating and preserves before images", async t => {
  const f = fixture(t),
    e = f.engine(),
    p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  const page = e.get_page(p.id, "overview"),
    ns = e.get_project(p.id).namespace;
  const dir = path.join(f.root, "docs/repo-wiki/zh"),
    rel = `namespaces/${ns}/pages/overview.md`,
    journal = path.join(dir, ".transactions/recovery-fixture");
  fs.mkdirSync(path.join(journal, "new", path.dirname(rel)), {
    recursive: true
  });
  fs.mkdirSync(path.join(journal, "before", path.dirname(rel)), {
    recursive: true
  });
  fs.writeFileSync(path.join(journal, "new", rel), page.markdown + "\nRecovered human paragraph\n");
  fs.writeFileSync(path.join(journal, "before", rel), page.markdown);
  fs.writeFileSync(path.join(journal, "transaction.json"), JSON.stringify({
    version: 1,
    files: [{
      path: rel,
      before: scanner.hash(page.markdown),
      after: scanner.hash(page.markdown + "\nRecovered human paragraph\n")
    }]
  }));
  e.close();
  const next = f.engine();
  await (next as any).hydrate_project(f.root);
  assert.match(next.get_page(p.id, "overview").markdown, /Recovered human paragraph/);
  assert.equal(fs.existsSync(journal), false);
});
test("unknown external content during prepared recovery blocks cached reads without overwriting it", async t => {
  const f = fixture(t),
    e = f.engine(),
    p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  const page = e.get_page(p.id, "overview"),
    ns = e.get_project(p.id).namespace;
  const dir = path.join(f.root, "docs/repo-wiki/zh"),
    rel = `namespaces/${ns}/pages/overview.md`,
    journal = path.join(dir, ".transactions/conflict-fixture");
  fs.mkdirSync(path.join(journal, "new", path.dirname(rel)), {
    recursive: true
  });
  fs.mkdirSync(path.join(journal, "before", path.dirname(rel)), {
    recursive: true
  });
  fs.writeFileSync(path.join(journal, "new", rel), "proposed replacement");
  fs.writeFileSync(path.join(journal, "before", rel), page.markdown);
  fs.writeFileSync(path.join(journal, "transaction.json"), JSON.stringify({
    version: 1,
    files: [{
      path: rel,
      before: scanner.hash(page.markdown),
      after: scanner.hash("proposed replacement")
    }]
  }));
  fs.writeFileSync(path.join(dir, rel), "External latest text");
  assert.throws(() => e.get_page(p.id, "overview"), /recovery conflict/i);
  assert.throws(() => e.get_project(p.id), /recovery conflict/i);
  assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), "External latest text");
  assert.equal(fs.readFileSync(path.join(journal, "before", rel), "utf8"), page.markdown);
});
test("failed initial file write is reported and a later hydration resumes safely", async t => {
  const f = fixture(t),
    e = f.engine();
  const original = rawFs.fsyncSync;
  let calls = 0;
  try {
    rawFs.fsyncSync = _fd => {
      if (++calls === 2) throw Object.assign(new Error("fixture disk write failed"), {
        code: "EIO"
      });
      original(_fd);
    };
    syncBuiltinESMExports();
    await assert.rejects((e as any).hydrate_project(f.root), /could not be saved/i);
  } finally {
    rawFs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  e.close();
  const next = f.engine(),
    p = await (next as any).hydrate_project(f.root);
  assert.equal(p.plan.pages[0].id, "overview");
  assert.deepEqual(p.pages, []);
});
test("a reopened source link reads one scoped current file without starting a repository scan", async t => {
  const f = fixture(t),
    e = f.engine(),
    p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  e.close();
  const next = f.engine();
  await (next as any).hydrate_project(f.root);
  fs.writeFileSync(path.join(f.root, "main.ts"), "export const value = 2;\n");
  assert.equal(next.read_source(p.id, "main.ts", 1, 1).content, "export const value = 2;");
  assert.equal(next.changes(p.id).scan_state, "unknown");
});
test("prototype-like logical page IDs remain ordinary recoverable records", async t => {
  const f = fixture(t),
    e = f.engine();
  fs.writeFileSync(path.join(f.root, "wiki_plan.json"), JSON.stringify({
    include: ["**"],
    exclude: ["wiki_plan.json"],
    pages: [{
      id: "__proto__",
      title: "Prototype",
      patterns: ["**"],
      depends_on: []
    }]
  }));
  const p = await (e as any).hydrate_project(f.root);
  await e.generate(p.id, provider);
  assert.equal(e.get_page(p.id, "__proto__").id, "__proto__");
});

test("failed lock ownership write releases its reservation for a later retry", async t => {
  const f = fixture(t), e = f.engine(), original = rawFs.writeFileSync;
  let first = true;
  try {
    rawFs.writeFileSync = ((...args: any[]) => {
      if (first) { first = false; throw Object.assign(new Error("fixture lock write failed"), { code: "EIO" }); }
      return (original as any)(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(e.hydrate_project(f.root), /fixture lock write failed/);
  } finally { rawFs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal((await e.hydrate_project(f.root)).language, "zh");
});

test("cloned portable facts keep independent stable runtime identities across cache rebuild and A-B-A", async t => {
  const f = fixture(t), e = f.engine(), a = await e.hydrate_project(f.root);
  await e.generate(a.id, provider);
  const cloneRoot = path.join(f.base, "clone");
  fs.cpSync(f.root, cloneRoot, { recursive: true });
  const portableA = JSON.parse(fs.readFileSync(path.join(f.root, "docs/repo-wiki/zh/project.json"), "utf8")).id;
  const b = await e.hydrate_project(cloneRoot);
  assert.notEqual(a.id, b.id, "runtime identity must include the canonical workspace");
  assert.equal(a.portable_id, portableA);
  assert.equal(b.portable_id, portableA);
  const pageA = e.get_page(a.id, "overview"), pageB = e.get_page(b.id, "overview");
  e.edit_page(a.id, "overview", pageA.markdown + "\nA post-clone edit\n", pageA.revision, pageA.storage_token);
  e.edit_page(b.id, "overview", pageB.markdown + "\nB clone edit\n", pageB.revision, pageB.storage_token);
  const planB = structuredClone(b.plan); planB.pages[0].goal = "B clone plan";
  e.update_plan(b.id, planB, b.plan_storage_token);
  assert.match(e.get_page(a.id, "overview").markdown, /A post-clone edit/);
  assert.doesNotMatch(e.get_page(a.id, "overview").markdown, /B clone edit/);
  assert.match(e.get_page(b.id, "overview").markdown, /B clone edit/);
  assert.notEqual(e.get_project(a.id).plan.pages[0].goal, "B clone plan");
  assert.equal(e.get_project(b.id).plan.pages[0].goal, "B clone plan");
  assert.equal(e.list_projects().length, 2);
  e.close();
  for (const name of fs.readdirSync(f.data)) if (name.startsWith("project-index.sqlite3")) fs.rmSync(path.join(f.data, name));
  const next = f.engine(), reopenedB = await next.hydrate_project(cloneRoot), reopenedA = await next.hydrate_project(f.root);
  assert.equal(reopenedA.id, a.id); assert.equal(reopenedB.id, b.id);
  assert.match(next.get_page(a.id, "overview").markdown, /A post-clone edit/);
  assert.match(next.get_page(b.id, "overview").markdown, /B clone edit/);
  assert.equal((await next.hydrate_project(f.root)).id, a.id);
  assert.equal((await next.hydrate_project(cloneRoot)).id, b.id);
  for (const root of [f.root, cloneRoot]) assert.equal(JSON.parse(fs.readFileSync(path.join(root, "docs/repo-wiki/zh/project.json"), "utf8")).id, portableA);
});

test("output exclusion follows the platform's path-case semantics", async t => {
  const f = fixture(t);
  const output = path.join(f.root, "Docs/Repo-Wiki/zh"); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "human.md"), "generated knowledge");
  const result = await scanner.scanRepositoryAsync(f.root, {});
  assert.equal(result.files.some(file => file.path.toLowerCase().startsWith("docs/repo-wiki/")), process.platform !== "win32");
  assert.equal(scanner.isKnowledgeOutput("Docs\\Repo-Wiki\\zh\\human.md"), process.platform === "win32");
  assert.equal(scanner.isKnowledgeOutput("docs/repo-wiki/zh/human.md"), true);
});

test("explicit Markdown export refreshes externally edited facts without scanning", async t => {
  const f = fixture(t), e = f.engine(), p = await e.hydrate_project(f.root);
  await e.generate(p.id, provider);
  const page = e.get_page(p.id, "overview"), ns = e.get_project(p.id).namespace, scannedAt = e.changes(p.id).scanned_at;
  fs.writeFileSync(path.join(f.root, "docs/repo-wiki/zh/namespaces", ns, "pages/overview.md"), page.markdown + "\nExternal export text\n");
  assert.match(e.export_markdown(p.id)["overview.md"], /External export text/);
  assert.equal(e.changes(p.id).scanned_at, scannedAt);
});

test("published facts survive a cache COMMIT failure and recover on re-read and cache rebuild", async t => {
  const f = fixture(t); let failCommit = false;
  const e = f.engine({ databaseFactory: filename => {
    const db = new DatabaseSync(filename);
    return { exec(sql) { if (failCommit && sql === "COMMIT") { failCommit = false; throw new Error("fixture cache COMMIT failed"); } db.exec(sql); }, prepare: db.prepare.bind(db), close: db.close.bind(db) };
  } });
  const p = await e.hydrate_project(f.root); await e.generate(p.id, provider);
  const page = e.get_page(p.id, "overview"); failCommit = true;
  assert.throws(() => e.edit_page(p.id, "overview", page.markdown + "\nPersisted despite cache failure\n", page.revision, page.storage_token), /files were saved.*cache/i);
  assert.match(e.get_page(p.id, "overview").markdown, /Persisted despite cache failure/);
  e.close();
  for (const name of fs.readdirSync(f.data)) if (name.startsWith("project-index.sqlite3")) fs.rmSync(path.join(f.data, name));
  const next = f.engine(), restored = await next.hydrate_project(f.root);
  assert.equal(restored.id, p.id);
  assert.match(next.get_page(p.id, "overview").markdown, /Persisted despite cache failure/);
});

test("corrupt generated cache JSON is a miss while project facts stay authoritative", async t => {
  const f = fixture(t), e = f.engine(), p = await e.hydrate_project(f.root); let calls = 0;
  const counted = { ...provider, generate_page(context: any) { calls++; return provider.generate_page(context); } };
  await e.generate(p.id, counted);
  const ns = e.get_project(p.id).namespace, metaPath = path.join(f.root, "docs/repo-wiki/zh/namespaces", ns, "meta/overview.json");
  const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8")); metadata.fingerprint = "externally-invalidated"; fs.writeFileSync(metaPath, JSON.stringify(metadata));
  const cache = new DatabaseSync(path.join(f.data, "project-index.sqlite3")); cache.exec("UPDATE generation_cache SET data='invalid cache JSON'"); cache.close();
  await e.generate(p.id, counted);
  assert.equal(calls, 2);
  assert.match(e.get_page(p.id, "overview").markdown, /export const value = 1/);
});

test("editing the current project does not reload another previously hydrated root", async t => {
  const f = fixture(t), e = f.engine(), a = await e.hydrate_project(f.root);
  await e.generate(a.id, provider);
  const cloneRoot = path.join(f.base, "unavailable-clone"), movedRoot = path.join(f.base, "moved-clone");
  fs.cpSync(f.root, cloneRoot, { recursive: true }); await e.hydrate_project(cloneRoot);
  const page = e.get_page(a.id, "overview"); fs.renameSync(cloneRoot, movedRoot);
  try {
    e.edit_page(a.id, "overview", page.markdown + "\nCurrent root only\n", page.revision, page.storage_token);
    assert.match(e.get_page(a.id, "overview").markdown, /Current root only/);
  } finally { fs.renameSync(movedRoot, cloneRoot); }
});

test("corrupt disposable database fails explicitly without touching facts and manual rebuild recovers", async t => {
  const f = fixture(t), e = f.engine(), p = await e.hydrate_project(f.root);
  await e.generate(p.id, provider); const page = e.get_page(p.id, "overview"), ns = e.get_project(p.id).namespace;
  const factPath = path.join(f.root, "docs/repo-wiki/zh/namespaces", ns, "pages/overview.md"), before = fs.readFileSync(factPath);
  e.close(); fs.writeFileSync(path.join(f.data, "project-index.sqlite3"), "corrupt fixture database");
  assert.throws(() => f.engine(), /cache.*unavailable.*project files.*unchanged/i);
  assert.deepEqual(fs.readFileSync(factPath), before);
  for (const name of fs.readdirSync(f.data)) if (name.startsWith("project-index.sqlite3")) fs.rmSync(path.join(f.data, name));
  const next = f.engine(); await next.hydrate_project(f.root);
  assert.equal(next.get_page(p.id, "overview").markdown, page.markdown);
});

test("old runtime requests cannot overwrite facts after the portable identity changes", async t => {
  const f = fixture(t), e = f.engine(), old = await e.hydrate_project(f.root);
  await e.generate(old.id, provider); const page = e.get_page(old.id, "overview");
  const identityPath = path.join(f.root, "docs/repo-wiki/zh/project.json"), facts = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  facts.id = "checked-out-portable-project"; fs.writeFileSync(identityPath, JSON.stringify(facts));
  assert.throws(() => e.edit_page(old.id, "overview", "stale old project body", page.revision, page.storage_token), /identity.*changed/i);
  assert.equal(JSON.parse(fs.readFileSync(identityPath, "utf8")).id, "checked-out-portable-project");
  const current = await e.hydrate_project(f.root);
  assert.notEqual(current.id, old.id); assert.equal(current.portable_id, "checked-out-portable-project");
  assert.equal(e.get_page(current.id, "overview").markdown, page.markdown);
  assert.throws(() => e.get_project(old.id), /not found/i);
  assert.equal(e.list_projects().length, 1);
});
