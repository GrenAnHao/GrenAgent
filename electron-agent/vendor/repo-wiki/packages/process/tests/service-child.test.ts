/** Actual compiled Node service process, real temp SQLite/filesystem; no HTTP provider or Electron binary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepoWikiProcessClient } from "../src/client.js";
const entry = process.env.REPOWIKI_TEST_ENTRY ?? fileURLToPath(
  new URL("../../../dist/packages/process/src/child.js", import.meta.url),
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitRun(
  client: RepoWikiProcessClient,
  project_id: string,
  run_id?: string,
  timeout = 8000,
): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const run = await client.invoke("run", { project_id });
    if (
      (!run_id || run.id === run_id) &&
      ["completed", "failed", "canceled", "interrupted"].includes(run.status)
    )
      return run;
    await pause(20);
  }
  throw new Error("Service run did not reach a terminal state");
}
async function fixture(
  t: any,
  options: Partial<ConstructorParameters<typeof RepoWikiProcessClient>[0]> = {},
) {
  await access(entry); // npm run build:core is the explicit prerequisite; never skip a missing build.
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-service-child-"));
  const repo = path.join(root, "repo"),
    dataDir = path.join(root, "state");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "README.md"),
    "# Test repository\nThis fixture is not user data.\n",
  );
  await writeFile(
    path.join(repo, "src/service.ts"),
    'export function run() {\n  return "ready";\n}\n',
  );
  await writeFile(
    path.join(repo, "wiki_plan.json"),
    JSON.stringify({
      include: ["**"],
      exclude: [],
      pages: [
        {
          id: "overview",
          title: "Overview",
          goal: "Describe evidence",
          patterns: ["**"],
          depends_on: [],
        },
        {
          id: "usage",
          title: "Usage",
          goal: "Explain actual source",
          patterns: ["src/**"],
          depends_on: ["overview"],
        },
      ],
    }),
  );
  const clients: RepoWikiProcessClient[] = [];
  const create = () => {
    const client = new RepoWikiProcessClient({
      entry,
      executable: process.env.REPOWIKI_TEST_EXECUTABLE,
      dataDir,
      allowedRoots: [repo],
      maxRestarts: 0,
      requestTimeoutMs: 5000,
      stopTimeoutMs: 2000,
      ...options,
    });
    clients.push(client);
    return client;
  };
  const client = create();
  t.after(async () => {
    for (const item of clients) await item.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { client, repo, root, dataDir, create };
}
test(
  "actual isolated service generates, protects edits/conflicts, exports/imports, watches and persists across restart",
  // Real Git/SQLite work on Windows includes executable startup and filesystem
  // scanning overhead; keep per-request/run deadlines, allow the full workflow.
  { timeout: process.platform === "win32" ? 90000 : 20000 },
  async (t) => {
    const { client, repo, root, create } = await fixture(t);
    const health = await client.invoke("health", {});
    assert.match(health.backend, /TypeScript.*isolated process/);
    assert.notEqual(client.pid, process.pid);
    await assert.rejects(
      client.invoke("create", { path: root }),
      /approved|outside/,
    );
    const project = await client.invoke("create", {
      path: repo,
      language: "en",
      name: "Node fixture",
    });
    const project_id = project.id;
    const events: any[] = [];
    const off = client.subscribe((event) => events.push(event));
    t.after(off);
    const job = await client.invoke("generate", {
      project_id,
      provider: "demo",
    });
    const done = await waitRun(client, project_id, job.run_id);
    assert.equal(done.status, "completed");
    assert.equal(done.result.generated, 2);
    assert.ok(events.some((event) => event.project_id === project_id));
    let page = await client.invoke("page", { project_id, slug: "overview" });
    assert.match(page.markdown, /No language model was called/);
    assert.ok(
      page.sources.some(
        (source) => source.path === "src/service.ts" && source.hash,
      ),
    );
    const source = await client.invoke("source", {
      project_id,
      path: "src/service.ts",
      start_line: 1,
      end_line: 3,
    });
    assert.match(source.content, /function run/);
    await assert.rejects(
      client.invoke("source", { project_id, path: "../README.md" }),
      /safe|traversal|scope|Invalid|withheld/i,
    );
    page = await client.invoke("edit", {
      project_id,
      slug: "overview",
      markdown: page.markdown + "\nHuman authored note.\n",
      expected_revision: page.revision,
    });
    await assert.rejects(
      client.invoke("edit", {
        project_id,
        slug: "overview",
        markdown: "stale",
        expected_revision: page.revision - 1,
      }),
      /revision|changed|stale/i,
    );
    await appendFile(
      path.join(repo, "src/service.ts"),
      "// a new structural fact\n",
    );
    await client.invoke("scan", { project_id });
    const changed = await client.invoke("changes", { project_id });
    assert.ok((changed.affected_pages as string[]).includes("overview"));
    await client.invoke("generate", { project_id, provider: "demo" });
    assert.equal((await waitRun(client, project_id)).status, "completed");
    page = await client.invoke("page", { project_id, slug: "overview" });
    assert.match(page.markdown, /Human authored note/);
    assert.notEqual(page.status, "conflict");
    const exported = await client.invoke("export", { project_id });
    assert.ok(exported[".repowiki-manifest.json"]);
    assert.match(exported["overview.md"]!, /Human authored note/);
    const imported = await client.invoke("import", {
      project_id,
      files: {
        ".repowiki-manifest.json": exported[".repowiki-manifest.json"]!,
        "overview.md": exported["overview.md"] + "\nImported through IPC.\n",
      },
    });
    assert.ok(imported);
    page = await client.invoke("page", { project_id, slug: "overview" });
    assert.match(page.markdown, /Imported through IPC/);
    await client.invoke("edit", {
      project_id,
      slug: "overview",
      markdown:
        "# Handwritten protected document\nKeep this exact human text.\n",
      expected_revision: page.revision,
    });
    await appendFile(
      path.join(repo, "src/service.ts"),
      "// source changed again\n",
    );
    await client.invoke("generate", { project_id, provider: "demo" });
    await waitRun(client, project_id);
    page = await client.invoke("page", { project_id, slug: "overview" });
    assert.equal(page.status, "conflict");
    assert.match(page.markdown, /Keep this exact human text/);
    assert.ok(page.pending_markdown);
    page = await client.invoke("resolve", {
      project_id,
      slug: "overview",
      markdown: page.pending_markdown + "\nResolved human note.\n",
      expected_revision: page.revision,
    });
    assert.equal(page.status, "edited");
    const beforeWatch = await client.invoke("run", { project_id });
    await client.invoke("watch", { project_id, enabled: true });
    await appendFile(
      path.join(repo, "src/service.ts"),
      "// watcher evidence\n",
    );
    const end = Date.now() + 7000;
    let watched: any;
    while (Date.now() < end) {
      watched = await client.invoke("run", { project_id });
      if (watched.id !== beforeWatch.id && watched.status === "completed")
        break;
      await pause(100);
    }
    assert.notEqual(watched.id, beforeWatch.id);
    assert.equal(watched.status, "completed");
    await client.invoke("watch", { project_id, enabled: false });
    const pid = client.pid!;
    await client.stop();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const restarted = create();
    const persisted = await restarted.invoke("page", {
      project_id,
      slug: "overview",
    });
    assert.match(persisted.markdown, /Resolved human note/);
    assert.equal(
      (await restarted.invoke("project", { project_id })).watch,
      false,
    );
  },
);
test(
  "actual host-model broker enforces explicit consent, cancels in-flight work without overwrites, and retries",
  { timeout: process.platform === "win32" ? 60000 : 15000 },
  async (t) => {
    let blocked = false,
      started = false,
      aborted = false,
      invalid = false,
      calls = 0;
    const { client, repo } = await fixture(t, {
      modelCacheKey: "mock-main-model-v1",
      complete: async (input, signal) => {
        calls++;
        started = true;
        if (blocked)
          return new Promise<string>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("secret abort diagnostic"));
              },
              { once: true },
            ),
          );
        if (invalid) return "not JSON (private mock diagnostic)";
        const context = JSON.parse(input.user),
          first = context.files.find((file: any) => file.content.trim());
        return JSON.stringify({
          markdown: `# Mock contract page\n[Evidence](source:${first.path}#L1-L1)\n`,
          sources: [{ path: first.path, start_line: 1, end_line: 1 }],
        });
      },
    });
    const project = await client.invoke("create", { path: repo });
    const project_id = project.id;
    await client.invoke("generate", { project_id, provider: "demo" });
    await waitRun(client, project_id);
    const original = await client.invoke("page", {
      project_id,
      slug: "overview",
    });
    await assert.rejects(
      client.invoke("generate", { project_id, provider: "real" }),
      /confirmation/,
    );
    assert.equal(calls, 0);
    blocked = true;
    await client.invoke("generate", {
      project_id,
      provider: "real",
      confirm_external: true,
      force: true,
    });
    const end = Date.now() + 2000;
    while (!started && Date.now() < end) await pause(10);
    assert.equal(started, true);
    await assert.rejects(
      client.invoke("generate", { project_id, provider: "demo" }),
      /running|active|in progress/i,
    );
    await client.invoke("cancel", { project_id });
    const canceled = await waitRun(client, project_id);
    assert.equal(canceled.status, "canceled");
    assert.equal(aborted, true);
    const after = await client.invoke("page", { project_id, slug: "overview" });
    assert.equal(after.revision, original.revision);
    assert.equal(after.markdown, original.markdown);
    blocked = false;
    const retry = await client.invoke("generate", {
      project_id,
      provider: "real",
      confirm_external: true,
      force: true,
    });
    const completed = await waitRun(client, project_id, retry.run_id);
    assert.equal(completed.status, "completed");
    const good = await client.invoke("page", { project_id, slug: "overview" });
    assert.match(good.markdown, /Mock contract/);
    assert.ok(good.sources[0]?.hash);
    invalid = true;
    await client.invoke("generate", {
      project_id,
      provider: "real",
      confirm_external: true,
      force: true,
    });
    const failed = await waitRun(client, project_id);
    assert.equal(failed.status, "failed");
    assert.ok(!JSON.stringify(failed).includes("private mock diagnostic"));
    const unchanged = await client.invoke("page", {
      project_id,
      slug: "overview",
    });
    assert.equal(unchanged.revision, good.revision);
    assert.equal(unchanged.markdown, good.markdown);
  },
);
test(
  "actual child crash aborts host work, bounded restart marks persisted run interrupted and preserves committed pages",
  { timeout: process.platform === "win32" ? 60000 : 15000 },
  async (t) => {
    let started = false,
      aborted = false;
    const { client, repo } = await fixture(t, {
      maxRestarts: 1,
      restartDelayMs: 20,
      modelCacheKey: "crash-mock-v1",
      complete: async (_input, signal) =>
        new Promise<string>((_resolve, reject) => {
          started = true;
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("crash canceled provider"));
            },
            { once: true },
          );
        }),
    });
    const project = await client.invoke("create", { path: repo });
    const project_id = project.id;
    await client.invoke("generate", { project_id, provider: "demo" });
    await waitRun(client, project_id);
    const original = await client.invoke("page", {
      project_id,
      slug: "overview",
    });
    await client.invoke("generate", {
      project_id,
      provider: "real",
      confirm_external: true,
      force: true,
    });
    let end = Date.now() + 2500;
    while (!started && Date.now() < end) await pause(10);
    assert.equal(started, true);
    const oldPid = client.pid!;
    process.kill(oldPid, "SIGKILL");
    end = Date.now() + 4000;
    while ((!client.pid || client.pid === oldPid) && Date.now() < end)
      await pause(20);
    assert.ok(client.pid && client.pid !== oldPid);
    assert.equal(aborted, true);
    const recovered = await client.invoke("run", { project_id });
    assert.equal(recovered.status, "interrupted");
    assert.match(recovered.message ?? "", /restarted|interrupted/i);
    const preserved = await client.invoke("page", {
      project_id,
      slug: "overview",
    });
    assert.equal(preserved.revision, original.revision);
    assert.equal(preserved.markdown, original.markdown);
    assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
    const newPid = client.pid!;
    await client.stop();
    assert.throws(() => process.kill(newPid, 0), { code: "ESRCH" });
  },
);

test("hard-killed generation resumes its stable task without repeating completed model pages", { timeout: process.platform === "win32" ? 60000 : 15000 }, async (t) => {
  const calls: string[] = [];
  let blocked = true;
  const { client, repo } = await fixture(t, {
    maxRestarts: 1, restartDelayMs: 20, modelCacheKey: "durable-task-model-v1",
    complete: async (input, signal) => {
      const context = JSON.parse(input.user);
      calls.push(context.page_id);
      if (context.page_id === "usage" && blocked) await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("child exited")), { once: true });
      });
      const file = context.files.find((entry: any) => entry.content.trim());
      return JSON.stringify({ markdown: `# ${context.title}\n[Evidence](source:${file.path}#L1-L1)\n`, sources: [{ path: file.path, start_line: 1, end_line: 1 }] });
    },
  });
  const project = await client.invoke("create", { path: repo });
  const request = { project_id: project.id, provider: "real" as const, confirm_external: true, force: true, resume_run_id: "persistent-host-task" };
  await client.invoke("generate", request);
  let deadline = Date.now() + 4000;
  while (!calls.includes("usage") && Date.now() < deadline) await pause(10);
  assert.deepEqual(calls, ["overview", "usage"]);
  blocked = false;
  const oldPid = client.pid!;
  process.kill(oldPid, "SIGKILL");
  deadline = Date.now() + 5000;
  while ((!client.pid || client.pid === oldPid) && Date.now() < deadline) await pause(20);
  assert.ok(client.pid && client.pid !== oldPid);
  assert.equal((await client.invoke("run", { project_id: project.id })).status, "interrupted");
  assert.equal((await client.invoke("generate", request)).run_id, "persistent-host-task");
  const completed = await waitRun(client, project.id, "persistent-host-task");
  assert.equal(completed.status, "completed");
  assert.equal((completed.result as any).resumed, 1);
  assert.deepEqual(calls, ["overview", "usage", "usage"]);
  const page = await client.invoke("page", { project_id: project.id, slug: "overview" });
  assert.equal((await client.invoke("generate", request)).status, "completed");
  assert.equal((await client.invoke("page", { project_id: project.id, slug: "overview" })).revision, page.revision);
  assert.deepEqual(calls, ["overview", "usage", "usage"]);
});

test("late request cancellation after queued response still stops that generation", { timeout: 15000 }, async t => {
  let started = false, aborted = false;
  const { client, repo } = await fixture(t, {
    modelCacheKey: "late-cancel-fixture",
    complete: async (_input, signal) => new Promise<string>((_resolve, reject) => {
      started = true;
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("canceled")); }, { once: true });
    }),
  });
  const project = await client.invoke("create", { path: repo });
  const send = (client as any).send.bind(client);
  let submissionId = "";
  (client as any).send = (message: any, ...args: any[]) => { if (message.type === "request" && message.action === "generate") submissionId = message.id; return send(message, ...args); };
  const queued = await client.invoke("generate", { project_id: project.id, provider: "real", confirm_external: true });
  const deadline = Date.now() + 3000;
  while (!started && Date.now() < deadline) await pause(10);
  assert.equal(started, true);
  send({ v: 1, type: "cancelRequest", id: submissionId });
  const run = await waitRun(client, project.id, queued.run_id, 3000);
  assert.equal(run.status, "canceled"); assert.equal(aborted, true);
});

test("actual child pins scoped model cache identities and progress without restarting across contexts", { timeout: 15000 }, async t => {
  const { client, repo } = await fixture(t);
  let callsA = 0, callsB = 0;
  const complete = (name: string) => async (input: any) => {
    if (name === "A") callsA++; else callsB++;
    const context = JSON.parse(input.user), first = context.files.find((file: any) => file.content.trim());
    return JSON.stringify({ markdown: `# Model ${name}\n[Evidence](source:${first.path}#L1-L1)\n`, sources: [{ path: first.path, start_line: 1, end_line: 1 }] });
  };
  client.registerModelLease("lease-a", { cacheKey: "scoped-model-a", complete: complete("A") });
  client.registerModelLease("lease-b", { cacheKey: "scoped-model-b", complete: complete("B") });
  const project = await client.invokeScoped("create", { path: repo }, { contextId: "context-a" });
  const pid = client.pid, events: any[] = []; client.subscribe(event => events.push(event));
  const runA = await client.invokeScoped("generate", { project_id: project.id, provider: "real", confirm_external: true }, { contextId: "context-a", modelLeaseId: "lease-a" });
  assert.equal((await waitRun(client, project.id, runA.run_id)).status, "completed");
  const runB = await client.invokeScoped("generate", { project_id: project.id, provider: "real", confirm_external: true }, { contextId: "context-b", modelLeaseId: "lease-b" });
  assert.equal((await waitRun(client, project.id, runB.run_id)).status, "completed");
  assert.ok(callsA > 0 && callsB > 0, "a model change must not reuse another lease's cached output");
  assert.equal(client.pid, pid);
  assert.ok(events.some(event => event.run.id === runA.run_id));
  assert.ok(events.filter(event => event.run.id === runA.run_id).every(event => event.context_id === "context-a"));
  assert.ok(events.filter(event => event.run.id === runB.run_id).every(event => event.context_id === "context-b"));
});
