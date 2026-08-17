import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  localSourceFetcherSource,
  patchCoreStdinShutdown,
  patchKnowledgeMcpHttpClient,
  patchKnowledgeMcpServer,
  patchKnowledgeSourceRegistry,
  patchKnowledgeStdinShutdown,
} from "./tencentdb-runtime-patches.mjs";
import * as runtimePatches from "./tencentdb-runtime-patches.mjs";

test("MCP patch adds tenant header and locks calls to current asset defaults", () => {
  const client = patchKnowledgeMcpHttpClient(`
export interface HttpClientOptions {
  baseUrl: string;
  /** Optional bearer token for auth. */
  token?: string;
}
  if (opts.token) headers["Authorization"] = \`Bearer \${opts.token}\`;
`);
  assert.match(client, /x-tdai-service-id/);
  assert.match(client, /x-tdai-user-key/);
  assert.match(client, /userKey\?: string/);
  assert.match(client, /serviceId\?: string/);

  const server = patchKnowledgeMcpServer(`
export function createMcpServer(httpOpts: HttpClientOptions): Server {
        inputSchema: t.inputSchema,
    const body = (args ?? {}) as Record<string, unknown>;
  const token = process.env.KNOWLEDGE_API_TOKEN;
  const server = createMcpServer({ baseUrl, token });
}`);
  assert.match(server, /defaultCodeGraphId/);
  assert.match(server, /defaultWikiId/);
  assert.match(server, /KNOWLEDGE_SERVICE_ID/);
  assert.match(server, /KNOWLEDGE_USER_KEY/);
  assert.match(server, /userKey/);
  assert.match(server, /schemaWithAssetDefault/);
  assert.match(server, /if \(field && fallback\) body\[field\] = fallback;/);
  assert.doesNotMatch(server, /typeof body\[field\]/);
});

test("source registry only recognizes explicit local absolute paths", () => {
  const registry = patchKnowledgeSourceRegistry(`
import { GitSourceFetcher } from "./git-fetcher.js";
    this.register(new GitSourceFetcher());
    // 未来：this.register(new LocalSourceFetcher());
    if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("./")) {
      return "local";
    }
`);
  assert.match(registry, /LocalSourceFetcher/);
  assert.match(registry, /\^\[A-Za-z\]/);
  assert.doesNotMatch(registry, /url\.startsWith\("\.\/"\)/);
  assert.doesNotMatch(registry, /url\.startsWith\("\\\\\\\\"\)/);
});

test("local fetcher re-reads the canonical JSONL allow-list for every fetch", () => {
  assert.match(localSourceFetcherSource, /supportedType[^=]*= "local"/);
  assert.match(localSourceFetcherSource, /TDAI_LOCAL_SOURCE_ALLOWLIST/);
  assert.match(localSourceFetcherSource, /await readAllowedSources\(\)/);
  assert.match(localSourceFetcherSource, /JSON\.parse/);
  assert.match(localSourceFetcherSource, /typeof entry !== "string"/);
  assert.match(localSourceFetcherSource, /allowedSources\.has\(sourcePath\)/);
  assert.match(localSourceFetcherSource, /local source is not allow-listed/);
});

test("local fetcher rejects network paths and skips links and generated directories", () => {
  assert.match(localSourceFetcherSource, /local source must not be a network path/);
  assert.doesNotMatch(localSourceFetcherSource, /return resolve\(sourceUrl\)/);
  assert.match(localSourceFetcherSource, /lstat/);
  assert.match(localSourceFetcherSource, /isSymbolicLink\(\)/);
  assert.match(localSourceFetcherSource, /canonicalDestination/);
  assert.match(localSourceFetcherSource, /node_modules/);
  assert.match(localSourceFetcherSource, /\.git/);
});

test("Wiki containment patch uses the platform separator and fails fast", () => {
  assert.equal(typeof runtimePatches.patchKnowledgeWikiWindowsContainment, "function");
  const fixture = `
import { join, resolve, normalize } from "node:path";
    const dirWithSep = base.endsWith("/") ? base : base + "/";
    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
`;
  const patched = runtimePatches.patchKnowledgeWikiWindowsContainment(fixture);
  assert.match(patched, /import \{ join, resolve, normalize, sep \} from "node:path";/);
  assert.match(patched, /base\.endsWith\(sep\) \? base : base \+ sep/);
  assert.match(patched, /wikiDir\.endsWith\(sep\) \? wikiDir : wikiDir \+ sep/);
  assert.doesNotMatch(patched, /endsWith\("\/"\)/);
  assert.throws(
    () => runtimePatches.patchKnowledgeWikiWindowsContainment(fixture.replace("const prefix", "const missing")),
    /unexpected TencentDB upstream layout/,
  );
});

