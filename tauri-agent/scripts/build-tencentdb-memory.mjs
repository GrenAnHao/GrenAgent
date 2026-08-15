import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const upstream = {
  owner: "TencentCloud",
  repo: "TencentDB-Agent-Memory",
  commit: "97f94654280b2932c35ba4806a491999ed244cc9",
};
const nodeVersion = "22.19.0";
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
  );
  await mkdir(sourceRoot, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", sourceRoot, "--strip-components=1"], { stdio: "inherit" });

  const nodeRoot = await downloadNodeRuntime(workspace);
  const node = nodeExecutable(nodeRoot);
  const npm = npmCli(nodeRoot);
  const core = join(sourceRoot, "MemoryCore");
  const knowledge = join(sourceRoot, "MemoryKnowledge");
  await disableCoreOpenclawPostinstall(core);
  await pinKnowledgeLoopback(knowledge);
  await fixKnowledgeMainGuards(knowledge);
  installAndBuild(core, false, node, npm);
  installAndBuild(knowledge, true, node, npm);
  await alignKnowledgeLaunchers(knowledge);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(core, join(outputRoot, "core"), { recursive: true, filter: runtimeFile });
  await cp(knowledge, join(outputRoot, "knowledge"), { recursive: true, filter: runtimeFile });
  await cp(nodeRoot, join(outputRoot, "node"), { recursive: true });
  await writeFile(
    join(outputRoot, "manifest.json"),
    `${JSON.stringify({ upstream, nodeVersion }, null, 2)}\n`,
  );
  await verifyLayout(outputRoot);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function installAndBuild(dir, needsBuild, node, npm) {
  const env = {
    ...process.env,
    PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
  };
  const installArgs = needsBuild ? [npm, "install"] : [npm, "install", "--omit=dev"];
  execFileSync(node, installArgs, { cwd: dir, env, stdio: "inherit" });
  if (needsBuild) {
    execFileSync(node, [npm, "run", "build"], { cwd: dir, env, stdio: "inherit" });
    execFileSync(node, [npm, "prune", "--omit=dev"], { cwd: dir, env, stdio: "inherit" });
  }
}

async function disableCoreOpenclawPostinstall(coreDir) {
  const packagePath = join(coreDir, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  delete packageJson.scripts?.postinstall;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
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

async function downloadNodeRuntime(workspace) {
  const asset = nodeAsset();
  const archive = join(workspace, asset.filename);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${asset.filename}`, archive);
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
    return { filename: `node-v${nodeVersion}-win-${arch}.zip`, tarArgs: (archive, dir) => ["-xf", archive, "-C", dir] };
  }
  if (process.platform === "darwin") {
    return { filename: `node-v${nodeVersion}-darwin-${arch}.tar.gz`, tarArgs: (archive, dir) => ["-xzf", archive, "-C", dir] };
  }
  return { filename: `node-v${nodeVersion}-linux-${arch}.tar.xz`, tarArgs: (archive, dir) => ["-xJf", archive, "-C", dir] };
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
  console.log(`TencentDB runtime verified: ${root}`);
}

async function download(url, destination) {
  try {
    execFileSync("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "15", "--max-time", "300", "--output", destination, url], {
      stdio: "inherit",
    });
    return;
  } catch {
    console.warn(`curl download failed, falling back to Node fetch: ${url}`);
  }

  let lastError;
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
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
