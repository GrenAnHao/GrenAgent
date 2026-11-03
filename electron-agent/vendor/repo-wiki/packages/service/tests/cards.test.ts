import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import {
  WorkspaceService,
  type WorkspaceServiceOptions,
} from "../src/service.js";
import { DemoProvider } from "../../core/src/providers.js";
import { routeRequest, validateRequest } from "../../contracts/src/index.js";
import { RepoWikiProcessClient } from "../../process/src/client.js";
import { fileURLToPath } from "node:url";

type Data = Record<string, any>;
function fixture(
  t: TestContext,
  options: Partial<WorkspaceServiceOptions> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-card-service-")),
    repo = path.join(root, "repo"),
    data = path.join(root, "data");
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(repo, "README.md"),
    "# Fixture\nA storage service.\n",
  );
  fs.writeFileSync(path.join(repo, "storage.ts"), "export const VALUE = 1;\n");
  fs.writeFileSync(
    path.join(repo, "wiki_plan.json"),
    JSON.stringify({
      include: ["**"],
      exclude: ["wiki_plan.json"],
      pages: [
        {
          id: "overview",
          title: "Overview",
          goal: "Describe evidence",
          patterns: ["**"],
          depends_on: [],
        },
      ],
    }),
  );
  const service = new WorkspaceService({
    dataDir: data,
    watchInterval: 0,
    watchDebounce: 0,
    ...options,
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, data, service };
}
async function done(
  service: WorkspaceService,
  id: string,
  target?: "wiki" | "cards",
): Promise<Data> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await service.dispatch("run", {
      project_id: id,
      ...(target ? { target } : {}),
    });
    if (!["queued", "running", "cancel_requested"].includes(run.status))
      return run;
    await pause(10);
  }
  throw new Error("Generation did not reach terminal state");
}
async function generate(
  service: WorkspaceService,
  id: string,
  target: "wiki" | "cards",
) {
  await service.dispatch("generate", { project_id: id, target });
  return done(service, id, target);
}

