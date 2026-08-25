import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import {
  localSourceFetcherSource,
  patchCoreManagedIdentityBootstrap,
  patchCoreStdinShutdown,
  patchKnowledgeApiAuth,
  patchKnowledgeMcpHttpClient,
  patchKnowledgeMcpServer,
  patchKnowledgeSourceRegistry,
  patchKnowledgeStdinShutdown,
  patchKnowledgeWikiWindowsContainment,
  patchPanelBootstrapRoutes,
  patchPanelInstanceRegistry,
  patchPanelMetaLogRedaction,
  patchPanelPortFile,
  patchPanelStdinShutdown,
} from "./tencentdb-runtime-patches.mjs";

const upstream = {
  owner: "TencentCloud",
  repo: "TencentDB-Agent-Memory",
  commit: "97f94654280b2932c35ba4806a491999ed244cc9",
};
const nodeVersion = "22.19.0";
const upstreamSourceSha256 = "8c8785d384cf10e6feb92b93f4ffe03e5890dd6fbaf37f512fef0e3bb87be9f0";
const appRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(appRoot, "src-tauri", "binaries", "tencentdb-memory", platformDir());

if (process.argv.includes("--verify")) {
  await verifyLayout(outputRoot);
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "grenagent-tencentdb-"));
try {
  const archive = join(workspace, "source.tar.gz");
  const sourceRoot = join(workspace, "source");
  await download(
    `https://codeload.github.com/${upstream.owner}/${upstream.repo}/tar.gz/${upstream.commit}`,
    archive,
    upstreamSourceSha256,
  );
  await mkdir(sourceRoot, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", sourceRoot, "--strip-components=1"], { stdio: "inherit" });

  const nodeRuntime = nodeAsset();
  const nodeRoot = await downloadNodeRuntime(workspace, nodeRuntime);
  const node = nodeExecutable(nodeRoot);
  const npm = npmCli(nodeRoot);
  const core = join(sourceRoot, "MemoryCore");
  const knowledge = join(sourceRoot, "MemoryKnowledge");
  const panel = join(sourceRoot, "MemoryPanel");
  await disableCoreOpenclawPostinstall(core);
  await patchCoreRuntime(core);
  await pinKnowledgeLoopback(knowledge);
  await fixKnowledgeMainGuards(knowledge);
  await patchKnowledgeRuntime(knowledge);
  await patchPanelRuntime(panel);
  installAndBuild(core, false, node, npm);
  installAndBuild(knowledge, true, node, npm);
  installAndBuild(panel, true, node, npm);
  installAndBuild(join(panel, "web"), true, node, npm, false);
  await alignKnowledgeLaunchers(knowledge);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(core, join(outputRoot, "core"), { recursive: true, filter: runtimeFile });
  await cp(knowledge, join(outputRoot, "knowledge"), { recursive: true, filter: runtimeFile });
  await mkdir(join(outputRoot, "panel"), { recursive: true });
  await cp(join(panel, "dist"), join(outputRoot, "panel", "dist"), { recursive: true });
  await cp(join(panel, "node_modules"), join(outputRoot, "panel", "node_modules"), { recursive: true });
  await cp(join(panel, "package.json"), join(outputRoot, "panel", "package.json"));
  await cp(join(panel, "web", "dist"), join(outputRoot, "panel", "web", "dist"), { recursive: true });
  await cp(join(panel, "web", "public"), join(outputRoot, "panel", "web", "public"), { recursive: true });
  await cp(nodeRoot, join(outputRoot, "node"), { recursive: true });
  await writeFile(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify(
      {
        upstream,
        upstreamSourceSha256,
        nodeVersion,
        nodeAsset: { filename: nodeRuntime.filename, sha256: nodeRuntime.sha256 },
        panel: {
          backendEntry: "panel/dist/index.js",
          webEntry: "panel/web/dist/index.html",
          bootstrapProtocol: "v1",
        },
      },
      null,
      2,
    )}\n`,
  );
  await verifyLayout(outputRoot);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function installAndBuild(dir, needsBuild, node, npm, legacyPeerDeps = true) {
  const env = {
    ...process.env,
    PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
  };
  // npm 10 crashes while resolving Vitest's optional peer graph in this pinned upstream tree.
  const peerArgs = legacyPeerDeps ? ["--legacy-peer-deps"] : [];
  const installArgs = needsBuild
    ? [npm, "install", ...peerArgs]
    : [npm, "install", "--omit=dev", ...peerArgs];
  execFileSync(node, installArgs, { cwd: dir, env, stdio: "inherit" });
  if (needsBuild) {
    execFileSync(node, [npm, "run", "build"], { cwd: dir, env, stdio: "inherit" });
    execFileSync(node, [npm, "prune", "--omit=dev", ...peerArgs], { cwd: dir, env, stdio: "inherit" });
  }
}

async function disableCoreOpenclawPostinstall(coreDir) {
  const packagePath = join(coreDir, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  delete packageJson.scripts?.postinstall;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function patchCoreRuntime(coreDir) {
  const serverPath = join(coreDir, "src", "gateway", "server.ts");
  await writeFile(serverPath, patchCoreStdinShutdown(await readFile(serverPath, "utf8")));
  const schemaPath = join(coreDir, "src", "metadata", "router", "v3-meta-schemas.ts");
  const typesPath = join(coreDir, "src", "metadata", "types.ts");
  const servicePath = join(coreDir, "src", "metadata", "service", "metadata-service.ts");
  const identity = patchCoreManagedIdentityBootstrap({
    schema: await readFile(schemaPath, "utf8"),
    types: await readFile(typesPath, "utf8"),
    service: await readFile(servicePath, "utf8"),
  });
  await writeFile(schemaPath, identity.schema);
  await writeFile(typesPath, identity.types);
  await writeFile(servicePath, identity.service);
}

async function pinKnowledgeLoopback(knowledgeDir) {
  const serverPath = join(knowledgeDir, "src", "server.ts");
  const source = await readFile(serverPath, "utf8");
  const needle = "serve({ fetch: app.fetch, port: config.port }";
  const patched = source.replace(needle, 'serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }');
  if (patched === source) throw new Error(`unexpected Knowledge server layout: ${serverPath}`);
  await writeFile(serverPath, patched);
}

async function fixKnowledgeMainGuards(knowledgeDir) {
  const serverPath = join(knowledgeDir, "src", "server.ts");
  const server = await readFile(serverPath, "utf8");
  const serverPathImport = 'import { dirname, join } from "node:path";';
  const serverGuard = 'import.meta.url === `file://${process.argv[1]}`';
  if (!server.includes(serverPathImport) || !server.includes(serverGuard)) {
    throw new Error(`unexpected Knowledge HTTP main guard: ${serverPath}`);
  }
  await writeFile(
    serverPath,
    server
      .replace(
        serverPathImport,
        'import { dirname, join, resolve as resolveKnowledgeEntryPath } from "node:path";',
      )
      .replace(
        serverGuard,
        "process.argv[1] && resolveKnowledgeEntryPath(fileURLToPath(import.meta.url)) === resolveKnowledgeEntryPath(process.argv[1])",
      ),
  );

  const mcpPath = join(knowledgeDir, "src", "mcp", "server.ts");
  const mcp = await readFile(mcpPath, "utf8");
  if (!mcp.includes(serverGuard)) throw new Error(`unexpected Knowledge MCP main guard: ${mcpPath}`);
  await writeFile(
    mcpPath,
    `import { fileURLToPath as knowledgeFileURLToPath } from "node:url";\nimport { resolve as resolveKnowledgePath } from "node:path";\n${mcp.replace(
      serverGuard,
      "process.argv[1] && resolveKnowledgePath(knowledgeFileURLToPath(import.meta.url)) === resolveKnowledgePath(process.argv[1])",
    )}`,
  );
}

async function patchKnowledgeRuntime(knowledgeDir) {
  const serverPath = join(knowledgeDir, "src", "server.ts");
  let server = await readFile(serverPath, "utf8");
  server = patchKnowledgeApiAuth(server);
  server = patchKnowledgeStdinShutdown(server);
  await writeFile(
    serverPath,
    server,
  );

  const mcpClientPath = join(knowledgeDir, "src", "mcp", "http-client.ts");
  await writeFile(
    mcpClientPath,
    patchKnowledgeMcpHttpClient(await readFile(mcpClientPath, "utf8")),
  );

  const mcpServerPath = join(knowledgeDir, "src", "mcp", "server.ts");
  await writeFile(
    mcpServerPath,
    patchKnowledgeMcpServer(await readFile(mcpServerPath, "utf8")),
  );

  const registryPath = join(knowledgeDir, "src", "source-fetcher", "registry.ts");
  await writeFile(
    registryPath,
    patchKnowledgeSourceRegistry(await readFile(registryPath, "utf8")),
  );
  await writeFile(
    join(knowledgeDir, "src", "source-fetcher", "local-fetcher.ts"),
    localSourceFetcherSource,
  );

  const wikiServicePath = join(knowledgeDir, "src", "store", "wiki-service.ts");
  await writeFile(
    wikiServicePath,
    patchKnowledgeWikiWindowsContainment(await readFile(wikiServicePath, "utf8")),
  );
}

async function patchPanelRuntime(panelDir) {
  const indexPath = join(panelDir, "src", "panel", "index.ts");
  let index = patchPanelStdinShutdown(await readFile(indexPath, "utf8"));
  index = patchPanelPortFile(index);
  await writeFile(indexPath, index);
  const registryPath = join(panelDir, "src", "panel", "config", "instance-registry.ts");
  await writeFile(registryPath, patchPanelInstanceRegistry(await readFile(registryPath, "utf8")));
  const appPath = join(panelDir, "src", "panel", "http", "app.ts");
  await writeFile(appPath, patchPanelBootstrapRoutes(await readFile(appPath, "utf8")));
  const transportPath = join(panelDir, "src", "panel", "kernel", "transport-fetch.ts");
  await writeFile(
    transportPath,
    patchPanelMetaLogRedaction(await readFile(transportPath, "utf8")),
  );
}

async function alignKnowledgeLaunchers(knowledgeDir) {
  const launchers = [
    ["server.mjs", "../dist/server.js", "../dist/server.mjs"],
    ["mcp.mjs", "../dist/mcp/server.js", "../dist/mcp/server.mjs"],
  ];
  for (const [name, expected, target] of launchers) {
    const launcher = join(knowledgeDir, "bin", name);
    const source = await readFile(launcher, "utf8");
    if (!source.includes(expected)) throw new Error(`unexpected Knowledge launcher layout: ${launcher}`);
    await writeFile(
      launcher,
      `#!/usr/bin/env node\nimport { fileURLToPath } from "node:url";\nprocess.argv[1] = fileURLToPath(new URL("${target}", import.meta.url));\nawait import("${target}");\n`,
    );
  }
}

function runtimeFile(source) {
  const relative = source.replace(/\\/g, "/");
  return !relative.includes("/.git/") && !relative.includes("/__tests__/") && !relative.endsWith(".test.ts");
}

async function downloadNodeRuntime(workspace, asset = nodeAsset()) {
  const archive = join(workspace, asset.filename);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${asset.filename}`, archive, asset.sha256);
  const extracted = join(workspace, "node");
  await mkdir(extracted, { recursive: true });
  execFileSync("tar", asset.tarArgs(archive, extracted), { stdio: "inherit" });
  const entries = await readdir(extracted);
  if (entries.length !== 1) throw new Error("unexpected Node runtime archive layout");
  return join(extracted, entries[0]);
}

function nodeExecutable(nodeRoot) {
  return process.platform === "win32" ? join(nodeRoot, "node.exe") : join(nodeRoot, "bin", "node");
}

function npmCli(nodeRoot) {
  return process.platform === "win32"
    ? join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    : join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

function nodeAsset() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") {
    return {
      filename: `node-v${nodeVersion}-win-${arch}.zip`,
      sha256:
        arch === "arm64"
          ? "e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2"
          : "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
      tarArgs: (archive, dir) => ["-xf", archive, "-C", dir],
    };
  }
  if (process.platform === "darwin") {
    return {
      filename: `node-v${nodeVersion}-darwin-${arch}.tar.gz`,
      sha256:
        arch === "arm64"
          ? "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d"
          : "3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c",
      tarArgs: (archive, dir) => ["-xzf", archive, "-C", dir],
    };
  }
  return {
    filename: `node-v${nodeVersion}-linux-${arch}.tar.xz`,
    sha256:
      arch === "arm64"
        ? "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
        : "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2",
    tarArgs: (archive, dir) => ["-xJf", archive, "-C", dir],
  };
}

function platformDir() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `windows-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  return `linux-${arch}`;
}

async function verifyLayout(root) {
  const required = [
    process.platform === "win32" ? "node/node.exe" : "node/bin/node",
    "core/src/gateway/server.ts",
    "core/tdai-gateway.standalone.yaml",
    "knowledge/bin/server.mjs",
    "knowledge/dist/server.mjs",
    "knowledge/bin/mcp.mjs",
    "knowledge/dist/mcp/server.mjs",
    "panel/dist/index.js",
    "panel/web/dist/index.html",
    "manifest.json",
  ];
  for (const relative of required) {
    const path = join(root, relative);
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`TencentDB runtime is incomplete: ${basename(path)} is missing from ${root}`);
    }
  }
  try {
    if (!(await stat(join(root, "panel", "web", "public"))).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`TencentDB runtime is incomplete: panel/web/public is missing from ${root}`);
  }
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const expectedNode = nodeAsset();
  if (
    manifest.upstream?.owner !== upstream.owner
    || manifest.upstream?.repo !== upstream.repo
    || manifest.upstream?.commit !== upstream.commit
    || manifest.upstreamSourceSha256 !== upstreamSourceSha256
    || manifest.nodeVersion !== nodeVersion
    || manifest.nodeAsset?.filename !== expectedNode.filename
    || manifest.nodeAsset?.sha256 !== expectedNode.sha256
  ) {
    throw new Error("TencentDB runtime manifest digest or version pin is invalid");
  }
  const mcpBundle = await readFile(join(root, "knowledge", "dist", "mcp", "server.mjs"), "utf8");
  for (const marker of [
    "x-tdai-service-id",
    "x-tdai-user-key",
    "defaultCodeGraphId",
    "KNOWLEDGE_SERVICE_ID",
    "KNOWLEDGE_USER_KEY",
  ]) {
    if (!mcpBundle.includes(marker)) {
      throw new Error(`TencentDB runtime MCP patch is missing marker: ${marker}`);
    }
  }
  const localFetcher = await readFile(
    join(root, "knowledge", "src", "source-fetcher", "local-fetcher.ts"),
    "utf8",
  );
  for (const marker of ["TDAI_LOCAL_SOURCE_ALLOWLIST", "isSymbolicLink()", "local source must be absolute"]) {
    if (!localFetcher.includes(marker)) {
      throw new Error(`TencentDB runtime local workspace fetcher is missing marker: ${marker}`);
    }
  }
  const wikiService = await readFile(join(root, "knowledge", "src", "store", "wiki-service.ts"), "utf8");
  for (const marker of ["import { join, resolve, normalize, sep }", "base.endsWith(sep)"]) {
    if (!wikiService.includes(marker)) {
      throw new Error(`TencentDB runtime Wiki Windows path patch is missing marker: ${marker}`);
    }
  }
  const knowledgeBundle = await readFile(join(root, "knowledge", "dist", "server.mjs"), "utf8");
  const stdinShutdownMarkers = [
    "managed runtime stdin closed",
    'process.stdin.once("end"',
    'process.stdin.once("close"',
  ];
  for (const marker of [
    "TDAI_LOCAL_SOURCE_ALLOWLIST",
    "isSymbolicLink()",
    "base.endsWith(sep)",
    "knowledgeApiAuth",
    "KNOWLEDGE_API_TOKEN is required",
    "timingSafeEqual",
    ...stdinShutdownMarkers,
  ]) {
    if (!knowledgeBundle.includes(marker)) {
      throw new Error(`TencentDB runtime Knowledge bundle is missing marker: ${marker}`);
    }
  }
  const coreEntry = await readFile(join(root, "core", "src", "gateway", "server.ts"), "utf8");
  for (const marker of stdinShutdownMarkers) {
    if (!coreEntry.includes(marker)) {
      throw new Error(`TencentDB runtime Core entry is missing stdin shutdown marker: ${marker}`);
    }
  }
  const panelEntry = await readFile(join(root, "panel", "dist", "panel", "index.js"), "utf8");
  const panelRegistry = await readFile(join(root, "panel", "dist", "panel", "config", "instance-registry.js"), "utf8");
  const panelApp = await readFile(join(root, "panel", "dist", "panel", "http", "app.js"), "utf8");
  const panelTransport = await readFile(
    join(root, "panel", "dist", "panel", "kernel", "transport-fetch.js"),
    "utf8",
  );
  for (const marker of ["managed runtime stdin closed", 'process.stdin.once("close"', "TDAI_PANEL_PORT_FILE"]) {
    if (!panelEntry.includes(marker)) throw new Error(`TencentDB runtime Panel bundle is missing marker: ${marker}`);
  }
  for (const marker of ["TDAI_PANEL_INSTANCES_JSON"]) {
    if (!panelRegistry.includes(marker)) throw new Error(`TencentDB runtime Panel registry is missing marker: ${marker}`);
  }
  for (const marker of ["__grenagent/bootstrap", "__grenagent/health", "x-tdai-panel-shared-secret", "tdai-panel.session", "auth/verify"]) {
    if (!panelApp.includes(marker)) throw new Error(`TencentDB runtime Panel bootstrap is missing marker: ${marker}`);
  }
  for (const marker of ["TDAI_PANEL_LOG_REDACTION_V1", 'return "[redacted]"']) {
    if (!panelTransport.includes(marker)) throw new Error(`TencentDB runtime Panel log redaction is missing marker: ${marker}`);
  }
  const coreMetadataService = await readFile(
    join(root, "core", "src", "metadata", "service", "metadata-service.ts"),
    "utf8",
  );
  for (const marker of ["user_id: input.user_id", "team_id: input.team_id", "agent_id: input.agent_id"]) {
    if (!coreMetadataService.includes(marker)) {
      throw new Error(`TencentDB runtime managed identity patch is missing marker: ${marker}`);
    }
  }
  const panelManifest = manifest.panel;
  if (
    panelManifest?.backendEntry !== "panel/dist/index.js"
    || panelManifest?.webEntry !== "panel/web/dist/index.html"
    || panelManifest?.bootstrapProtocol !== "v1"
  ) throw new Error("TencentDB runtime Panel manifest is invalid");
  console.log(`TencentDB runtime verified: ${root}`);
}

async function download(url, destination, expectedSha256) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error(`invalid expected SHA-256 digest for ${url}`);
  }
  let downloaded = false;
  try {
    execFileSync("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "15", "--max-time", "300", "--output", destination, url], {
      stdio: "inherit",
    });
    downloaded = true;
  } catch {
    console.warn(`curl download failed, falling back to Node fetch: ${url}`);
  }

  let lastError;
  if (!downloaded) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        console.log(`Downloading ${url} (attempt ${attempt}/3)`);
        const response = await fetch(url, {
          headers: { "User-Agent": "GrenAgent build" },
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`);
        const chunks = [];
        for await (const chunk of response.body) chunks.push(chunk);
        await writeFile(destination, Buffer.concat(chunks));
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (!downloaded) throw lastError;

  const actualSha256 = createHash("sha256").update(await readFile(destination)).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${url}: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
}
