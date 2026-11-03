import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { unzipSync, strFromU8 } from "fflate";
import { createHttpServer } from "../src/http.js";
import {
  ContractError,
  type RepoWikiClient,
} from "../../contracts/src/index.js";
type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};
async function fixture(
  t: { after: (fn: () => Promise<void> | void) => void },
  invoke: (action: string, input: any) => any = () => ({ status: "ok" }),
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-http-")),
    staticDir = path.join(base, "static");
  fs.mkdirSync(staticDir);
  fs.writeFileSync(
    path.join(staticDir, "index.html"),
    "<!doctype html><h1>RepoWiki</h1>",
  );
  fs.writeFileSync(path.join(staticDir, "app.js"), "export const safe = true;");
  fs.writeFileSync(path.join(base, "outside.txt"), "PRIVATE-OUTSIDE");
  fs.symlinkSync(
    path.join(base, "outside.txt"),
    path.join(staticDir, "leak.txt"),
  );
  const calls: { action: string; input: any }[] = [];
  const client = {
    invoke: async (action: string, input: any) => {
      calls.push({ action, input });
      return invoke(action, input);
    },
    subscribe: () => () => {},
  } as RepoWikiClient;
  const server = createHttpServer(client, staticDir);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port,
    host = "127.0.0.1:" + port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const request = (
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
      chunked?: Buffer[];
      finishBody?: boolean;
    } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: url,
          method: options.method ?? "GET",
          headers: { Host: host, ...options.headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("error", reject);
          res.on("end", () => {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
            if (options.finishBody === false) req.destroy();
          });
        },
      );
      req.on("error", reject);
      if (options.chunked)
        for (const chunk of options.chunked) req.write(chunk);
      else if (options.body !== undefined) req.write(options.body);
      if (options.finishBody !== false) req.end();
    });
  return { request, host, calls, staticDir };
}
const mutation = {
  "X-RepoWiki-Request": "1",
  "Content-Type": "application/json",
};
test("HTTP preview routes to injected client, never exposes API cache or stack and sends hardening headers", async (t) => {
  const f = await fixture(t, (action) =>
    action === "project"
      ? Promise.reject(new ContractError("Unknown project", 404))
      : { status: "ok" },
  );
  const health = await f.request("/api/workspace/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.match(
    String(health.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );
  assert.equal(health.headers["referrer-policy"], "no-referrer");
  const missing = await f.request("/api/workspace/projects/nope");
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body.toString()).detail, "Unknown project");
  assert(!missing.body.includes("Error:"));
  assert.equal((await f.request("/api/not-real")).status, 404);
  assert.equal((await f.request("/api/workspace/not-real")).status, 404);
});
test("HTTP rejects non-loopback Host, cross-site requests and mismatched Origin", async (t) => {
  const f = await fixture(t);
  for (const host of [
    "evil.example",
    "127.0.0.1.evil.example",
    "user@localhost",
    "localhost/path",
    "localhost?bad",
    "localhost#bad",
  ])
    assert.equal(
      (await f.request("/api/workspace/health", { headers: { Host: host } }))
        .status,
      403,
      host,
    );
  for (const origin of [
    "https://evil.example",
    "null",
    "http://localhost:" + f.host.split(":")[1],
    "https://" + f.host,
    "http://user@" + f.host,
    "http://" + f.host + "/path",
  ])
    assert.equal(
      (
        await f.request("/api/workspace/health", {
          headers: { Origin: origin },
        })
      ).status,
      403,
      origin,
    );
  assert.equal(
    (
      await f.request("/api/workspace/health", {
        headers: { Origin: "http://" + f.host },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/workspace/health", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
});
test("HTTP mutations require non-simple CSRF header, JSON and bounded valid request contracts", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/workspace/projects", { method: "POST", body: "{}" }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/workspace/projects", {
        method: "POST",
        headers: { "X-RepoWiki-Request": "1", "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await f.request("/api/workspace/projects", {
        method: "POST",
        headers: mutation,
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/workspace/projects", {
        method: "POST",
        headers: mutation,
        body: JSON.stringify({ path: "/approved", extra: true }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/workspace/projects", {
        method: "POST",
        headers: mutation,
        body: JSON.stringify({ path: "/approved" }),
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await f.request("/api/workspace/projects/p/generate", {
        method: "POST",
        headers: mutation,
        body: "{}",
      })
    ).status,
    202,
  );
  assert.equal(
    (await f.request("/api/workspace/projects", { method: "OPTIONS" })).status,
    404,
  );
});
test("HTTP rejects oversized declared and chunked bodies with 413 before invoking child", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const declared = await f.request("/api/workspace/projects", {
    method: "POST",
    headers: { ...mutation, "Content-Length": String(8 * 1024 * 1024 + 1) },
  });
  assert.equal(declared.status, 413);
  assert.match(String(declared.headers["content-type"]), /application\/json/);
  assert.deepEqual(JSON.parse(declared.body.toString()), {
    detail: "Request exceeds 8 MiB",
  });
  const chunked = await f.request("/api/workspace/projects", {
    method: "POST",
    headers: mutation,
    chunked: Array.from({ length: 9 }, () => Buffer.alloc(1024 * 1024, 0x20)),
  });
  assert.equal(chunked.status, 413);
  assert.match(String(chunked.headers["content-type"]), /application\/json/);
  assert.deepEqual(JSON.parse(chunked.body.toString()), {
    detail: "Request exceeds 8 MiB",
  });
  const unfinished = await f.request("/api/workspace/projects", {
    method: "POST",
    headers: { ...mutation, Connection: "keep-alive" },
    chunked: Array.from({ length: 9 }, () => Buffer.alloc(1024 * 1024, 0x20)),
    finishBody: false,
  });
  assert.equal(unfinished.status, 413);
  assert.equal(unfinished.headers.connection, "close");
  assert.deepEqual(JSON.parse(unfinished.body.toString()), {
    detail: "Request exceeds 8 MiB",
  });
  assert.equal(f.calls.length, 0);
});
test("static app serves SPA and assets but rejects symlink escape and malformed paths", async (t) => {
  const f = await fixture(t);
  const index = await f.request("/");
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /RepoWiki/);
  assert.match(String(index.headers["content-type"]), /text\/html/);
  assert.equal((await f.request("/deep/route")).status, 200);
  assert.equal((await f.request("/missing.js")).status, 404);
  assert.equal((await f.request("/leak.txt")).status, 403);
  for (const request of ["/a%5Cb", "/%00", "/%ZZ"]) {
    const response = await f.request(request);
    assert(response.status >= 400);
    assert(!response.body.includes("PRIVATE-OUTSIDE"));
  }
  for (const request of [
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/%2e%2e%2foutside.txt",
  ])
    assert(!(await f.request(request)).body.includes("PRIVATE-OUTSIDE"));
  assert.equal((await f.request("/app.js", { method: "HEAD" })).body.length, 0);
  assert.equal((await f.request("/", { method: "POST" })).status, 405);
});
test("Markdown ZIP contains only relative valid filenames; invalid child output cannot become zip-slip", async (t) => {
  let unsafe = false;
  const f = await fixture(t, (action) =>
    action === "export"
      ? unsafe
        ? { "../escape.md": "bad" }
        : {
            "overview.md": "# Overview",
            ".repowiki-manifest.json": '{"version":1}',
            "modules/core.md": "# Core",
          }
      : {},
  );
  const response = await f.request("/api/workspace/projects/project/export");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.match(String(response.headers["content-disposition"]), /^attachment;/);
  const files = unzipSync(response.body);
  assert.equal(strFromU8(files["overview.md"]!), "# Overview");
  assert.equal(Object.keys(files).length, 3);
  unsafe = true;
  assert.equal(
    (await f.request("/api/workspace/projects/project/export")).status,
    400,
  );
});
test("unexpected transport exceptions do not leak provider keys or private response data", async (t) => {
  const f = await fixture(t, () => {
    throw new Error("Authorization: sk-secret, private response body");
  });
  const response = await f.request("/api/workspace/health");
  assert.equal(response.status, 500);
  assert(!response.body.includes("sk-secret"));
  assert(!response.body.includes("private response"));
});

test("HTTP card target reaches generation, status, changes, Markdown ZIP and import without becoming wiki", async (t) => {
  const f = await fixture(t, (action) => action === "export"
    ? {"cards/storage.md":"# Storage card\n[source](source:storage.ts#L1-L2)", ".repowiki-manifest.json":'{"target":"cards"}'}
    : action === "generate" ? {run_id:"card-run",status:"queued"} : {status:"ok"});
  const created=await f.request('/api/workspace/projects/project/generate',{method:'POST',headers:mutation,body:JSON.stringify({target:'cards',provider:'demo'})});
  assert.equal(created.status,202);
  assert.deepEqual(f.calls.at(-1),{action:'generate',input:{project_id:'project',target:'cards',provider:'demo'}});
  for(const [url,action] of [['changes','changes'],['runs/latest','run']] as const){
    assert.equal((await f.request(`/api/workspace/projects/project/${url}?target=cards`)).status,200);
    assert.deepEqual(f.calls.at(-1),{action,input:{project_id:'project',target:'cards'}});
  }
  const exported=await f.request('/api/workspace/projects/project/export?target=cards');
  assert.equal(exported.status,200);
  const documents=unzipSync(exported.body);
  assert.match(strFromU8(documents['cards/storage.md']!),/source:storage.ts#L1-L2/);
  assert.deepEqual(f.calls.at(-1),{action:'export',input:{project_id:'project',target:'cards'}});
  assert.equal((await f.request('/api/workspace/projects/project/import',{method:'POST',headers:mutation,body:JSON.stringify({target:'cards',files:{'cards/storage.md':'# Human card'}})})).status,200);
  assert.equal(f.calls.at(-1)?.input.target,'cards');
  assert.equal(f.calls.at(-1)?.input.files['cards/storage.md'],'# Human card');
  const count=f.calls.length;
  assert.equal((await f.request('/api/workspace/projects/project/changes?target=anything')).status,400);
  assert.equal(f.calls.length,count);
});
