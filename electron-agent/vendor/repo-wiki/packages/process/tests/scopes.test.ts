import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RepoWikiProcessClient } from "../src/client.js";

const fixture = `const send=m=>process.send?.({v:1,...m});send({type:'ready',pid:process.pid});
const waiting=new Map();process.on('message',m=>{
if(m.type==='request'&&m.action==='shutdown'){send({type:'response',id:m.id,ok:true,result:{}});setTimeout(()=>process.exit(0),5);return;}
if(m.type==='request'){if(m.action==='health'){send({type:'response',id:m.id,ok:true,result:{pid:process.pid,scope:m.scope}});return;}waiting.set(m.id,m);send({type:'modelRequest',id:m.id,input:{systemPrompt:'test',user:'local'},scope:m.scope});}
if(m.type==='modelResponse'){const request=waiting.get(m.id);if(request)send({type:'response',id:m.id,ok:true,result:{ok:m.ok,text:m.text}});}
if(m.type==='cancelContext'){send({type:'response',id:m.id,ok:true,result:{canceled:true}});}
});process.on('disconnect',()=>process.exit(0));`;
async function clientFixture(t: any) {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-lease-test-"));
  const entry = path.join(root, "child.mjs"); await writeFile(entry, fixture);
  const client = new RepoWikiProcessClient({ entry, dataDir: root, maxRestarts: 0, requestTimeoutMs: 2000, stopTimeoutMs: 100 });
  t.after(async () => { await client.stop(); await rm(root, { recursive: true, force: true }); });
  return client;
}
test("scoped requests pin each registered model identity and keep one OS child across contexts", async t => {
  const client = await clientFixture(t);
  client.registerModelLease("lease-a", { cacheKey: "model-a", complete: async () => "a" });
  client.registerModelLease("lease-b", { cacheKey: "model-b", complete: async () => "b" });
  const a: any = await client.invokeScoped("health", {}, { contextId: "a", modelLeaseId: "lease-a" });
  const b: any = await client.invokeScoped("health", {}, { contextId: "b", modelLeaseId: "lease-b" });
  assert.equal(a.pid, b.pid); assert.equal(a.scope.modelCacheKey, "model-a"); assert.equal(b.scope.modelCacheKey, "model-b");
  const results = await Promise.all([client.invokeScoped("project", { project_id: "fixture" }, { contextId: "a", modelLeaseId: "lease-a" }), client.invokeScoped("project", { project_id: "fixture" }, { contextId: "b", modelLeaseId: "lease-b" })]);
  assert.deepEqual(results.map((v: any) => v.text), ["a", "b"]);
});
test("cancelContext aborts host calls synchronously and rejects late work from that context", async t => {
  const client = await clientFixture(t); let started = false, aborted = false;
  client.registerModelLease("lease", { cacheKey: "fixed", complete: async (_input, signal) => new Promise<string>((_resolve, reject) => { started = true; signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }) });
  const pending = client.invokeScoped("project", { project_id: "fixture" }, { contextId: "old", modelLeaseId: "lease" }).catch(error => error);
  while (!started) await delay(5);
  const canceled = client.cancelContext("old");
  assert.equal(aborted, true);
  await canceled; await pending;
  await assert.rejects(client.invokeScoped("health", {}, { contextId: "old" }), /cancel|retired/i);
  assert.ok(client.pid);
});
