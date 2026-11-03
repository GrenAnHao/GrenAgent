import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import rawFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkspaceService,
  safeError,
  type WorkspaceServiceOptions,
} from "../src/service.js";
import { WorkspaceEngine } from "../../core/src/engine.js";
import { DemoProvider, ProviderError } from "../../core/src/providers.js";
import { ContractError } from "../../contracts/src/index.js";
import { ScannerError } from "../../core/src/scanner.js";

type Data = Record<string, any>;
function fixture(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: Partial<WorkspaceServiceOptions> = {},
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-service-")),
    root = path.join(base, "repository"),
    data = path.join(base, "state");
  fs.mkdirSync(root);
  const write = (name: string, content: string) => {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  };
  write(
    "main.ts",
    'import {value} from "./value.js";\nexport const main = value;\n',
  );
  write("value.ts", "export const value = 1;\n");
  write(
    "wiki_plan.json",
    JSON.stringify({
      include: ["**"],
      exclude: [],
      pages: [
        {
          id: "overview",
          title: "Overview",
          goal: "Document evidence",
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
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, data, write, service };
}
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 3000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error("Test outcome timed out: " + JSON.stringify(value));
    await delay(10);
  }
}
const runDone = (s: WorkspaceService, id: string) =>
  until(
    () => s.dispatch("run", { project_id: id }),
    (run) => !["queued", "running", "cancel_requested"].includes(run.status),
  );
const makeProject = (f: ReturnType<typeof fixture>) =>
  f.service.dispatch("create", { path: f.root, language: "en" });
const generate = async (s: WorkspaceService, id: string, extra: Data = {}) => {
  await s.dispatch("generate", { project_id: id, provider: "demo", ...extra });
  return runDone(s, id);
};
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("reusable service supports complete offline create/generate/edit/export/import/source flow", async (t) => {
  const f = fixture(t),
    p = await makeProject(f);
  const health = await f.service.dispatch("health", {});
  assert.match(health.backend, /TypeScript/);
  assert.equal(health.local_only, true);
  const events: Data[] = [];
  const unsubscribe = f.service.subscribe((event) => events.push(event));
  assert.equal((await generate(f.service, p.id)).status, "completed");
  assert(events.some((event) => event.run.stage === "committing"));
  unsubscribe();
  const page = await f.service.dispatch("page", {
    project_id: p.id,
    slug: "overview",
  });
  assert(page.sources.length > 0);
  const edited = await f.service.dispatch("edit", {
    project_id: p.id,
    slug: "overview",
    markdown: page.markdown + "\nHuman note.\n",
    expected_revision: page.revision,
  });
  assert.equal(edited.status, "edited");
  await assert.rejects(
    f.service.dispatch("edit", {
      project_id: p.id,
      slug: "overview",
      markdown: "stale",
      expected_revision: page.revision,
    }),
    (error) => (error as any).status === 409,
  );
  const files = await f.service.dispatch("export", { project_id: p.id });
  const markdown = Object.keys(files).find((name) => name.endsWith(".md"))!;
  assert(files[markdown].includes("Human note."));
  files[markdown] += "\nImported note.\n";
  await f.service.dispatch("import", { project_id: p.id, files });
  assert.match(
    (await f.service.dispatch("page", { project_id: p.id, slug: "overview" }))
      .markdown,
    /Imported note/,
  );
  const source = await f.service.dispatch("source", {
    project_id: p.id,
    path: "value.ts",
    start_line: 1,
    end_line: 1,
  });
  assert.equal(source.content, "export const value = 1;");
  assert.equal(
    (await f.service.dispatch("source", { project_id: p.id, path: "value.ts" }))
      .total_lines,
    1,
  );
  await assert.rejects(
    f.service.dispatch("source", {
      project_id: p.id,
      path: "../state/workspace.sqlite3",
    }),
  );
  assert(
    (await f.service.dispatch("projects", {})).some(
      (item: Data) => item.id === p.id,
    ),
  );
});
test("all IPC/service commands validate fields and reject implicit external model requests", async (t) => {
  let factories = 0;
  const f = fixture(t, {
      providerFactory: () => {
        factories++;
        return new DemoProvider();
      },
    }),
    p = await makeProject(f);
  await assert.rejects(
    f.service.dispatch("generate", { project_id: p.id, provider: "real" }),
    (error) => (error as any).status === 403,
  );
  assert.equal(factories, 0);
  for (const [action, input] of [
    ["__proto__", {}],
    ["health", { unexpected: true }],
    ["generate", { project_id: p.id, provider: "bad" }],
    ["watch", { project_id: p.id, enabled: "yes" }],
    [
      "source",
      { project_id: p.id, path: "main.ts", start_line: 1, end_line: 3000 },
    ],
  ])
    await assert.rejects(f.service.dispatch(action as string, input));
  assert.equal(
    (
      await generate(f.service, p.id, {
        provider: "real",
        confirm_external: true,
      })
    ).status,
    "completed",
  );
  assert.equal(factories, 1);
});
test("approved workspace realpaths prevent access through symlinks and hide persisted outside projects", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-roots-")),
    allowed = path.join(base, "allowed"),
    outside = path.join(base, "outside"),
    data = path.join(base, "state");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "x.ts"), "x");
  fs.symlinkSync(outside, path.join(allowed, "link"));
  const engine = new WorkspaceEngine(data),
    outsideProject = engine.create_project(outside);
  const service = new WorkspaceService({
    dataDir: data,
    engine,
    allowedRoots: [allowed],
    watchInterval: 0,
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  await assert.rejects(
    service.dispatch("create", { path: outside }),
    (error) => (error as any).status === 403,
  );
  await assert.rejects(
    service.dispatch("create", { path: path.join(allowed, "link") }),
  );
  assert.deepEqual(await service.dispatch("projects", {}), []);
  await assert.rejects(
    service.dispatch("project", { project_id: outsideProject.id }),
    (error) => (error as any).status === 403,
  );
  await assert.rejects(
    service.dispatch("clone", { url: "https://github.com/example/repository" }),
    (error) => (error as any).status === 403,
  );
});
test("one job per project, two global concurrent jobs, and queued cancellation sends no provider request", async (t) => {
  const gate = deferred();
  let started = 0,
    active = 0,
    maxActive = 0;
  const demo = new DemoProvider();
  const f = fixture(t, {
    providerFactory: () => ({
      name: "demo",
      cache_key: "delayed",
      generate_page: async (context: Data) => {
        started++;
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        return demo.generate_page(context as any);
      },
    }),
  });
  const projects = [];
  for (let i = 0; i < 3; i++) {
    const repo = path.join(f.base, "repo" + i);
    fs.mkdirSync(repo);
    fs.copyFileSync(
      path.join(f.root, "wiki_plan.json"),
      path.join(repo, "wiki_plan.json"),
    );
    fs.writeFileSync(path.join(repo, "a.ts"), "const a=1");
    projects.push(await f.service.dispatch("create", { path: repo }));
  }
  for (const project of projects)
    await f.service.dispatch("generate", { project_id: project.id });
  await assert.rejects(
    f.service.dispatch("generate", { project_id: projects[0].id }),
    (error) => (error as any).status === 409,
  );
  await until(
    async () => started,
    (value) => value === 2,
  );
  assert.equal(maxActive, 2);
  const canceled = await f.service.dispatch("cancel", {
    project_id: projects[2].id,
  });
  assert.equal(canceled.status, "canceled");
  gate.release();
  assert.equal((await runDone(f.service, projects[0].id)).status, "completed");
  assert.equal((await runDone(f.service, projects[1].id)).status, "completed");
  assert.equal(started, 2);
});
test("cancellation aborts provider signal and protects existing pages even when a provider ignores abort", async (t) => {
  const gate = deferred();
  let signal: AbortSignal | undefined;
  const demo = new DemoProvider();
  let slow = false;
  const f = fixture(t, {
      providerFactory: () =>
        slow
          ? {
              name: "demo",
              cache_key: "slow",
              generate_page: async (
                context: Data,
                options?: { signal?: AbortSignal },
              ) => {
                signal = options?.signal;
                await gate.promise;
                return demo.generate_page(context as any);
              },
            }
          : demo,
    }),
    p = await makeProject(f);
  await generate(f.service, p.id);
  const before = await f.service.dispatch("page", {
    project_id: p.id,
    slug: "overview",
  });
  slow = true;
  await f.service.dispatch("generate", { project_id: p.id, force: true });
  await until(
    async () => signal,
    (value) => Boolean(value),
  );
  assert.equal(
    (await f.service.dispatch("cancel", { project_id: p.id })).status,
    "cancel_requested",
  );
  assert.equal(signal!.aborted, true);
  assert.equal(
    (await f.service.dispatch("cancel", { project_id: p.id })).status,
    "cancel_requested",
  );
  gate.release();
  assert.equal((await runDone(f.service, p.id)).status, "canceled");
  assert.deepEqual(
    await f.service.dispatch("page", { project_id: p.id, slug: "overview" }),
    before,
  );
});
test("atomic committing phase rejects late cancellation rather than falsely claiming rollback", async (t) => {
  const f = fixture(t),
    p = await makeProject(f);
  let late: Promise<unknown> | undefined;
  f.service.subscribe((event) => {
    if (event.run.stage === "committing")
      late = f.service.dispatch("cancel", { project_id: p.id }).then(
        () => {
          throw new Error("Expected 409");
        },
        (error) => {
          assert.equal(error.status, 409);
        },
      );
  });
  assert.equal((await generate(f.service, p.id)).status, "completed");
  assert(late);
  await late;
});
test("unknown provider errors are redacted, safe provider errors are useful, failed runs can retry", async (t) => {
  let fail = true;
  const demo = new DemoProvider();
  const f = fixture(t, {
      providerFactory: () => ({
        name: "demo",
        cache_key: "failure",
        generate_page: (context) => {
          if (fail)
            throw new Error("Authorization: sk-secret actual private body");
          return demo.generate_page(context as any);
        },
      }),
    }),
    p = await makeProject(f);
  const run = await generate(f.service, p.id);
  assert.equal(run.status, "failed");
  assert(!JSON.stringify(run).includes("sk-secret"));
  assert.equal(f.service.engine.get_project(p.id).pages.length, 0);
  fail = false;
  assert.equal((await generate(f.service, p.id)).status, "completed");
  assert.equal(
    safeError(new ProviderError("Provider rejected authentication.")).message,
    "Provider rejected authentication.",
  );
  assert.equal(safeError(new Error("sk-secret")).status, 500);
});
test("run events are isolated from subscriber mutation and unsubscribing is idempotent", async (t) => {
  const f = fixture(t),
    p = await makeProject(f);
  let seen = 0;
  const unsubscribe = f.service.subscribe((event) => {
    seen++;
    event.run.status = "tampered";
    throw new Error("listener");
  });
  await generate(f.service, p.id);
  assert.equal(
    (await f.service.dispatch("run", { project_id: p.id })).status,
    "completed",
  );
  assert(seen > 0);
  unsubscribe();
  unsubscribe();
  const count = seen;
  await generate(f.service, p.id);
  assert.equal(seen, count);
});
test("restart marks impossible active jobs interrupted without losing run identity", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-restart-"));
  fs.writeFileSync(
    path.join(base, "workspace-runs.json"),
    JSON.stringify({
      project: {
        id: "prior-run",
        status: "running",
        events: [],
        provider: "demo",
      },
    }),
  );
  const service = new WorkspaceService({ dataDir: base, watchInterval: 0 });
  t.after(async () => {
    await service.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const persisted = JSON.parse(
    fs.readFileSync(path.join(base, "workspace-runs.json"), "utf8"),
  );
  assert.equal(persisted.project.status, "interrupted");
  assert.equal(persisted.project.id, "prior-run");
  assert.equal(persisted.project.cancelable, false);
});
test("watcher debounces and auto-refreshes only explicitly selected demo generation", async (t) => {
  const f = fixture(t),
    p = await makeProject(f);
  await generate(f.service, p.id);
  await f.service.dispatch("watch", { project_id: p.id, enabled: true });
  f.write("value.ts", "export const value = 2;\n");
  await f.service.dispatch("scan", { project_id: p.id });
  f.service.inspectWatch();
  assert.equal(
    (await f.service.dispatch("project", { project_id: p.id })).watch_status
      .status,
    "debouncing",
  );
  f.service.inspectWatch();
  await runDone(f.service, p.id);
  assert.equal(
    (await f.service.dispatch("changes", { project_id: p.id })).changed_count,
    0,
  );
  await f.service.dispatch("watch", { project_id: p.id, enabled: false });
  f.write("value.ts", "export const value = 3;\n");
  f.service.inspectWatch();
  assert.equal(
    (await f.service.dispatch("project", { project_id: p.id })).watch_status
      .status,
    "disabled",
  );
});
test("watcher never silently sends external requests and canceled snapshots do not auto-restart", async (t) => {
  let calls = 0;
  const demo = new DemoProvider();
  const f = fixture(t, {
      providerFactory: (mode) => ({
        name: mode,
        cache_key: mode,
        generate_page: (context) => {
          calls++;
          return demo.generate_page(context as any);
        },
      }),
    }),
    p = await makeProject(f);
  await generate(f.service, p.id, { provider: "real", confirm_external: true });
  await f.service.dispatch("watch", { project_id: p.id, enabled: true });
  f.write("value.ts", "export const value = 9;");
  await f.service.dispatch("scan", { project_id: p.id });
  f.service.inspectWatch();
  f.service.inspectWatch();
  assert.equal(
    (await f.service.dispatch("project", { project_id: p.id })).watch_status
      .status,
    "stale",
  );
  assert.equal(calls, 1);
  await f.service.dispatch("generate", { project_id: p.id, provider: "demo" });
  await f.service.dispatch("cancel", { project_id: p.id });
  f.service.inspectWatch();
  f.service.inspectWatch();
  assert.equal(
    (await f.service.dispatch("project", { project_id: p.id })).watch_status
      .status,
    "stale",
  );
  assert.equal(calls, 1);
});
test("watcher does not spin retry a failed source snapshot", async (t) => {
  let fail = false,
    calls = 0;
  const demo = new DemoProvider();
  const f = fixture(t, {
      providerFactory: () => ({
        name: "demo",
        cache_key: "watch-test",
        generate_page: (context) => {
          calls++;
          if (fail) throw new Error("failed");
          return demo.generate_page(context as any);
        },
      }),
    }),
    p = await makeProject(f);
  await generate(f.service, p.id);
  fail = true;
  await f.service.dispatch("watch", { project_id: p.id, enabled: true });
  f.write("value.ts", "export const value = 10;");
  await f.service.dispatch("scan", { project_id: p.id });
  f.service.inspectWatch();
  f.service.inspectWatch();
  assert.equal((await runDone(f.service, p.id)).status, "failed");
  const previous = calls;
  for (let i = 0; i < 4; i++) f.service.inspectWatch();
  await delay(20);
  assert.equal(calls, previous);
});
test("close aborts in-flight work, preserves resumable progress, disposes listeners and rejects new requests", async (t) => {
  const demo = new DemoProvider();
  let started = false;
  const f = fixture(t, {
      providerFactory: () => ({
        name: "demo",
        cache_key: "shutdown",
        generate_page: async (
          context: Data,
          options?: { signal?: AbortSignal },
        ) => {
          started = true;
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return demo.generate_page(context as any);
        },
      }),
    }),
    p = await makeProject(f);
  await f.service.dispatch("generate", { project_id: p.id });
  await until(async () => started, Boolean);
  await f.service.close();
  await assert.rejects(
    f.service.dispatch("health", {}),
    (error) => (error as any).status === 503,
  );
  assert.throws(() => f.service.subscribe(() => {}), ContractError);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(f.data, "workspace-runs.json"), "utf8"),
  );
  assert.equal(persisted[p.id].status, "interrupted");
});

