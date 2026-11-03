import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { WorkspaceEngine, type GenerationProvider } from "../src/engine.js";
import { hash } from "../src/scanner.js";

type Data = Record<string, any>;
class EvidenceProvider implements GenerationProvider {
  name = "test-offline";
  cache_key = "cards-test-v1";
  calls: Data[] = [];
  generate_page(context: Data): Data {
    this.calls.push(context);
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
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-cards-")),
    repo = path.join(root, "repo"),
    data = path.join(root, "data");
  fs.mkdirSync(repo);
  const write = (name: string, content: string) => {
    const target = path.join(repo, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("README.md", "# Actual fixture\nA small storage module.\n");
  write("storage.ts", "export const VALUE = 1;\n");
  write(
    "main.ts",
    'import {VALUE} from "./storage.js";\nexport const answer = VALUE;\n',
  );
  write(
    "wiki_plan.json",
    JSON.stringify({
      include: ["**"],
      exclude: ["wiki_plan.json"],
      pages: [
        {
          id: "overview",
          title: "Overview",
          goal: "Explain source",
          patterns: ["**"],
          depends_on: [],
        },
      ],
    }),
  );
  const engine = new WorkspaceEngine(data),
    id = engine.create_project(repo).id as string,
    provider = new EvidenceProvider();
  t.after(() => {
    engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    repo,
    data,
    engine,
    id,
    provider,
    write,
    wiki: () => engine.generate(id, provider),
    cards: (force = false) =>
      engine.generate(id, provider, force, undefined, "cards"),
  };
}
test("knowledge cards are separately generated persisted records from bounded actual evidence", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.engine.get_project(f.id).cards, []);
  await f.wiki();
  const wiki = f.engine.get_project(f.id).pages;
  assert.equal(f.engine.list_projects()[0].card_count, 0);
  const result = await f.cards();
  const project = f.engine.get_project(f.id);
  assert.equal(result.target, "cards");
  assert.ok(result.generated > 0 && result.generated <= 12);
  assert.equal(project.cards.length, result.generated);
  assert.deepEqual(project.pages, wiki);
  assert.equal(project.page_count, 1);
  assert.equal(project.card_count, project.cards.length);
  assert.equal(project.knowledge.wiki.count, 1);
  assert.equal(project.knowledge.cards.count, project.cards.length);
  assert.equal(project.namespace, hash(["local", "zh"]).slice(0, 24));
  assert.notEqual(project.knowledge.cards.namespace, project.namespace);
  for (const card of project.cards) {
    assert.equal(card.kind, "card");
    assert.match(card.id, /^cards\//);
    assert.ok(card.category);
    assert.ok(card.summary);
    assert.ok(card.sources.length);
    assert.ok(card.sources.every((ref: Data) => ref.hash));
    assert.equal(f.engine.get_page(f.id, card.id).markdown, card.markdown);
  }
  assert.ok(
    f.provider.calls
      .filter((context) => context.kind === "card")
      .every(
        (context) =>
          context.card_category &&
          context.files.length &&
          context.direct_sources.length,
      ),
  );
});
test("targeted cache hits and forced card regeneration never modify wiki revisions", async (t) => {
  const f = fixture(t);
  await f.wiki();
  await f.cards();
  const wiki = f.engine.get_page(f.id, "overview");
  f.provider.calls = [];
  const noOp = await f.cards();
  assert.equal(noOp.generated, 0);
  assert.equal(noOp.unchanged, f.engine.get_project(f.id).card_count);
  assert.equal(f.provider.calls.length, 0);
  await f.cards(true);
  assert.ok(f.provider.calls.every((context) => context.kind === "card"));
  assert.deepEqual(f.engine.get_page(f.id, "overview"), wiki);
});
test("wiki and cards have independent freshness snapshots and last successful generation metadata", async (t) => {
  const f = fixture(t);
  await f.wiki();
  await f.cards();
  const cardState = f.engine.get_project(f.id).knowledge.cards;
  f.write("storage.ts", "export const VALUE = 2;\n");
  assert.ok((await f.engine.scan_project(f.id)).changed_count);
  assert.ok((await f.engine.scan_project(f.id, {target:"cards"})).changed_count);
  await f.wiki();
  assert.equal((await f.engine.scan_project(f.id)).changed_count, 0);
  assert.deepEqual(f.engine.get_project(f.id).knowledge.cards, cardState);
  assert.deepEqual((await f.engine.scan_project(f.id, {target:"cards"})).changed, ["storage.ts"]);
  await f.cards();
  f.write("storage.ts", "export const VALUE = 3;\n");
  await f.cards();
  assert.equal((await f.engine.scan_project(f.id, {target:"cards"})).changed_count, 0);
  assert.deepEqual((await f.engine.scan_project(f.id)).changed, ["storage.ts"]);
  assert.equal(
    f.engine.get_project(f.id).knowledge.cards.last_run.target,
    "cards",
  );
  assert.equal(
    f.engine.get_project(f.id).knowledge.wiki.last_run.target,
    "wiki",
  );
});
test("card human edits merge, overlap remains a conflict, and explicit resolution updates card summary", async (t) => {
  const f = fixture(t);
  await f.wiki();
  await f.cards();
  const old = f.engine.get_page(f.id, "cards/persistence");
  f.engine.edit_page(
    f.id,
    old.id,
    old.markdown + "Human note.\n",
    old.revision,
  );
  f.write("storage.ts", "export const VALUE = 2;\n");
  await f.cards();
  const merged = f.engine.get_page(f.id, old.id);
  assert.match(merged.markdown, /Human note/);
  assert.equal(merged.status, "edited");
  const ours = merged.markdown.replace("VALUE = 2", "VALUE = human");
  f.engine.edit_page(f.id, old.id, ours, merged.revision);
  f.write("storage.ts", "export const VALUE = 3;\n");
  await f.cards();
  const conflict = f.engine.get_page(f.id, old.id);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.markdown, ours);
  assert.match(conflict.pending_markdown, /VALUE = 3/);
  const resolved = f.engine.resolve_page(
    f.id,
    old.id,
    "# Resolved\n\nHuman confirmed storage contract.\n",
    conflict.revision,
  );
  assert.equal(resolved.kind, "card");
  assert.equal(resolved.summary, "Human confirmed storage contract.");
  assert.equal(resolved.pending_markdown, null);
  assert.equal(f.engine.get_project(f.id).pages.length, 1);
});
test("disappearing card topics archive human content while wiki generation cannot archive cards", async (t) => {
  const f = fixture(t);
  await f.cards();
  const page = f.engine.get_page(f.id, "cards/persistence");
  f.engine.edit_page(
    f.id,
    page.id,
    page.markdown + "Do not lose this note\n",
    page.revision,
  );
  await f.wiki();
  assert.equal(f.engine.get_page(f.id, page.id).status, "edited");
  fs.renameSync(path.join(f.repo, "storage.ts"), path.join(f.repo, "value.ts"));
  await f.cards();
  assert.equal(f.engine.get_page(f.id, page.id).status, "archived");
  assert.match(f.engine.get_page(f.id, page.id).markdown, /Do not lose/);
  assert.equal(f.engine.get_project(f.id).page_count, 1);
  assert.equal(
    Object.hasOwn(f.engine.export_markdown(f.id, "cards"), page.id + ".md"),
    false,
  );
});
test("Markdown export/import has explicit target manifest, safe paths, and no cross-kind mutation", async (t) => {
  const f = fixture(t);
  await f.wiki();
  await f.cards();
  const wiki = f.engine.get_page(f.id, "overview");
  const files = f.engine.export_markdown(f.id, "cards");
  assert.equal(JSON.parse(files[".repowiki-manifest.json"]).target, "cards");
  assert.ok(
    Object.keys(files).every(
      (name) => name === ".repowiki-manifest.json" || name.startsWith("cards/"),
    ),
  );
  files["cards/persistence.md"] += "Offline card note\n";
  assert.throws(
    () => f.engine.import_markdown(f.id, files),
    /different project/,
  );
  assert.ok(f.engine.import_markdown(f.id, files, "cards").imported > 0);
  assert.match(
    f.engine.get_page(f.id, "cards/persistence").markdown,
    /Offline card note/,
  );
  assert.deepEqual(f.engine.get_page(f.id, "overview"), wiki);
  const normal = f.engine.export_markdown(f.id);
  assert.equal(
    Object.keys(normal).some((name) => name.startsWith("cards/")),
    false,
  );
  assert.throws(() =>
    f.engine.import_markdown(f.id, { "../escape.md": "bad" }, "cards"),
  );
});
test("cards and legacy wiki remain independently readable after database reopen", async (t) => {
  const f = fixture(t);
  await f.wiki();
  const wiki = f.engine.get_page(f.id, "overview");
  await f.cards();
  const card = f.engine.get_page(f.id, "cards/persistence");
  const reopened = new WorkspaceEngine(f.data);
  try {
    assert.deepEqual(reopened.get_page(f.id, "overview"), wiki);
    assert.deepEqual(reopened.get_page(f.id, card.id), card);
    assert.ok(reopened.get_project(f.id).knowledge.cards.updated_at);
    assert.equal((await reopened.scan_project(f.id, {target:"cards"})).changed_count, 0);
  } finally {
    reopened.close();
  }
});
test("card generation rollback and cancellation preserve both content kinds and snapshots", async (t) => {
  const f = fixture(t);
  await f.wiki();
  await f.cards();
  const before = f.engine.get_project(f.id);
  f.write("storage.ts", "export const VALUE = changed;\n");
  await assert.rejects(
    f.engine.generate(
      f.id,
      f.provider,
      false,
      (event) => {
        if (event.stage === "committing") throw new Error("card canceled");
      },
      "cards",
    ),
    /card canceled/,
  );
  const after = f.engine.get_project(f.id);
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.cards, before.cards);
  assert.deepEqual(after.knowledge, before.knowledge);
  assert.ok((await f.engine.scan_project(f.id, {target:"cards"})).changed_count);
  const bad: GenerationProvider = {
    name: "bad",
    cache_key: "bad",
    generate_page: () => ({
      markdown: "# Invented",
      sources: [{ path: "missing.ts", start_line: 1, end_line: 1 }],
    }),
  };
  await assert.rejects(
    f.engine.generate(f.id, bad, true, undefined, "cards"),
    /missing file/,
  );
  assert.deepEqual(f.engine.get_project(f.id).cards, before.cards);
});
test("namespace collision with a legacy wiki slug is rejected rather than hiding old text", async (t) => {
  const f = fixture(t);
  f.engine.update_plan(f.id, {
    include: ["**"],
    exclude: [],
    pages: [
      {
        id: "cards/project-boundaries",
        title: "Legacy wiki",
        goal: "",
        patterns: ["**"],
        depends_on: [],
      },
    ],
  });
  await f.wiki();
  const old = f.engine.get_page(f.id, "cards/project-boundaries");
  await assert.rejects(f.cards(), /collide/);
  assert.deepEqual(f.engine.get_page(f.id, old.id), old);
  assert.deepEqual(f.engine.get_project(f.id).cards, []);
});
test("branch and language card collections do not inherit other namespace counts or edits", async (t) => {
  const f = fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.repo, ...args], { stdio: "ignore" });
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await f.cards();
  const before = f.engine.get_project(f.id).cards;
  git("checkout", "-b", "feature");
  await f.engine.scan_project(f.id);
  assert.equal(f.engine.get_project(f.id).card_count, 0);
  assert.deepEqual(f.engine.get_project(f.id).cards, []);
  await f.cards();
  git("checkout", "main");
  await f.engine.scan_project(f.id);
  assert.deepEqual(f.engine.get_project(f.id).cards, before);
  const english = f.engine.create_project(f.repo, "en");
  assert.equal(english.card_count, 0);
});
test("card planning is bounded to twelve evidence-backed topics, and unknown targets fail closed", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 25; i++)
    f.write(`module-${i}/index.ts`, `export const VALUE_${i} = ${i};\n`);
  const result = await f.cards();
  assert.ok(result.generated <= 12);
  assert.ok(f.provider.calls.every((context) => context.files.length > 0));
  assert.throws(
    () => f.engine.changes(f.id, "all" as any),
    /Invalid generation target/,
  );
  await assert.rejects(
    f.engine.generate(f.id, f.provider, false, undefined, "all" as any),
    /Invalid generation target/,
  );
});
