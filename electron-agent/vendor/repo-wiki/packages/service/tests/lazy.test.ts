import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceService } from "../src/service.js";

function fixture(t: any, extra: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repowiki-lazy-service-"));
  const project = { id: "fixture", path: root, language: "zh", watch: false, pages: [], cards: [], identity: { branch: "main", language: "zh" } };
  let hydrated = 0, legacy = 0, scans = 0, aborted = 0, generated = 0, changeReads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engine = {
    hydrate_project: async () => { hydrated++; return project; },
    create_project: () => { legacy++; return project; },
    get_project: () => project,
    list_projects: () => [project],
    changes: () => { changeReads++; return { identity: project.identity, changed: [], changed_count: 0 }; },
    scan_project: async (_id: string, options: any) => {
      scans++;
      await Promise.race([gate, new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted++; reject(new Error("scan aborted")); }, { once: true }))]);
      return { identity: project.identity, scanned_at: "fixture" };
    },
    generate: async (_id: string, _provider: any, _force: any, _progress: any, _target: any, options: any) => {
      generated++;
      await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted++; reject(new Error("generation aborted")); }, { once: true }));
    },
    set_watch: (_id: string, enabled: boolean) => Object.assign(project, { watch: enabled }),
    close: () => {},
  };
  const service = new WorkspaceService({ dataDir: path.join(root, "state"), engine: engine as any, watchInterval: 0, automaticGeneration: false, providerFactory: () => ({ name: "demo", cache_key: "demo", generate_page() {} }) as any, ...extra });
  t.after(async () => { release(); await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, release, reads: () => changeReads, counts: () => ({ hydrated, legacy, scans, aborted, generated }) };
}

test("create hydrates only and cheap status queries do not scan", async t => {
  const f = fixture(t);
  await f.service.dispatch("create", { path: f.root });
  await Promise.all([f.service.dispatch("health", {}), f.service.dispatch("project", { project_id: "fixture" }), f.service.dispatch("changes", { project_id: "fixture" }), f.service.dispatch("run", { project_id: "fixture" })]);
  assert.deepEqual(f.counts(), { hydrated: 1, legacy: 0, scans: 0, aborted: 0, generated: 0 });
});

test("explicit scans coalesce while health/run/cancel remain responsive; last cancellation stops scan", async t => {
  const f = fixture(t);
  const one = new AbortController(), two = new AbortController();
  const first = f.service.dispatch("scan", { project_id: "fixture" }, { signal: one.signal } as any).catch(error => error);
  const second = f.service.dispatch("scan", { project_id: "fixture" }, { signal: two.signal } as any).catch(error => error);
  await delay(10);
  assert.equal(f.counts().scans, 1);
  assert.equal((await f.service.dispatch("health", {})).status, "ok");
  assert.equal((await f.service.dispatch("run", { project_id: "fixture" })).status, "idle");
  one.abort(); await first;
  assert.equal(f.counts().aborted, 0, "one retired caller must not cancel another caller's scan");
  two.abort();
  assert.ok(await first instanceof Error); assert.ok(await second instanceof Error);
  assert.equal(f.counts().aborted, 1);
  assert.equal((await f.service.dispatch("cancel", { project_id: "fixture" })).status, "idle");
});

test("generation receives cancellation during scan and retains originating progress context", async t => {
  const f = fixture(t);
  const events: any[] = [];
  f.service.subscribe(event => events.push(event));
  await f.service.dispatch("generate", { project_id: "fixture" }, { contextId: "original" } as any);
  await delay(10);
  await f.service.cancelContext("original");
  await delay(10);
  assert.equal(f.counts().aborted, 1);
  assert.equal((await f.service.dispatch("run", { project_id: "fixture" })).status, "canceled");
  assert.ok(events.length > 0 && events.every(event => event.context_id === "original"));
});

