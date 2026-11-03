import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepoWikiProcessClient } from "../src/client.js";
import { HostModelProvider } from "../src/host-provider.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 2500): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Condition did not become true");
    await pause(10);
  }
}
const fixture = `
const mode=process.env.TEST_MODE||'normal';
const send=x=>process.send?.({v:1,...x});
send({type:'ready',pid:process.pid});
if(mode==='crash-loop')setTimeout(()=>process.exit(42),25);
process.on('message',m=>{
 if(m.type==='request'&&m.action==='shutdown'){send({type:'response',id:m.id,ok:true,result:{stopped:true}});setTimeout(()=>process.exit(0),5);return;}
 if(m.type==='request'){
  if(mode==='pending-crash'){setTimeout(()=>process.exit(42),10);return;}
  if(mode==='hang')return;
  if(mode==='broker'||mode==='cancel-broker'||mode==='stop-broker'){
   globalThis.requestId=m.id;send({type:'modelRequest',id:'model-call',input:{systemPrompt:'system',user:'source-only',maxTokens:42}});
   if(mode==='cancel-broker')setTimeout(()=>{send({type:'modelCancel',id:'model-call'});send({type:'response',id:m.id,ok:true,result:{canceled:true}})},30);
   return;
  }
  send({type:'response',id:m.id,ok:true,result:{status:'ok',pid:process.pid,env:process.env.SENTINEL_HOST_SECRET||null}});
 }
 if(m.type==='modelResponse')send({type:'response',id:globalThis.requestId,ok:true,result:{model:m}});
});
process.on('disconnect',()=>process.exit(0));
`;
async function mockClient(
  t: any,
  mode = "normal",
  options: Partial<ConstructorParameters<typeof RepoWikiProcessClient>[0]> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-process-test-"));
  const entry = path.join(root, "child.mjs");
  await writeFile(entry, fixture);
  const client = new RepoWikiProcessClient({
    entry,
    dataDir: path.join(root, "data"),
    env: { TEST_MODE: mode },
    maxRestarts: 0,
    restartDelayMs: 10,
    requestTimeoutMs: 1000,
    stopTimeoutMs: 100,
    modelCacheKey: "test-model-only",
    ...options,
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  return client;
}
test("supervisor spawns a different OS PID, filters inherited environment, and stops cleanly", async (t) => {
  const original = process.env.SENTINEL_HOST_SECRET;
  process.env.SENTINEL_HOST_SECRET = "must-not-cross";
  t.after(() => {
    if (original === undefined) delete process.env.SENTINEL_HOST_SECRET;
    else process.env.SENTINEL_HOST_SECRET = original;
  });
  const client = await mockClient(t);
  const result: any = await client.invoke("health", {});
  assert.notEqual(result.pid, process.pid);
  assert.equal(result.pid, client.pid);
  assert.equal(result.env, null);
  const pid = client.pid!;
  await client.stop();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(client.invoke("health", {}), /stopped/);
});
test("invalid/unknown actions are rejected without launching a process", async (t) => {
  const client = await mockClient(t);
  await assert.rejects(
    client.invoke("shell" as any, {} as any),
    /Unknown command/,
  );
  await assert.rejects(
    client.invoke("create", { path: "/tmp", apiKey: "secret" } as any),
    /Unexpected/,
  );
  assert.equal(client.pid, undefined);
});

test("a retired physical child cannot emit progress or request models after supervisor recovery", async (t) => {
  let completions = 0;
  const client = await mockClient(t, "normal", { maxRestarts: 1, complete: async () => { completions++; return "local"; } });
  const events: unknown[] = [];
  client.subscribe((event) => events.push(event));
  await client.start();
  const old = (client as any).child;
  const oldPid = client.pid;
  old.kill();
  await until(() => client.pid !== undefined && client.pid !== oldPid);
  await client.start();
  old.emit("message", { v: 1, type: "event", event: { project_id: "old", run: { status: "running" }, time: "old" } });
  old.emit("message", { v: 1, type: "modelRequest", id: "late", input: { systemPrompt: "old", user: "old" } });
  await pause(20);
  assert.deepEqual(events, []);
  assert.equal(completions, 0);
  assert.equal((await client.invoke("health", {}) as any).status, "ok");
});
test("crash rejects pending requests, exhausts bounded restarts, and cannot implicitly restart", async (t) => {
  const pending = await mockClient(t, "pending-crash");
  await assert.rejects(pending.invoke("health", {}), /exited/);
  const client = await mockClient(t, "crash-loop", { maxRestarts: 1 });
  const states: string[] = [];
  client.onLifecycle((event) => states.push(event.status));
  await client.start();
  await until(() => states.includes("failed"));
  assert.equal(states.filter((status) => status === "ready").length, 2);
  await assert.rejects(
    client.invoke("health", {}),
    /exhausted|failed|stopped/i,
  );
  await pause(50);
  assert.equal(states.filter((status) => status === "ready").length, 2);
});
test("request timeout requests cancellation, stop terminates pending child", async (t) => {
  const client = await mockClient(t, "hang", { requestTimeoutMs: 30 });
  await assert.rejects(
    client.invoke("health", {}),
    /timed out.*cancellation was requested/,
  );
  const pid = client.pid!;
  await client.stop();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("host short-call contract passes bounded input and returns text through structured IPC", async (t) => {
  let seen: any;
  const client = await mockClient(t, "broker", {
    complete: async (input, signal) => {
      seen = { input, signal };
      return '{"markdown":"# Mock","sources":[]}';
    },
  });
  const result: any = await client.invoke("health", {});
  assert.deepEqual(seen.input, {
    systemPrompt: "system",
    user: "source-only",
    maxTokens: 42,
  });
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(result.model.ok, true);
  assert.match(result.model.text, /Mock/);
});
test("oversized or invalid host model result fails promptly, rather than silently hanging child", async (t) => {
  const client = await mockClient(t, "broker", {
    complete: async () => "x".repeat(2_000_001),
  });
  const result: any = await client.invoke("health", {});
  assert.equal(result.model.ok, false);
  assert.equal(result.model.text, undefined);
});
test("child cancellation and supervisor shutdown abort outstanding host completion", async (t) => {
  let canceled = false;
  const client = await mockClient(t, "cancel-broker", {
    complete: async (_input, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            canceled = true;
            reject(new Error("secret cancellation detail"));
          },
          { once: true },
        ),
      ),
  });
  const result: any = await client.invoke("health", {});
  assert.equal(result.canceled, true);
  await until(() => canceled);
  let started = false,
    stopped = false;
  const stopping = await mockClient(t, "stop-broker", {
    complete: async (_input, signal) =>
      new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(new Error("stop"));
          },
          { once: true },
        );
      }),
  });
  const pending = stopping.invoke("health", {}).catch((error) => error);
  await until(() => started);
  await stopping.stop();
  assert.equal(stopped, true);
  assert.ok((await pending) instanceof Error);
});
test("HostModelProvider JSON contract has bounded source prompt and safe failure", async () => {
  let input: any, passedSignal: AbortSignal | undefined;
  const host = new HostModelProvider(async (value, signal) => {
    input = value;
    passedSignal = signal;
    return '```json\n{"markdown":"# Grounded","sources":[{"path":"a.ts","start_line":1,"end_line":1}]}\n```';
  }, "model-v1");
  const abort = new AbortController();
  const result = await host.generate_page(
    { files: [{ path: "a.ts", content: "export const a=1;" }], language: "zh" },
    { signal: abort.signal },
  );
  assert.equal(result.markdown, "# Grounded");
  assert.match(input.systemPrompt, /untrusted/);
  assert.equal(passedSignal, abort.signal);
  assert.notEqual(
    host.cache_key,
    new HostModelProvider(async () => "", "model-v2").cache_key,
  );
  await assert.rejects(
    new HostModelProvider(
      async () => "secret invalid body",
      "model",
    ).generate_page({}),
    /invalid page JSON/,
  );
  await assert.rejects(
    host.generate_page({ goal: "x".repeat(600_001) }),
    /budget/,
  );
});
test("Electron-main import closure contains no core engine, service, scanner, or SQLite", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const seen = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(
      !file.includes(`${path.sep}core${path.sep}`) &&
        !file.includes(`${path.sep}service${path.sep}`),
      `main imported heavy module: ${file}`,
    );
    const code = await readFile(file, "utf8");
    assert.ok(!/from\s+['"]node:sqlite['"]/.test(code), "main imported SQLite");
    for (const match of code.matchAll(
      /(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    ))
      if (match[1]!.startsWith("."))
        await visit(
          path.resolve(path.dirname(file), /\.[cm]?[jt]s$/.test(match[1]!) ? match[1]!.replace(/\.js$/, ".ts") : `${match[1]}.ts`),
        );
  }
  await visit(path.join(root, "packages/electron/src/index.ts"));
  await visit(path.join(root, "packages/process/src/client.ts"));
});
