import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateWorkspace } from "../src/migration.js";
import { WorkspaceEngine } from "../src/engine.js";

const schema = `CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE snapshots(project_id TEXT,namespace TEXT,data TEXT NOT NULL,PRIMARY KEY(project_id,namespace));
CREATE TABLE pages(project_id TEXT,namespace TEXT,slug TEXT,data TEXT NOT NULL,PRIMARY KEY(project_id,namespace,slug));
CREATE TABLE generation_cache(fingerprint TEXT PRIMARY KEY,data TEXT NOT NULL);`;
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function hashes(directory: string) {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => [name, sha(fs.readFileSync(path.join(directory, name)))]),
  );
}
function fixture(t: TestContext, wal = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-migration-")),
    source = path.join(base, "old-data"),
    destination = path.join(base, "new-data"),
    repo = path.join(base, "repo");
  fs.mkdirSync(source);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "main.ts"), "export const answer = 42;\n");
  const database = new DatabaseSync(path.join(source, "workspace.sqlite3"));
  if (wal)
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  database.exec(schema);
  const namespace = sha('["local","zh"]').slice(0, 24),
    project = {
      id: "legacy-project",
      name: "人工资料",
      path: repo,
      language: "zh",
      watch: true,
      plan: {
        include: ["**"],
        exclude: [],
        pages: [
          {
            id: "edited",
            title: "编辑页",
            goal: "",
            patterns: ["**"],
            depends_on: [],
          },
          {
            id: "conflict",
            title: "冲突页",
            goal: "",
            patterns: ["**"],
            depends_on: [],
          },
        ],
      },
    };
  database
    .prepare("INSERT INTO projects VALUES (?,?)")
    .run(project.id, JSON.stringify(project));
  const pages = [
    {
      id: "edited",
      title: "编辑页",
      markdown: "Human edited text\n",
      baseline: "Generated baseline\n",
      pending_markdown: null,
      status: "edited",
      revision: 1,
      sources: [],
      dependencies: ["main.ts"],
    },
    {
      id: "conflict",
      title: "冲突页",
      markdown: "Keep human conflict\n",
      baseline: "Prior baseline\n",
      pending_markdown: "New proposal\n",
      pending_sources: [],
      status: "conflict",
      revision: 2,
      sources: [],
      dependencies: ["main.ts"],
    },
    {
      id: "archived",
      title: "归档页",
      markdown: "Archived human note\n",
      baseline: "Old archive baseline\n",
      pending_markdown: null,
      status: "archived",
      revision: 3,
      sources: [],
      dependencies: [],
    },
  ];
  for (const page of pages) {
    database.prepare("INSERT INTO revisions VALUES (?)").run(page.revision);
    database
      .prepare("INSERT INTO pages VALUES (?,?,?,?)")
      .run(project.id, namespace, page.id, JSON.stringify(page));
  }
  database
    .prepare("INSERT INTO snapshots VALUES (?,?,?)")
    .run(
      project.id,
      namespace,
      JSON.stringify({
        hashes: {},
        edges: [],
        identity: { branch: "local", language: "zh" },
      }),
    );
  database
    .prepare("INSERT INTO generation_cache VALUES (?,?)")
    .run(
      "old-fingerprint",
      JSON.stringify({ markdown: "stale model cache", sources: [] }),
    );
  let closed = false;
  const close = () => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };
  if (!wal) close();
  t.after(() => {
    close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    source,
    destination,
    repo,
    database,
    project,
    pages,
    namespace,
    close,
  };
}