test("typed contract accepts only explicit wiki/cards targets and forwards HTTP query selection", () => {
  for (const action of ["generate", "changes", "run", "export", "import"]) {
    const input = {
      project_id: "abc",
      target: "cards",
      ...(action === "import" ? { files: { "cards/a.md": "# Card" } } : {}),
    };
    validateRequest(action, input);
    assert.throws(
      () => validateRequest(action, { ...input, target: "all" }),
      /Invalid content target/,
    );
  }
  for (const route of [
    "/projects/abc/changes?target=cards",
    "/projects/abc/runs/latest?target=cards",
    "/projects/abc/export?target=cards",
  ])
    assert.equal(routeRequest("GET", route).input.target, "cards");
  assert.equal(
    routeRequest("POST", "/projects/abc/generate", { target: "cards" }).input
      .target,
    "cards",
  );
  assert.throws(
    () => routeRequest("GET", "/projects/abc/changes?target=nope"),
    /Invalid content target/,
  );
});
test("service keeps per-kind run status/results and exports while preserving default wiki behavior", async (t) => {
  const f = fixture(t),
    project = await f.service.dispatch("create", { path: f.repo });
  const wiki = await generate(f.service, project.id, "wiki");
  const cards = await generate(f.service, project.id, "cards");
  assert.equal(wiki.target, "wiki");
  assert.equal(cards.target, "cards");
  assert.equal(cards.status, "completed");
  const result = await f.service.dispatch("project", {
    project_id: project.id,
  });
  assert.equal(result.pages.length, 1);
  assert.ok(result.cards.length > 0);
  assert.equal(result.runs_by_kind.wiki.id, wiki.id);
  assert.equal(result.runs_by_kind.cards.id, cards.id);
  assert.equal(
    (await f.service.dispatch("run", { project_id: project.id })).id,
    cards.id,
  );
  assert.equal(
    (
      await f.service.dispatch("run", {
        project_id: project.id,
        target: "wiki",
      })
    ).id,
    wiki.id,
  );
  const files = await f.service.dispatch("export", {
    project_id: project.id,
    target: "cards",
  });
  files["cards/persistence.md"] += "\nOffline note\n";
  await f.service.dispatch("import", {
    project_id: project.id,
    target: "cards",
    files,
  });
  assert.match(
    (
      await f.service.dispatch("page", {
        project_id: project.id,
        slug: "cards/persistence",
      })
    ).markdown,
    /Offline note/,
  );
  await f.service.close();
  const reopened = new WorkspaceService({ dataDir: f.data, watchInterval: 0 });
  try {
    assert.equal(
      (
        await reopened.dispatch("run", {
          project_id: project.id,
          target: "wiki",
        })
      ).id,
      wiki.id,
    );
    assert.equal(
      (
        await reopened.dispatch("run", {
          project_id: project.id,
          target: "cards",
        })
      ).id,
      cards.id,
    );
  } finally {
    await reopened.close();
  }
});
test("canceled card generation cannot start parallel wiki work or erase completed wiki state", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const demo = new DemoProvider();
  const f = fixture(t, {
    providerFactory: () => ({
      name: "demo",
      cache_key: "card-cancel",
      async generate_page(context: Data) {
        if (context.kind === "card") {
          blocked = true;
          await gate;
        }
        return demo.generate_page(context as any);
      },
    }),
  });
  const project = await f.service.dispatch("create", { path: f.repo });
  const wiki = await generate(f.service, project.id, "wiki");
  await f.service.dispatch("generate", {
    project_id: project.id,
    target: "cards",
  });
  while (!blocked) await pause(5);
  await assert.rejects(
    f.service.dispatch("generate", { project_id: project.id, target: "wiki" }),
    /already has/,
  );
  await f.service.dispatch("cancel", { project_id: project.id });
  release();
  assert.equal((await done(f.service, project.id, "cards")).status, "canceled");
  const result = await f.service.dispatch("project", {
    project_id: project.id,
  });
  assert.equal(result.cards.length, 0);
  assert.equal(result.pages.length, 1);
  assert.equal(result.runs_by_kind.wiki.id, wiki.id);
  assert.equal(result.runs_by_kind.wiki.status, "completed");
});
test("failed card run retains both snapshots, redacts secrets and can be retried", async (t) => {
  let fail = false;
  const demo = new DemoProvider();
  const f = fixture(t, {
    providerFactory: () => ({
      name: "demo",
      cache_key: "card-failure",
      generate_page(context: Data) {
        if (fail && context.kind === "card")
          throw new Error("token=SHOULD_NOT_LEAK");
        return demo.generate_page(context as any);
      },
    }),
  });
  const project = await f.service.dispatch("create", { path: f.repo });
  await generate(f.service, project.id, "wiki");
  fail = true;
  const bad = await generate(f.service, project.id, "cards");
  assert.equal(bad.status, "failed");
  assert.doesNotMatch(JSON.stringify(bad), /SHOULD_NOT_LEAK/);
  assert.equal(
    (await f.service.dispatch("project", { project_id: project.id })).cards
      .length,
    0,
  );
  fail = false;
  assert.equal(
    (await generate(f.service, project.id, "cards")).status,
    "completed",
  );
});
test("watcher refreshes generated offline wiki and cards independently but never invents a card collection", async (t) => {
  const f = fixture(t),
    project = await f.service.dispatch("create", { path: f.repo });
  await generate(f.service, project.id, "wiki");
  await f.service.dispatch("watch", { project_id: project.id, enabled: true });
  fs.writeFileSync(
    path.join(f.repo, "storage.ts"),
    "export const VALUE = 2;\n",
  );
  await f.service.dispatch("scan", { project_id: project.id });
  f.service.inspectWatch();
  f.service.inspectWatch();
  await done(f.service, project.id);
  assert.equal(
    (await f.service.dispatch("project", { project_id: project.id }))
      .card_count,
    0,
  );
  await generate(f.service, project.id, "cards");
  fs.writeFileSync(
    path.join(f.repo, "storage.ts"),
    "export const VALUE = 3;\n",
  );
  for (let i = 0; i < 5; i++) {
    await f.service.dispatch("scan", { project_id: project.id });
    await f.service.dispatch("scan", { project_id: project.id, target: "cards" });
    f.service.inspectWatch();
    await done(f.service, project.id);
  }
  assert.equal(
    (
      await f.service.dispatch("changes", {
        project_id: project.id,
        target: "wiki",
      })
    ).changed_count,
    0,
  );
  assert.equal(
    (
      await f.service.dispatch("changes", {
        project_id: project.id,
        target: "cards",
      })
    ).changed_count,
    0,
  );
});
test("new Git branch never inherits another branch collection counts or completed run status", async (t) => {
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
  const project = await f.service.dispatch("create", { path: f.repo });
  await generate(f.service, project.id, "wiki");
  await generate(f.service, project.id, "cards");
  git("checkout", "-b", "feature");
  await f.service.dispatch("scan", { project_id: project.id });
  const current = await f.service.dispatch("project", {
    project_id: project.id,
  });
  for (const target of ["wiki", "cards"]) {
    assert.equal(current.knowledge[target].count, 0);
    assert.equal(current.knowledge[target].status, "not_generated");
    assert.equal(current.knowledge[target].last_run, null);
    assert.equal(current.runs_by_kind[target].status, "idle");
    assert.equal(
      (await f.service.dispatch("run", { project_id: project.id, target }))
        .status,
      "idle",
    );
  }
});
test(
  "actual separate OS child accepts cards target, preserves wiki documents, and persists cards through restart",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    await f.service.close();
    const entry = process.env.REPOWIKI_TEST_ENTRY ?? fileURLToPath(
      new URL("../../../dist/packages/process/src/child.js", import.meta.url),
    );
    fs.accessSync(entry);
    const clients: RepoWikiProcessClient[] = [];
    const create = () => {
      const client = new RepoWikiProcessClient({
        entry,
        executable: process.env.REPOWIKI_TEST_EXECUTABLE,
        dataDir: f.data,
        allowedRoots: [f.repo],
        maxRestarts: 0,
        requestTimeoutMs: 5000,
      });
      clients.push(client);
      return client;
    };
    t.after(async () => {
      for (const client of clients) await client.stop();
    });
    const client = create();
    const project = await client.invoke("create", { path: f.repo });
    assert.notEqual(client.pid, process.pid);
    const wait = async (target: "wiki" | "cards") => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const run = await client.invoke("run", {
          project_id: project.id,
          target,
        });
        if (["completed", "failed", "canceled"].includes(run.status))
          return run;
        await pause(20);
      }
      throw new Error("Child target run timed out");
    };
    await client.invoke("generate", { project_id: project.id });
    assert.equal((await wait("wiki")).status, "completed");
    const wiki = await client.invoke("page", {
      project_id: project.id,
      slug: "overview",
    });
    await client.invoke("generate", {
      project_id: project.id,
      target: "cards",
    });
    assert.equal((await wait("cards")).status, "completed");
    const state = await client.invoke("project", { project_id: project.id });
    assert.ok(state.cards!.length > 0);
    assert.deepEqual(
      await client.invoke("page", { project_id: project.id, slug: "overview" }),
      wiki,
    );
    const first = state.cards![0];
    const edited = await client.invoke("edit", {
      project_id: project.id,
      slug: first.id,
      expected_revision: first.revision,
      markdown: first.markdown + "\nIPC human note\n",
    });
    await client.stop();
    const reopened = create();
    assert.deepEqual(
      await reopened.invoke("page", { project_id: project.id, slug: first.id }),
      edited,
    );
    await reopened.stop();
  },
);
