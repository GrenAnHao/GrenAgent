import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RepoWikiProcessClient } from "../src/client.js";

const digest = (filename: string) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error("Migration condition timed out"); await delay(5); }
}

test("bundled child keeps IPC responsive during legacy snapshot and cancels without publishing; retry preserves source", { timeout: 60000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-worker-migration-"));
  const root = path.join(base, "repo"), data = path.join(base, "state"), temporary = path.join(base, "copy-temp");
  for (const folder of [root, data, temporary]) fs.mkdirSync(folder);
  const legacy = path.join(data, "workspace.sqlite3"), db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE pages(project_id TEXT,namespace TEXT,slug TEXT,data TEXT,PRIMARY KEY(project_id,namespace,slug));CREATE TABLE snapshots(project_id TEXT,namespace TEXT,data TEXT,PRIMARY KEY(project_id,namespace));CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT);CREATE TABLE generation_cache(fingerprint TEXT PRIMARY KEY,data TEXT);");
  const plan = { include: ["**"], exclude: [], pages: [{ id: "overview", title: "Overview", goal: "Legacy fixture", patterns: ["**"], depends_on: [] }] };
  const ns = createHash("sha256").update(JSON.stringify(["local", "zh"])).digest("hex").slice(0, 24);
  const insertProject = db.prepare("INSERT INTO projects VALUES (?,?)"), insertPage = db.prepare("INSERT INTO pages VALUES (?,?,?,?)");
  for (const [id, projectPath] of [["current", root], ["other", path.join(base, "unrelated")]]) insertProject.run(id, JSON.stringify({ id, name: id, path: projectPath, language: "zh", watch: false, plan, identity: { branch: "local", language: "zh" } }));
  db.prepare("INSERT INTO revisions VALUES (?)").run(1);
  const page = (id: string, markdown: string) => ({ id, title: id, kind: "wiki", markdown, baseline: markdown, pending_markdown: null, sources: [], dependencies: [], status: "ready", revision: 1 });
  insertPage.run("current", ns, "overview", JSON.stringify(page("overview", "Human legacy content")));
  const bulk = "Fixture legacy paragraph. ".repeat(22000);
  db.exec("BEGIN");
  for (let index = 0; index < 48; index++) insertPage.run("other", ns, `extra-${index}`, JSON.stringify(page(`extra-${index}`, bulk)));
  db.exec("COMMIT"); db.close();
  assert.ok(fs.statSync(legacy).size > 40 * 1024 * 1024);
  const original = digest(legacy);
  let modelCalls = 0;
  const entry = process.env.REPOWIKI_TEST_ENTRY ?? fileURLToPath(new URL("../../../dist/packages/process/src/child.js", import.meta.url));
  const client = new RepoWikiProcessClient({ entry, executable: process.env.REPOWIKI_TEST_EXECUTABLE, dataDir: data, allowedRoots: [root], env: { TEMP: temporary, TMP: temporary, TMPDIR: temporary }, modelCacheKey: "unused-fixture-model", complete: async () => { modelCalls++; throw new Error("Migration must not call a model"); }, requestTimeoutMs: 15000, stopTimeoutMs: 5000, maxRestarts: 0 });
  t.after(async () => { await client.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  await client.start(); const pid = client.pid;
  let settled = false;
  const hydration = client.invokeScoped("create", { path: root }, { contextId: "first-hydration" }).finally(() => { settled = true; }).catch(error => error);
  await until(() => fs.readdirSync(temporary).some(name => {
    if (!name.startsWith("repowiki-legacy-copy-")) return false;
    try { return fs.readdirSync(path.join(temporary, name)).some(item => item.startsWith(".repowiki-migration-")); } catch { return false; }
  }));
  const started = performance.now(), health = await client.invoke("health", {});
  assert.equal(health.status, "ok");
  assert.ok(performance.now() - started < 1000, "health must remain responsive while copying legacy data");
  assert.equal(settled, false, "health must complete before the legacy hydration");
  await client.cancelContext("first-hydration");
  assert.ok(await hydration instanceof Error);
  await until(() => fs.readdirSync(temporary).length === 0);
  assert.equal(fs.existsSync(path.join(root, "docs/repo-wiki")), false);
  assert.equal(digest(legacy), original); assert.equal(modelCalls, 0);
  const retried = await client.invokeScoped("create", { path: root }, { contextId: "retry-hydration" });
  assert.equal(retried.portable_id, "current");
  assert.equal((await client.invoke("page", { project_id: retried.id, slug: "overview" })).markdown, "Human legacy content");
  assert.equal(digest(legacy), original); assert.equal(modelCalls, 0); assert.equal(client.pid, pid);
  assert.equal(fs.existsSync(path.join(base, "unrelated")), false);
  assert.deepEqual(fs.readdirSync(temporary), []);
  // A graceful service stop must also wait for worker termination and core's
  // staging cleanup before closing SQLite and exiting the child.
  await client.stop();
  fs.rmSync(path.join(root, "docs/repo-wiki"), { recursive: true });
  const stoppingClient = new RepoWikiProcessClient({ ...client.options });
  t.after(() => stoppingClient.stop());
  const stoppingHydration = stoppingClient.invokeScoped("create", { path: root }, { contextId: "shutdown-hydration" }).catch(error => error);
  await until(() => fs.readdirSync(temporary).some(name => {
    if (!name.startsWith("repowiki-legacy-copy-")) return false;
    try { return fs.readdirSync(path.join(temporary, name)).some(item => item.startsWith(".repowiki-migration-")); } catch { return false; }
  }));
  await stoppingClient.stop(); await stoppingHydration;
  assert.deepEqual(fs.readdirSync(temporary), [], "shutdown must await migration worker and staging cleanup");
  assert.equal(digest(legacy), original);
});