test("explicit migration preserves human text, proposals, archives and revision namespace", async (t) => {
  const { base, source, destination, project, pages, namespace } = fixture(t);
  const before = hashes(source),
    result = migrateWorkspace(source, destination);
  assert.equal(result.projects, 1);
  assert.equal(result.pages, 3);
  assert.equal(result.snapshots, 1);
  assert.equal(result.generation_cache_cleared, 1);
  assert.equal(result.watches_paused, 1);
  assert.deepEqual(hashes(source), before);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter((name) => name.startsWith(".repowiki-migration-")),
    [],
  );
  const copied = new WorkspaceEngine(destination);
  const copiedProject = await copied.hydrate_project(project.path,project.language);
  try {
    for (const page of pages)
      assert.deepEqual((({storage_token,...body})=>body)(copied.get_page(copiedProject.id, page.id)), page);
    assert.equal(copied.get_project(copiedProject.id).namespace, namespace);
    assert.equal(copied.get_project(copiedProject.id).watch, false);
    const edited = copied.edit_page(
      copiedProject.id,
      "edited",
      "Further human text\n",
      1,
    );
    assert.ok(edited.revision > 3);
  } finally {
    copied.close();
  }
  const original = new DatabaseSync(path.join(source, "workspace.sqlite3"), {
    readOnly: true,
  });
  try {
    assert.equal(
      JSON.parse(
        String(original.prepare("SELECT data FROM projects").get()!.data),
      ).watch,
      true,
    );
    assert.equal(
      original.prepare("SELECT COUNT(*) AS n FROM generation_cache").get()!.n,
      1,
    );
  } finally {
    original.close();
  }
  const target = new DatabaseSync(path.join(destination, "workspace.sqlite3"), {
    readOnly: true,
  });
  try {
    assert.equal(
      target.prepare("SELECT COUNT(*) AS n FROM generation_cache").get()!.n,
      0,
    );
  } finally {
    target.close();
  }
});
test("committed WAL transactions are recovered only in copy; original DB WAL and SHM bytes unchanged", async (t) => {
  const { source, destination, project, pages } = fixture(t, true);
  assert.ok(fs.statSync(path.join(source, "workspace.sqlite3-wal")).size > 0);
  const before = hashes(source);
  migrateWorkspace(source, destination);
  assert.deepEqual(hashes(source), before);
  const target = new WorkspaceEngine(destination);
  const targetProject = await target.hydrate_project(project.path,project.language);
  try {
    assert.equal(target.get_project(targetProject.id).pages.length, 3);
    assert.equal(
      target.get_page(targetProject.id, "conflict").pending_markdown,
      pages[1].pending_markdown,
    );
  } finally {
    target.close();
  }
  assert.deepEqual(hashes(source), before); // No SQLite connection touched the original during migration.
});
test("uncommitted WAL transaction in an offline snapshot is not mistaken for committed human data", async (t) => {
  const {
    base,
    source: liveSource,
    destination,
    database,
    project,
    pages,
  } = fixture(t, true);
  const source = path.join(base, "offline-snapshot"),
    wal = path.join(liveSource, "workspace.sqlite3-wal"),
    committedBytes = fs.statSync(wal).size;
  database.exec("PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE projects SET data=? WHERE id=?").run(
      JSON.stringify({
        ...project,
        name: "Uncommitted project name",
        padding: "x".repeat(256 * 1024),
      }),
      project.id,
    );
    assert.ok(
      fs.statSync(wal).size > committedBytes,
      "the uncommitted transaction must spill frames into the WAL",
    );
    // Capture the crash-like DB/WAL state before rollback. Migration is offline;
    // SHM is transient coordination state and Windows locks it during writes.
    fs.mkdirSync(source);
    for (const name of ["workspace.sqlite3", "workspace.sqlite3-wal"])
      fs.copyFileSync(path.join(liveSource, name), path.join(source, name));
  } finally {
    database.exec("ROLLBACK");
  }
  const before = hashes(source);
  migrateWorkspace(source, destination);
  assert.deepEqual(hashes(source), before);
  const copied = new WorkspaceEngine(destination);
  const copiedProject = await copied.hydrate_project(project.path,project.language);
  try {
    assert.equal(copied.get_project(copiedProject.id).name, project.name);
    for (const page of pages)
      assert.deepEqual((({storage_token,...body})=>body)(copied.get_page(copiedProject.id, page.id)), page);
  } finally {
    copied.close();
  }
  assert.deepEqual(hashes(source), before);
});
test("same path, existing destination, nested destination and invalid parent refuse without writes", (t) => {
  const { source, destination, base } = fixture(t);
  const before = hashes(source);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "keep.txt"), "untouched");
  for (const target of [
    source,
    destination,
    path.join(source, "nested"),
    path.join(base, "missing-parent", "data"),
  ])
    assert.throws(() => migrateWorkspace(source, target), /Destination/);
  assert.equal(
    fs.readFileSync(path.join(destination, "keep.txt"), "utf8"),
    "untouched",
  );
  assert.deepEqual(hashes(source), before);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter((name) => name.startsWith(".repowiki-migration-")),
    [],
  );
});
test("source directory symlink and database symlink are rejected", (t) => {
  const { source, destination, base } = fixture(t);
  const alias = path.join(base, "alias");
  fs.symlinkSync(source, alias, "dir");
  assert.throws(() => migrateWorkspace(alias, destination), /symbolic links/);
  const db = path.join(source, "workspace.sqlite3"),
    real = path.join(source, "real.sqlite3");
  fs.renameSync(db, real);
  fs.symlinkSync(real, db);
  assert.throws(() => migrateWorkspace(source, destination), /symbolic links/);
  assert.equal(fs.existsSync(destination), false);
});
test("destination parent symlink and dangling destination symlink are rejected without overwrite", (t) => {
  const { source, destination, base } = fixture(t);
  const alias = path.join(base, "alias");
  fs.symlinkSync(base, alias, "dir");
  assert.throws(
    () => migrateWorkspace(source, path.join(alias, "target")),
    /symbolic links/,
  );
  fs.symlinkSync(path.join(base, "not-present"), destination);
  assert.throws(() => migrateWorkspace(source, destination), /symbolic links/);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});
