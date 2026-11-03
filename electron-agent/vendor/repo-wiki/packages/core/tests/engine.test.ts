import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  WorkspaceEngine,
  three_way_merge,
  validate_plan,
  type GenerationProvider,
  type WikiPlan,
} from "../src/engine.js";

type Data = Record<string, any>;
function plan(): WikiPlan {
  return {
    include: ["**"],
    exclude: ["wiki_plan.json"],
    pages: [
      {
        id: "a",
        title: "A",
        goal: "Describe A",
        patterns: ["a.py"],
        depends_on: [],
      },
      {
        id: "b",
        title: "B",
        goal: "Describe B",
        patterns: ["b.py"],
        depends_on: [],
      },
      {
        id: "other",
        title: "Other",
        goal: "Other",
        patterns: ["other.py"],
        depends_on: [],
      },
      {
        id: "guide",
        title: "Guide",
        goal: "Guide",
        patterns: ["other.py"],
        depends_on: ["a"],
      },
    ],
  };
}
class Provider implements GenerationProvider {
  name = "test-offline";
  cache_key = "test-v1";
  calls: Data[] = [];
  hook?: (context: Data) => Promise<void> | void;
  async generate_page(context: Data): Promise<Data> {
    this.calls.push(context);
    await this.hook?.(context);
    return {
      markdown:
        `# ${context.title}\n\n` +
        context.files
          .map((file: Data) => `${file.path}: ${file.content.trim()}`)
          .join("\n") +
        "\n\nEnd.\n",
      sources: context.files.map((file: Data) => ({
        path: file.path,
        start_line: 1,
        end_line: Math.max(1, file.content.trimEnd().split("\n").length),
      })),
    };
  }
}
function workspace(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "repowiki-engine-")),
    root = path.join(directory, "repo"),
    data = path.join(directory, "data");
  mkdirSync(root);
  writeFileSync(
    path.join(root, "a.py"),
    "import b\n\ndef answer():\n    return b.VALUE\n",
  );
  writeFileSync(path.join(root, "b.py"), "VALUE = 1\n");
  writeFileSync(path.join(root, "other.py"), "OTHER = True\n");
  writeFileSync(path.join(root, "wiki_plan.json"), JSON.stringify(plan()));
  const engine = new WorkspaceEngine(data),
    project = engine.create_project(root);
  t.after(() => {
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    engine,
    id: project.id as string,
    root,
    data,
    directory,
    provider: new Provider(),
  };
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function initGit(root: string) {
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
}

test("plan source evidence, dependencies and no-op generation persist", async (t) => {
  const { engine, id, provider } = workspace(t);
  assert.deepEqual(engine.get_project(id).plan, validate_plan(plan()));
  assert.equal((await engine.generate(id, provider)).generated, 4);
  const page = engine.get_page(id, "a");
  assert.deepEqual(page.dependencies, ["a.py", "b.py"]);
  assert.deepEqual(
    page.sources.map((source: Data) => source.path),
    ["a.py", "b.py"],
  );
  assert.ok(page.sources.every((source: Data) => source.hash));
  assert.equal((await engine.generate(id, provider)).unchanged, 4);
  assert.equal(provider.calls.length, 4);
  assert.equal((await engine.scan_project(id)).changed_count, 0);
  assert.equal(engine.get_project(id).stats.files, 3);
});
test("reverse import and page dependency invalidation does not consume changes", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  await engine.generate(id, provider);
  writeFileSync(path.join(root, "b.py"), "VALUE = 2\n");
  assert.deepEqual((await engine.scan_project(id)).changed, ["b.py"]);
  assert.deepEqual((await engine.scan_project(id)).affected_pages, ["a", "b", "guide"]);
  assert.deepEqual((await engine.scan_project(id)).changed, ["b.py"]);
  provider.calls = [];
  const result = await engine.generate(id, provider);
  assert.equal(result.generated, 3);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(provider.calls.map((context) => context.page_id).sort(), [
    "a",
    "b",
    "guide",
  ]);
});
test("delete and rename propagate through old edges", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  await engine.generate(id, provider);
  renameSync(path.join(root, "b.py"), path.join(root, "renamed.py"));
  const changes = (await engine.scan_project(id));
  assert.deepEqual(changes.deleted, ["b.py"]);
  assert.deepEqual(changes.renamed, [{ from: "b.py", to: "renamed.py" }]);
  assert.deepEqual(changes.affected_pages, ["a", "b", "guide"]);
  assert.equal((await engine.generate(id, provider)).generated, 3);
  assert.deepEqual(engine.get_page(id, "a").dependencies, ["a.py"]);
  assert.deepEqual(engine.get_page(id, "b").sources, []);
});
test("persistent input cache survives reopen; force bypasses model cache", async (t) => {
  const { engine, id, root, provider, data } = workspace(t);
  await engine.generate(id, provider);
  writeFileSync(path.join(root, "b.py"), "VALUE = 2\n");
  await engine.generate(id, provider);
  writeFileSync(path.join(root, "b.py"), "VALUE = 1\n");
  const reopened = new WorkspaceEngine(data);
  try {
    const result = await reopened.generate(id, provider);
    assert.equal(result.cached, 3);
    assert.equal(result.generated, 0);
    assert.equal((await reopened.generate(id, provider, true)).generated, 4);
  } finally {
    reopened.close();
  }
});