test("managed runtime entries shut down once when their stdin pipe closes", () => {
  const core = patchCoreStdinShutdown(`
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
`);
  assert.match(core, /process\.stdin\.once\("end", shutdownOnStdinClose\)/);
  assert.match(core, /process\.stdin\.once\("close", shutdownOnStdinClose\)/);
  assert.match(core, /if \(stdinShutdownRequested\) return/);
  assert.match(core, /void shutdown\("SIGTERM"\)/);
  assert.match(core, /managed runtime stdin closed/);

  const knowledge = patchKnowledgeStdinShutdown(`
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
`);
  assert.match(knowledge, /process\.stdin\.once\("end", shutdownOnStdinClose\)/);
  assert.match(knowledge, /process\.stdin\.once\("close", shutdownOnStdinClose\)/);
  assert.match(knowledge, /if \(stdinShutdownRequested\) return/);
  assert.match(knowledge, /void shutdown\("stdin EOF"\)/);
  assert.match(knowledge, /managed runtime stdin closed/);
});

test("Knowledge API auth patch protects the v3 routes", () => {
  assert.equal(typeof runtimePatches.patchKnowledgeApiAuth, "function");
  const patched = runtimePatches.patchKnowledgeApiAuth(`
import { Hono } from "hono";
import { accessLog } from "./middleware/response-envelope.js";
export function createApp() {
  const api = new Hono();
}
`);
  assert.match(patched, /KNOWLEDGE_API_TOKEN is required/);
  assert.match(patched, /timingSafeEqual/);
  assert.match(patched, /api\.use\("\*", knowledgeApiAuth\(\)\)/);
  assert.match(patched, /wrapError\(401, "unauthorized"\)/);
});

test("Core bootstrap patch preserves the configured user, team, and agent IDs", () => {
  assert.equal(typeof runtimePatches.patchCoreManagedIdentityBootstrap, "function");
  const patched = runtimePatches.patchCoreManagedIdentityBootstrap({
    schema: `export const initAdminSchema = z.object({
  username: nonEmpty,
  user_key: z.string().min(1).optional(),
});`,
    types: `export interface InitAdminInput {
  username: string;
  user_key?: string;
}`,
    service: `    const created = await this.createUserWithType(
      { username: input.username, default_key_value: input.user_key },
      "system_admin",
    );
      const team = await this.createTeam({
        name: DEFAULT_TEAM_NAME,
        description: DEFAULT_TEAM_DESCRIPTION,
        owner_user_id: created.user_id,
      });
        await this.createAgent({
          team_id: team.team_id,
          owner_user_id: created.user_id,`,
  });
  assert.match(patched.schema, /user_id: z\.string\(\)\.min\(1\)\.optional\(\)/);
  assert.match(patched.schema, /team_id: z\.string\(\)\.min\(1\)\.optional\(\)/);
  assert.match(patched.schema, /agent_id: z\.string\(\)\.min\(1\)\.optional\(\)/);
  assert.match(patched.types, /user_id\?: string/);
  assert.match(patched.service, /user_id: input\.user_id/);
  assert.match(patched.service, /team_id: input\.team_id/);
  assert.match(patched.service, /agent_id: input\.agent_id/);
});

async function executePatchedStdinFixture(source) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "grenagent-stdin-fixture-"));
  const fixturePath = join(fixtureDir, "fixture.mjs");
  writeFileSync(fixturePath, source);
  const child = spawn(process.execPath, [fixturePath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    child.stdin.end();
    const { code, signal } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("patched stdin fixture did not exit"));
      }, 3000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    return stdout;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("patched Core and Knowledge entries execute shutdown exactly once on stdin EOF", async () => {
  const shutdown = `
let shutdownCalls = 0;
const shutdown = async () => {
  shutdownCalls += 1;
  setTimeout(() => process.exit(shutdownCalls === 1 ? 0 : 2), 25);
};`;
  const core = patchCoreStdinShutdown(`
${shutdown}
async function main() {
  const gateway = { start: async () => {} };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}
process.on("exit", () => console.log(\`shutdown-calls=\${shutdownCalls}\`));
void main();
`);
  const knowledge = patchKnowledgeStdinShutdown(`
${shutdown}
async function main() {
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
process.on("exit", () => console.log(\`shutdown-calls=\${shutdownCalls}\`));
void main();
`);

  for (const [name, source] of [["Core", core], ["Knowledge", knowledge]]) {
    const stdout = await executePatchedStdinFixture(source);
    assert.equal(stdout.match(/managed runtime stdin closed/g)?.length, 1, name);
    assert.match(stdout, /shutdown-calls=1/, name);
  }
});