test("unknown schema fails with no installed target or leaked staging", (t) => {
  const { source, destination, base } = fixture(t);
  const db = new DatabaseSync(path.join(source, "workspace.sqlite3"));
  db.exec("CREATE TABLE unrelated(private TEXT)");
  db.close();
  const before = hashes(source);
  assert.throws(() => migrateWorkspace(source, destination), /Unrecognized/);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(hashes(source), before);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter((name) => name.startsWith(".repowiki-migration-")),
    [],
  );
});
test("bad page JSON and revision corruption fail atomically", (t) => {
  const { source, destination, base } = fixture(t);
  const db = new DatabaseSync(path.join(source, "workspace.sqlite3"));
  db.prepare("UPDATE pages SET data=? WHERE slug=?").run("not json", "edited");
  db.close();
  const before = hashes(source);
  assert.throws(
    () => migrateWorkspace(source, destination),
    /invalid page JSON/,
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(hashes(source), before);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter((name) => name.startsWith(".repowiki-migration-")),
    [],
  );
});
test("page revision exceeding stored sequence is refused", (t) => {
  const { source, destination, pages } = fixture(t);
  const db = new DatabaseSync(path.join(source, "workspace.sqlite3"));
  db.prepare("UPDATE pages SET data=? WHERE slug=?").run(
    JSON.stringify({ ...pages[0], revision: 999 }),
    "edited",
  );
  db.close();
  const before = hashes(source);
  assert.throws(() => migrateWorkspace(source, destination), /page\/revision/);
  assert.deepEqual(hashes(source), before);
  assert.equal(fs.existsSync(destination), false);
});
test("Node-only migration CLI returns a verification receipt", (t) => {
  const { source, destination } = fixture(t);
  const before = hashes(source);
  const script = fileURLToPath(
    new URL("../../../scripts/migrate.ts", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", script, "--from", source, "--to", destination],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const receipt = JSON.parse(output);
  assert.equal(receipt.pages, 3);
  assert.equal(receipt.source_mode, "read-only-files-quiescent-snapshot");
  assert.deepEqual(hashes(source), before);
});
test("source rollback journal is refused rather than repaired in place", (t) => {
  const { source, destination } = fixture(t);
  fs.writeFileSync(
    path.join(source, "workspace.sqlite3-journal"),
    "pending journal",
  );
  const before = hashes(source);
  assert.throws(
    () => migrateWorkspace(source, destination),
    /rollback journal/,
  );
  assert.deepEqual(hashes(source), before);
  assert.equal(fs.existsSync(destination), false);
});
test("truncated database fails cleanly without creating destination", (t) => {
  const { source, destination, base } = fixture(t);
  fs.writeFileSync(
    path.join(source, "workspace.sqlite3"),
    "SQLite format 3\0broken",
  );
  const before = hashes(source);
  assert.throws(
    () => migrateWorkspace(source, destination),
    /Migration failed/,
  );
  assert.deepEqual(hashes(source), before);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(
    fs
      .readdirSync(base)
      .filter((name) => name.startsWith(".repowiki-migration-")),
    [],
  );
});