test("resumable force generation persists completed page outputs before atomic publication", async (t) => {
  const { engine, id, provider, data } = workspace(t);
  provider.hook = (context) => { if (context.page_id === "b") throw new Error("worker interrupted"); };
  await assert.rejects(engine.generate(id, provider, true, undefined, "wiki", { resumeRunId: "task-resume" }), /worker interrupted/);
  assert.equal(engine.get_project(id).page_count, 0);
  const reopened = new WorkspaceEngine(data);
  try {
    provider.calls = [];
    provider.hook = undefined;
    const result = await reopened.generate(id, provider, true, undefined, "wiki", { resumeRunId: "task-resume" });
    assert.deepEqual(provider.calls.map((context) => context.page_id), ["b", "other", "guide"]);
    assert.equal(result.resumed, 1);
    assert.equal(reopened.get_project(id).page_count, 4);
  } finally {
    reopened.close();
  }
});

test("resumable outputs are invalidated by source or model changes", async (t) => {
  const { engine, id, provider, root } = workspace(t);
  provider.hook = (context) => { if (context.page_id === "b") throw new Error("worker interrupted"); };
  await assert.rejects(engine.generate(id, provider, true, undefined, "wiki", { resumeRunId: "task-changed" }), /worker interrupted/);
  writeFileSync(path.join(root, "b.py"), "VALUE = 2\n");
  provider.calls = [];
  provider.hook = undefined;
  const changed = await engine.generate(id, provider, true, undefined, "wiki", { resumeRunId: "task-changed" });
  assert.deepEqual(provider.calls.map((context) => context.page_id), ["a", "b", "other", "guide"]);
  assert.equal(changed.resumed, 0);
  provider.calls = [];
  provider.cache_key = "test-v2";
  const modelChanged = await engine.generate(id, provider, true, undefined, "wiki", { resumeRunId: "task-changed" });
  assert.equal(modelChanged.resumed, 0);
  assert.equal(provider.calls.length, 4);
});
test("manual edits merge, overlap stays human-owned and explicit resolution advances baseline", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  await engine.generate(id, provider);
  const old = engine.get_page(id, "a");
  const edited = engine.edit_page(
    id,
    "a",
    old.markdown + "\nHuman note.\n",
    old.revision,
  );
  writeFileSync(path.join(root, "b.py"), "VALUE = 2\n");
  assert.equal((await engine.generate(id, provider)).merged, 1);
  const merged = engine.get_page(id, "a");
  assert.match(merged.markdown, /Human note/);
  assert.match(merged.markdown, /VALUE = 2/);
  assert.equal(merged.status, "edited");
  const ours = merged.markdown.replace("VALUE = 2", "VALUE = custom");
  engine.edit_page(id, "a", ours, merged.revision);
  writeFileSync(path.join(root, "b.py"), "VALUE = 3\n");
  await engine.generate(id, provider);
  const conflict = engine.get_page(id, "a");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.markdown, ours);
  assert.match(conflict.pending_markdown, /VALUE = 3/);
  await engine.generate(id, provider);
  assert.equal(engine.get_page(id, "a").status, "conflict");
  const resolved = engine.resolve_page(
    id,
    "a",
    conflict.pending_markdown + "Human note.\n",
    conflict.revision,
  );
  assert.equal(resolved.status, "edited");
  assert.equal(resolved.pending_markdown, null);
  assert.match(resolved.baseline, /VALUE = 3/);
  assert.throws(
    () => engine.edit_page(id, "a", "stale", edited.revision),
    /Revision conflict/,
  );
});
test("three-way merge is conservative for adjacent insertion boundaries and overlap", () => {
  assert.deepEqual(three_way_merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n"), [
    "A\nb\nC\n",
    false,
  ]);
  assert.deepEqual(three_way_merge("a\n", "same\n", "same\n"), [
    "same\n",
    false,
  ]);
  assert.deepEqual(three_way_merge("a\n", "ours\n", "theirs\n"), [
    "ours\n",
    true,
  ]);
  assert.equal(three_way_merge("a\n", "a\nours\n", "a\ntheirs\n")[1], true);
  assert.equal(three_way_merge("a\nb\n", "A\nb\n", "new\na\nb\n")[1], true);
});
test("pathologically large merge falls back to a safe human-owned conflict", () => {
  const base = "same\n".repeat(50001),
    ours = base + "human\n",
    theirs = "generated\n" + base;
  assert.deepEqual(three_way_merge(base, ours, theirs), [ours, true]);
});
test("removed pages are archived with manual text recoverable", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  const old = engine.get_page(id, "other");
  engine.edit_page(id, "other", old.markdown + "Human", old.revision);
  const next = plan();
  next.pages = next.pages.filter((page) => page.id !== "other");
  engine.update_plan(id, next);
  assert.equal((await engine.generate(id, provider)).archived, 1);
  assert.equal(engine.get_page(id, "other").status, "archived");
  assert.match(engine.get_page(id, "other").markdown, /Human$/);
  assert.equal(Object.hasOwn(engine.export_markdown(id), "other.md"), false);
});
test("branch isolation and monotonic revisions reject cross-branch stale edits", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  initGit(root);
  await engine.generate(id, provider);
  const main = engine.get_page(id, "a");
  engine.edit_page(id, "a", main.markdown + "Main-only note", main.revision);
  git(root, "checkout", "-b", "feature");
  await engine.scan_project(id);
  assert.deepEqual(engine.get_project(id).pages, []);
  await engine.generate(id, provider);
  assert.doesNotMatch(engine.get_page(id, "a").markdown, /Main-only/);
  assert.throws(
    () => engine.edit_page(id, "a", "wrong branch", main.revision),
    /Revision conflict/,
  );
  git(root, "checkout", "main");
  await engine.scan_project(id);
  assert.match(engine.get_page(id, "a").markdown, /Main-only/);
  assert.equal((await engine.scan_project(id)).identity.branch, "main");
});
test("language namespaces are independent while duplicate same-language import is idempotent", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  const other = engine.create_project(root, "en");
  assert.notEqual(other.id, id);
  await engine.generate(id, provider);
  await engine.generate(other.id, provider);
  assert.notEqual(
    engine.get_page(id, "a").fingerprint,
    engine.get_page(other.id, "a").fingerprint,
  );
  assert.equal(engine.create_project(root).id, id);
});
test("invalid source evidence rolls back all pages and snapshot", async (t) => {
  const { engine, id, provider } = workspace(t);
  const original = provider.generate_page.bind(provider);
  provider.generate_page = async (context) => {
    const output = await original(context);
    if (context.page_id === "b") output.sources[0].end_line = 500;
    return output;
  };
  await assert.rejects(engine.generate(id, provider), /out-of-range/);
  assert.deepEqual(engine.get_project(id).pages, []);
  assert.deepEqual((await engine.scan_project(id)).added, ["a.py", "b.py", "other.py"]);
});
test("repository mutation during provider call cannot commit mixed snapshots", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  provider.hook = () => {
    writeFileSync(path.join(root, "b.py"), "VALUE = changed\n");
  };
  await assert.rejects(engine.generate(id, provider), /Repository changed/);
  assert.deepEqual(engine.get_project(id).pages, []);
});
test("concurrent human edit during async generation is preserved", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  await engine.generate(id, provider);
  provider.hook = (context) => {
    if (context.page_id === "a") {
      const page = engine.get_page(id, "a");
      engine.edit_page(
        id,
        "a",
        page.markdown + "Human concurrent note\n",
        page.revision,
      );
    }
  };
  writeFileSync(path.join(root, "b.py"), "VALUE = 2\n");
  await engine.generate(id, provider);
  assert.match(engine.get_page(id, "a").markdown, /Human concurrent note/);
});
test("second generate is rejected while first is awaiting provider; close is guarded", async (t) => {
  const { engine, id, provider } = workspace(t);
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let started!: () => void;
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  provider.hook = async () => {
    started();
    await barrier;
  };
  const first = engine.generate(id, provider);
  await called;
  await assert.rejects(engine.generate(id, new Provider()), /already running/);
  assert.throws(() => engine.close(), /finish or be canceled/);
  unblock();
  assert.equal((await first).generated, 4);
});
test("plan mutation during provider await rejects atomic commit", async (t) => {
  const { engine, id, provider } = workspace(t);
  provider.hook = () => {
    const changed = plan();
    changed.pages[0].goal = "changed while pending";
    engine.update_plan(id, changed);
  };
  await assert.rejects(engine.generate(id, provider), /wiki_plan changed/);
  assert.deepEqual(engine.get_project(id).pages, []);
});
test("export/import roundtrip and unsafe import rejection are atomic", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  const exported = engine.export_markdown(id);
  exported["a.md"] += "Offline note\n";
  assert.equal(engine.import_markdown(id, exported).imported, 4);
  const before = engine.get_page(id, "a");
  for (const unsafe of [
    "../a.md",
    "/tmp/a.md",
    "modules/../../a.md",
    "C:\\a.md",
    "a/./b.md",
    "missing.md",
  ]) {
    assert.throws(() =>
      engine.import_markdown(id, { "a.md": "changed", [unsafe]: "no" }),
    );
    assert.deepEqual(engine.get_page(id, "a"), before);
  }
  assert.throws(
    () => engine.import_markdown(id, { "a.md": "Blind overwrite" }),
    /overwrite manual/,
  );
});
test("manifest merges disjoint offline edits and rejects overlap without partial writes", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  let exported = engine.export_markdown(id);
  const page = engine.get_page(id, "a");
  engine.edit_page(
    id,
    "a",
    page.markdown.replace("# A", "# Human A"),
    page.revision,
  );
  exported["a.md"] += "Offline suffix\n";
  engine.import_markdown(id, exported);
  assert.match(engine.get_page(id, "a").markdown, /# Human A/);
  exported = engine.export_markdown(id);
  const current = engine.get_page(id, "a");
  engine.edit_page(
    id,
    "a",
    current.markdown.replace("Human A", "Online A"),
    current.revision,
  );
  exported["a.md"] = exported["a.md"].replace("Human A", "Offline A");
  const before = engine.get_page(id, "b");
  exported["b.md"] += "Must not import\n";
  assert.throws(() => engine.import_markdown(id, exported), /Import conflict/);
  assert.deepEqual(engine.get_page(id, "b"), before);
});
test("manifest from another branch/project, corrupt content hash, and nonstrings are rejected", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  const exported = engine.export_markdown(id);
  const manifest = JSON.parse(exported[".repowiki-manifest.json"]);
  manifest.namespace = "wrong";
  exported[".repowiki-manifest.json"] = JSON.stringify(manifest);
  assert.throws(
    () => engine.import_markdown(id, exported),
    /different project/,
  );
  const correct = engine.export_markdown(id);
  const corrupt = JSON.parse(correct[".repowiki-manifest.json"]);
  corrupt.pages["a.md"].baseline = "changed";
  correct[".repowiki-manifest.json"] = JSON.stringify(corrupt);
  assert.throws(() => engine.import_markdown(id, correct), /corrupt/);
  assert.throws(
    () => engine.import_markdown(id, { "a.md": 4 as any }),
    /Markdown must/,
  );
});
test("source reads enforce plan scope, line bounds, traversal and symlink exclusion", async (t) => {
  const { engine, id, root } = workspace(t);
  await engine.scan_project(id);
  assert.equal(engine.read_source(id, "a.py", 1, 1).content, "import b");
  writeFileSync(path.join(root, ".env"), "SECRET=private");
  writeFileSync(path.join(root, "secret.pem"), "private key");
  for (const unsafe of ["../outside", "/etc/passwd", "a/../b.py"])
    assert.throws(() => engine.read_source(id, unsafe));
  for (const excluded of [".env", "secret.pem", "wiki_plan.json"])
    assert.throws(() => engine.read_source(id, excluded), /missing|excluded/);
  assert.throws(() => engine.read_source(id, "a.py", 1, 500), /range/);
  symlinkSync(path.join(root, "b.py"), path.join(root, "link.py"));
  assert.throws(() => engine.read_source(id, "link.py"), /missing|excluded/);
});
test("plan rejects unsafe scope, duplicate IDs, cycles and unknown dependencies", (t) => {
  const { engine, id } = workspace(t);
  const mutations = [
    (p: WikiPlan) => {
      p.include = ["../**"];
    },
    (p: WikiPlan) => {
      p.pages[0].id = "../escape";
    },
    (p: WikiPlan) => {
      p.pages[0].depends_on = ["missing"];
    },
    (p: WikiPlan) => {
      p.pages[0].depends_on = ["guide"];
    },
    (p: WikiPlan) => {
      p.pages[1].id = "a";
    },
  ];
  for (const mutate of mutations) {
    const invalid = plan();
    mutate(invalid);
    assert.throws(() => engine.update_plan(id, invalid));
  }
  assert.deepEqual(engine.get_project(id).plan, validate_plan(plan()));
});
test("page goals selectively invalidate dependent pages; navigation updates all links", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  const next = plan();
  next.pages[0].goal = "New goal";
  engine.update_plan(id, next);
  assert.ok((await engine.scan_project(id)).affected_pages.includes("a"));
  assert.equal((await engine.generate(id, provider)).generated, 2);
  next.pages[2].title = "Renamed other";
  engine.update_plan(id, next);
  assert.equal((await engine.generate(id, provider)).generated, 4);
});
test("manual dependent-page text invalidates the context fingerprint even with unchanged sources", async (t) => {
  const { engine, id, provider } = workspace(t);
  await engine.generate(id, provider);
  const page = engine.get_page(id, "a");
  engine.edit_page(
    id,
    "a",
    page.markdown + "Human contextual note\n",
    page.revision,
  );
  assert.deepEqual((await engine.scan_project(id)).affected_pages, ["guide"]);
  provider.calls = [];
  const result = await engine.generate(id, provider);
  assert.equal(result.generated, 1);
  assert.equal(result.unchanged, 3);
  assert.equal(provider.calls[0].page_id, "guide");
  assert.match(
    provider.calls[0].related_pages[0].markdown,
    /Human contextual note/,
  );
  assert.deepEqual((await engine.scan_project(id)).affected_pages, []);
});
test("bounded context marks partial coverage; citations cannot reach omitted tail", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  writeFileSync(path.join(root, "b.py"), "VALUE = 1\n".repeat(10000));
  await engine.generate(id, provider);
  for (const context of provider.calls) {
    assert.ok(
      context.files.reduce(
        (sum: number, file: Data) => sum + file.content.length,
        0,
      ) <= 120000,
    );
    assert.ok(context.files.length <= 60);
  }
  assert.equal(engine.get_page(id, "b").coverage.partial, true);
  assert.ok(engine.get_page(id, "b").coverage.truncated_files.includes("b.py"));
  const original = provider.generate_page.bind(provider);
  provider.generate_page = async (context) => {
    const output = await original(context);
    if (context.page_id === "b") output.sources[0].end_line = 9000;
    return output;
  };
  await assert.rejects(engine.generate(id, provider, true), /out-of-range/);
});
test("watch flag persists across reopened SQLite connections", (t) => {
  const { engine, id, data } = workspace(t);
  engine.set_watch(id, true);
  const reopened = new WorkspaceEngine(data);
  try {
    assert.equal(reopened.get_project(id).watch, true);
  } finally {
    reopened.close();
  }
});
test("clone under data directory remains scannable while nested storage never feeds back", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "repowiki-boundary-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, "data"),
    repo = path.join(data, "repos", "fixture");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "main.py"), "print('actual source')\n");
  const engine = new WorkspaceEngine(data);
  try {
    const project = engine.create_project(repo);
    await engine.generate(project.id, new Provider());
    assert.equal(engine.get_project(project.id).stats.files, 1);
  } finally {
    engine.close();
  }
  const outer = path.join(base, "outer");
  mkdirSync(outer);
  writeFileSync(path.join(outer, "main.py"), "print('source')\n");
  const nested = new WorkspaceEngine(path.join(outer, "my-state"));
  try {
    writeFileSync(
      path.join(nested.data_dir, "private.json"),
      '{"do_not_scan":true}',
    );
    const project = nested.create_project(outer);
    await nested.generate(project.id, new Provider());
    assert.equal(nested.get_project(project.id).stats.files, 1);
    assert.equal((await nested.scan_project(project.id)).changed_count, 0);
  } finally {
    nested.close();
  }
});
test("commit identity changes are persisted without needless source regeneration", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  initGit(root);
  await engine.generate(id, provider);
  assert.equal((await engine.scan_project(id)).identity_changed, false);
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "empty",
  );
  assert.equal((await engine.scan_project(id)).identity_changed, true);
  assert.equal((await engine.generate(id, provider)).unchanged, 4);
  assert.equal((await engine.scan_project(id)).identity_changed, false);
});
for (const citation of [
  "source:missing.py#L1-L2",
  "source:b.py#L1-L500",
  "source:b.py",
  "source:b.py#invalid",
  "source:%E0%A4%A#L1",
])
  test(`Markdown citations reject ${citation} independently of metadata`, async (t) => {
    const { engine, id, provider } = workspace(t);
    const original = provider.generate_page.bind(provider);
    provider.generate_page = async (context) => {
      const output = await original(context);
      output.markdown += `\n[untrusted citation](${citation})`;
      return output;
    };
    await assert.rejects(engine.generate(id, provider), /source citation/);
    assert.deepEqual(engine.get_project(id).pages, []);
  });
