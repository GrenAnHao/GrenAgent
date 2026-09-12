/**
 * 选 A：预编译 Windows sandbox helper 入仓。
 * 用本机 gcc 或 cl 编 extensions/_shared/sandbox/windows/helper.c，
 * 产出 windows/bin/pi-sandbox-win.exe，方便复现（免 CI 装 MSVC）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const winDir = join(repoRoot, "extensions", "_shared", "sandbox", "windows");
const src = join(winDir, "helper.c");
const outDir = join(winDir, "bin");
const out = join(outDir, "pi-sandbox-win.exe");

mkdirSync(outDir, { recursive: true });

function hasCommand(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [cmd], { encoding: "utf8" }).status === 0;
}

function run(cmd, args) {
  console.log(`build-sandbox-helper: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (hasCommand("gcc")) {
  run("gcc", ["-O2", "-o", out, src, "-ladvapi32", "-lshell32"]);
} else if (hasCommand("cl")) {
  run("cl", ["/nologo", "/O2", `/Fe:${out}`, src, "advapi32.lib", "shell32.lib"]);
} else {
  console.error("build-sandbox-helper: gcc or cl not found");
  process.exit(1);
}

console.log(`build-sandbox-helper: wrote ${out}`);