test("stable task run resumes only unfinished pages after pause and service restart", async (t) => {
  const demo = new DemoProvider(), calls: string[] = [];
  const f = fixture(t, {
    providerFactory: () => ({
      name: "demo", cache_key: "durable-v1",
      generate_page: async (context: Data, options?: { signal?: AbortSignal }) => {
        calls.push(context.page_id);
        if (context.page_id === "second") await new Promise<void>((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("paused"), { name: "AbortError" })), { once: true });
        });
        return demo.generate_page(context as any);
      },
    }),
  });
  f.write("wiki_plan.json", JSON.stringify({ include: ["**"], exclude: [], pages: [
    { id: "first", title: "First", goal: "First", patterns: ["main.ts"], depends_on: [] },
    { id: "second", title: "Second", goal: "Second", patterns: ["value.ts"], depends_on: ["first"] },
  ] }));
  const p = await makeProject(f);
  const input = { project_id: p.id, provider: "demo", force: true, resume_run_id: "task-resume" };
  assert.equal((await f.service.dispatch("generate", input)).run_id, "task-resume");
  assert.equal((await f.service.dispatch("generate", input)).run_id, "task-resume");
  await until(async () => calls.includes("second"), Boolean);
  await f.service.dispatch("cancel", { project_id: p.id, pause: true });
  assert.equal((await runDone(f.service, p.id)).status, "interrupted");
  await f.service.close();
  calls.length = 0;
  const reopened = new WorkspaceService({ dataDir: f.data, watchInterval: 0, providerFactory: () => ({
    name: "demo", cache_key: "durable-v1",
    generate_page: (context: Data) => { calls.push(context.page_id); return demo.generate_page(context as any); },
  }) });
  try {
    assert.equal((await reopened.dispatch("generate", input)).run_id, "task-resume");
    const completed = await runDone(reopened, p.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(calls, ["second"]);
    assert.equal(completed.result.resumed, 1);
    assert.equal((await reopened.dispatch("generate", input)).status, "completed");
    assert.deepEqual(calls, ["second"]);
  } finally {
    await reopened.close();
  }
});