for (const markdown of [
  "<source:b.py#L500>",
  "[ref]: source:b.py#L500\n[claimed][ref]",
  "[claimed]( source:b.py#L500 )",
  "[claimed](<source:b.py#L500>)",
])
  test(`non-default Markdown citation form validates source range: ${markdown}`, async (t) => {
    const { engine, id, provider } = workspace(t);
    const original = provider.generate_page.bind(provider);
    provider.generate_page = async (context) => {
      const output = await original(context);
      output.markdown += "\n" + markdown;
      return output;
    };
    await assert.rejects(engine.generate(id, provider), /source citation/);
    assert.deepEqual(engine.get_project(id).pages, []);
  });
test("cancellation at committing preserves all pages, snapshots, and pending work", async (t) => {
  const { engine, id, root, provider } = workspace(t);
  await engine.generate(id, provider);
  const before = engine.get_project(id);
  writeFileSync(path.join(root, "b.py"), "VALUE = after-cancel\n");
  await assert.rejects(
    engine.generate(id, provider, false, (event) => {
      if (event.stage === "committing")
        throw new Error("Canceled before commit");
    }),
    /Canceled/,
  );
  const after = engine.get_project(id);
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.last_run, before.last_run);
  assert.deepEqual((await engine.scan_project(id)).changed, ["b.py"]);
});
test("legacy SQLite schema and namespace preserve edited/conflict data without migration writes", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "repowiki-legacy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "a.py"), "VALUE = 1\n");
  initGit(repo);
  const data = path.join(base, "copied-python-data");
  mkdirSync(data);
  const database = new DatabaseSync(path.join(data, "workspace.sqlite3"));
  database.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE revisions (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE snapshots (project_id TEXT, namespace TEXT, data TEXT NOT NULL, PRIMARY KEY(project_id,namespace)); CREATE TABLE pages (project_id TEXT, namespace TEXT, slug TEXT, data TEXT NOT NULL, PRIMARY KEY(project_id,namespace,slug)); CREATE TABLE generation_cache (fingerprint TEXT PRIMARY KEY,data TEXT NOT NULL);",
  );
  const ns = createHash("sha256")
    .update('["main","zh"]')
    .digest("hex")
    .slice(0, 24);
  const old = {
    id: "old-project",
    name: "原始项目",
    path: repo,
    language: "zh",
    plan: plan(),
    watch: false,
  };
  database
    .prepare("INSERT INTO projects VALUES (?,?)")
    .run(old.id, JSON.stringify(old));
  database.prepare("INSERT INTO revisions(id) VALUES (42)").run();
  const page = {
    id: "a",
    title: "人工文档",
    markdown: "保留人工修订\n",
    baseline: "旧生成内容\n",
    pending_markdown: "待处理提议\n",
    pending_sources: [],
    status: "conflict",
    revision: 42,
    sources: [],
    dependencies: ["a.py"],
  };
  database
    .prepare("INSERT INTO pages VALUES (?,?,?,?)")
    .run(old.id, ns, "a", JSON.stringify(page));
  database.close();
  const engine = new WorkspaceEngine(data);
  try {
    const restored = await engine.hydrate_project(repo);
    const {storage_token,...loaded}=engine.get_page(restored.id,"a");
    assert.equal(typeof storage_token,"string");
    assert.deepEqual(loaded,page);
    assert.equal(engine.get_project(restored.id).namespace, ns);
    const resolved = engine.resolve_page(restored.id, "a", "人工确认内容\n", 42);
    assert.ok(resolved.revision > 42);
    assert.equal(resolved.baseline, "待处理提议\n");
  } finally {
    engine.close();
  }
});
test("host can inject compatible SQLite factory without exposing storage to renderer", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "repowiki-factory-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  let called = "";
  const engine = new WorkspaceEngine(base, {
    databaseFactory: (filename) => {
      called = filename;
      return new DatabaseSync(filename);
    },
  });
  try {
    assert.equal(called, path.join(base, "project-index.sqlite3"));
    assert.deepEqual(engine.list_projects(), []);
  } finally {
    engine.close();
  }
});