test("build script applies and verifies every runtime security patch", () => {
  const buildScript = readFileSync(join(import.meta.dirname, "build-tencentdb-memory.mjs"), "utf8");
  assert.match(buildScript, /patchCoreStdinShutdown/);
  assert.match(buildScript, /patchKnowledgeApiAuth/);
  assert.match(buildScript, /upstreamSourceSha256/);
  assert.match(buildScript, /createHash\("sha256"\)/);
  assert.match(buildScript, /SHA-256 mismatch/);
  assert.match(buildScript, /nodeAsset: \{ filename: nodeRuntime\.filename, sha256: nodeRuntime\.sha256 \}/);
  assert.match(buildScript, /manifest\.upstream\?\.owner !== upstream\.owner/);
  assert.match(buildScript, /manifest\.upstream\?\.repo !== upstream\.repo/);
  assert.match(buildScript, /manifest\.upstream\?\.commit !== upstream\.commit/);
  assert.match(buildScript, /patchKnowledgeStdinShutdown/);
  assert.match(buildScript, /patchKnowledgeWikiWindowsContainment/);
  assert.match(buildScript, /TDAI_LOCAL_SOURCE_ALLOWLIST/);
  assert.match(buildScript, /isSymbolicLink/);
  assert.match(buildScript, /base\.endsWith\(sep\)/);
  assert.match(buildScript, /const knowledgeBundle = await readFile/);
  assert.match(buildScript, /TencentDB runtime Knowledge bundle is missing marker/);
  assert.match(buildScript, /managed runtime stdin closed/);
  assert.match(buildScript, /knowledgeApiAuth/);
  assert.match(buildScript, /process\.stdin\.once\(\\?"end/);
  assert.match(buildScript, /process\.stdin\.once\(\\?"close/);
  assert.match(buildScript, /--legacy-peer-deps/);
});

const generatedPlatform = process.platform === "win32"
  ? `windows-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
  : process.platform === "darwin"
    ? `darwin-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
    : `linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const generatedRuntime = join(
  import.meta.dirname,
  "..",
  "src-tauri",
  "binaries",
  "tencentdb-memory",
  generatedPlatform,
);
const generatedSource = join(
  generatedRuntime,
  "knowledge",
  "src",
);

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHttp(url) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Knowledge HTTP server did not become healthy");
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Knowledge HTTP server did not exit")), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("bundled Knowledge HTTP server enforces bearer auth on v3 routes", {
  skip: !existsSync(join(generatedRuntime, "knowledge", "bin", "server.mjs")),
}, async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "grenagent-knowledge-auth-"));
  const port = await reserveLoopbackPort();
  const token = "knowledge-auth-probe";
  const node = join(generatedRuntime, "node", process.platform === "win32" ? "node.exe" : "bin/node");
  const knowledgeDir = join(generatedRuntime, "knowledge");
  const child = spawn(node, [join(knowledgeDir, "bin", "server.mjs")], {
    cwd: knowledgeDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      KNOWLEDGE_DATA_DIR: fixtureDir,
      KNOWLEDGE_DB_PATH: join(fixtureDir, "knowledge.db"),
      KNOWLEDGE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}/v3`,
      KNOWLEDGE_API_TOKEN: token,
      LLM_MODE: "custom",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });

  const list = (authorization) => fetch(`http://127.0.0.1:${port}/v3/wiki/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": "personal-memory",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ team_id: "personal-local", limit: 1, offset: 0 }),
  });

  try {
    assert.equal((await waitForHttp(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await list()).status, 401, stderr);
    assert.equal((await list("Bearer wrong-token")).status, 401, stderr);
    assert.equal((await list(`Bearer ${token}`)).status, 200, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    try {
      await waitForChildExit(child, 10_000);
    } catch {
      child.kill();
      await waitForChildExit(child, 5_000);
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("the pinned generated source is patched or still matches each patch input", {
  skip: !existsSync(generatedSource),
}, () => {
  const patchedOrPatchable = (source, marker, patch) => source.includes(marker) ? source : patch(source);
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "mcp", "http-client.ts"), "utf8"),
      "x-tdai-user-key",
      patchKnowledgeMcpHttpClient,
    ),
    /x-tdai-user-key/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "mcp", "server.ts"), "utf8"),
      "KNOWLEDGE_USER_KEY",
      patchKnowledgeMcpServer,
    ),
    /KNOWLEDGE_USER_KEY/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "source-fetcher", "registry.ts"), "utf8"),
      "LocalSourceFetcher",
      patchKnowledgeSourceRegistry,
    ),
    /LocalSourceFetcher/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "store", "wiki-service.ts"), "utf8"),
      "base.endsWith(sep)",
      runtimePatches.patchKnowledgeWikiWindowsContainment,
    ),
    /base\.endsWith\(sep\)/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "..", "..", "core", "src", "gateway", "server.ts"), "utf8"),
      "managed runtime stdin closed",
      patchCoreStdinShutdown,
    ),
    /process\.stdin\.once\("end", shutdownOnStdinClose\)/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "server.ts"), "utf8"),
      "managed runtime stdin closed",
      patchKnowledgeStdinShutdown,
    ),
    /process\.stdin\.once\("close", shutdownOnStdinClose\)/,
  );
  assert.match(
    patchedOrPatchable(
      readFileSync(join(generatedSource, "server.ts"), "utf8"),
      "knowledgeApiAuth",
      runtimePatches.patchKnowledgeApiAuth,
    ),
    /api\.use\("\*", knowledgeApiAuth\(\)\)/,
  );
});