test("explicitly canceled stable task cannot be restarted by replaying its task id", async (t) => {
  const f = fixture(t), p = await makeProject(f);
  const input = { project_id: p.id, resume_run_id: "task-canceled" };
  await f.service.dispatch("generate", input);
  await f.service.dispatch("cancel", { project_id: p.id });
  assert.equal((await runDone(f.service, p.id)).status, "canceled");
  assert.equal((await f.service.dispatch("generate", input)).status, "canceled");
  assert.equal((await f.service.dispatch("run", { project_id: p.id })).id, "task-canceled");
});

test("active generation rejects plan replacement before any mutation", async (t) => {
  const gate = deferred();
  const demo = new DemoProvider();
  let started = false;
  const f = fixture(t, {
      providerFactory: () => ({
        name: "demo",
        cache_key: "planlock",
        generate_page: async (context: Data) => {
          started = true;
          await gate.promise;
          return demo.generate_page(context as any);
        },
      }),
    }),
    p = await makeProject(f);
  await f.service.dispatch("generate", { project_id: p.id });
  await until(async () => started, Boolean);
  await assert.rejects(
    f.service.dispatch("plan", {
      project_id: p.id,
      plan: {
        include: ["**"],
        exclude: [],
        pages: [{ id: "other", title: "Other" }],
      },
    }),
    (error) => (error as any).status === 409,
  );
  gate.release();
  assert.equal((await runDone(f.service, p.id)).status, "completed");
});
test("shutdown waits for Git clone cancellation cleanup before returning", async (t) => {
  const cleanup = deferred();
  let signal: AbortSignal | undefined,
    finished = false;
  const f = fixture(t, {
    cloneRepository: async (_url, _root, options) => {
      signal = options?.signal;
      await cleanup.promise;
      finished = true;
      throw new Error("Canceled clone output must not escape");
    },
  });
  const pending = f.service.dispatch("clone", {
    url: "https://github.com/example/repo",
  });
  const rejected = assert.rejects(pending);
  await until(async () => signal, Boolean);
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  assert.equal(signal!.aborted, true);
  await delay(20);
  assert.equal(closed, false);
  cleanup.release();
  await rejected;
  await closing;
  assert.equal(finished, true);
  assert.equal(closed, true);
});