test("embedded watchers never schedule periodic full scans or auto generation", async t => {
  const f = fixture(t, { watchInterval: 5, watchDebounce: 5 });
  await f.service.dispatch("watch", { project_id: "fixture", enabled: true });
  fs.writeFileSync(path.join(f.root, "source.ts"), "export const changed=1");
  await delay(60);
  assert.equal(f.counts().scans, 0);
  assert.equal(f.counts().generated, 0);
  assert.equal(f.reads(), 0, "watching must not periodically recompute source changes");
});

test("an external generation signal remains live after the queued response", async t => {
  const f = fixture(t), controller = new AbortController();
  await f.service.dispatch("generate", { project_id: "fixture" }, { signal: controller.signal });
  await delay(10); controller.abort(); await delay(10);
  assert.equal(f.counts().aborted, 1);
  assert.equal((await f.service.dispatch("run", { project_id: "fixture" })).status, "canceled");
});

test("embedded page and plan writes require original file tokens", async t => {
  const f = fixture(t, { requireStorageTokens: true });
  await assert.rejects(f.service.dispatch("edit", { project_id: "fixture", slug: "overview", markdown: "new", expected_revision: 1 }), /storage token is required/);
  await assert.rejects(f.service.dispatch("resolve", { project_id: "fixture", slug: "overview", markdown: "new", expected_revision: 1 }), /storage token is required/);
  await assert.rejects(f.service.dispatch("plan", { project_id: "fixture", plan: {} }), /storage token is required/);
  await assert.rejects(f.service.dispatch("edit", { project_id: "fixture", slug: "overview", markdown: "new", expected_revision: 1, expected_storage_token: "malformed" }), /Invalid expected_storage_token/);
});

test("unrelated missing approved roots do not block startup or current hydration", async t => {
  const f = fixture(t, { allowedRoots: [path.join(os.tmpdir(), "missing-repowiki-root")] });
  assert.equal((await f.service.dispatch("health", {})).status, "ok");
});

test("explicit empty host roots deny access and revoked roots stay denied", async t => {
  const denied = fixture(t, { allowedRoots: [] });
  await assert.rejects(denied.service.dispatch("project", { project_id: "fixture" }), /outside the host-approved/);
  const active = fixture(t);
  await active.service.dispatch("project", { project_id: "fixture" });
  active.service.updateHostRoots([]);
  await assert.rejects(active.service.dispatch("project", { project_id: "fixture" }), /outside the host-approved/);
});

test("Windows Docs output notifications do not mark sources stale, while ordinary Docs files still do", { skip: process.platform !== "win32" }, async t => {
  for (const automaticGeneration of [false, true]) {
    const f = fixture(t, { watchInterval: 1, watchDebounce: 5, automaticGeneration });
    f.release();
    const documents = path.join(f.root, "Docs", "repo-wiki", "zh");
    fs.mkdirSync(documents, { recursive: true });
    await f.service.dispatch("watch", { project_id: "fixture", enabled: true });
    const generated = path.join(documents, "overview.md");
    fs.writeFileSync(generated, "# Generated fixture document\n");
    await delay(100);
    assert.equal((await f.service.dispatch("project", { project_id: "fixture" })).watch_status.status, "watching", "generated wiki files under existing Docs must be ignored");
    fs.appendFileSync(generated, "External human document edit.\n");
    await delay(100);
    assert.equal((await f.service.dispatch("project", { project_id: "fixture" })).watch_status.status, "watching", "external wiki edits must not be treated as source changes");
    assert.equal(f.counts().scans, 0); assert.equal(f.reads(), 0);
    fs.writeFileSync(path.join(f.root, "Docs", "guide.md"), "# Ordinary source documentation\n");
    const deadline = Date.now() + 2000;
    while (automaticGeneration ? f.counts().scans === 0 : (await f.service.dispatch("project", { project_id: "fixture" })).watch_status.status !== "needs_generation") {
      if (Date.now() > deadline) throw new Error("Ordinary Docs source notification was not observed");
      await delay(10);
    }
  }
});