test("authored scanner validation errors retain safe 400 while spoofed status errors stay redacted", () => {
  assert.deepEqual(
    safeError(new ScannerError("Only safe POSIX relative paths are accepted")),
    { status: 400, message: "Only safe POSIX relative paths are accepted" },
  );
  assert.equal(
    safeError(Object.assign(new Error("sk-private"), { status: 400 })).status,
    500,
  );
  assert(
    !safeError(
      Object.assign(new Error("sk-private"), { status: 400 }),
    ).message.includes("sk-private"),
  );
});

test("create permission failures stay explicit and cannot succeed only in the cache", async t => {
  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    const f = fixture(t), mkdir = rawFs.mkdirSync;
    const docs = path.join(f.root, "docs");
    rawFs.mkdirSync = ((destination: fs.PathLike, options: any) => {
      const target = path.resolve(String(destination));
      if (target === docs || target.startsWith(docs + path.sep)) throw Object.assign(new Error("private-path private-key"), { code });
      return mkdir(destination, options);
    }) as typeof rawFs.mkdirSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.service.dispatch("create", { path: f.root }), error => {
        const safe = safeError(error);
        assert.equal(safe.status, 403);
        assert.match(safe.message, /folder permissions|read-only/i);
        assert.doesNotMatch(safe.message, /private-path|private-key/);
        return true;
      });
    } finally {
      rawFs.mkdirSync = mkdir;
      syncBuiltinESMExports();
    }
    assert.equal(fs.existsSync(path.join(docs, "repo-wiki")), false);
    assert.deepEqual(await f.service.dispatch("projects", {}), []);
  }
});
