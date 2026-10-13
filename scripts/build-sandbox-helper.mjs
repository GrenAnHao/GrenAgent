/**
 * 选 A：预编译 Windows sandbox helper 入仓。
 * 用本机 gcc 或 cl 编 extensions/_shared/sandbox/windows/helper.c，
 * 产出 windows/bin/pi-sandbox-win.exe，方便复现（免 CI 装 MSVC）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const winDir = join(repoRoot, "extensions", "_shared", "sandbox", "windows");
const src = join(winDir, "helper.c");
const launchSrc = join(winDir, "launch.c");
const outDir = join(winDir, "bin");
const out = join(outDir, "pi-sandbox-win.exe");
const launchOut = join(outDir, "pi-sandbox-launch.exe");

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
  run("gcc", ["-O2", "-o", out, src, "-ladvapi32", "-lshell32", "-lcrypt32"]);
  run("gcc", ["-O2", "-mwindows", "-o", launchOut, launchSrc, "-ladvapi32"]);
} else if (hasCommand("cl")) {
  run("cl", ["/nologo", "/O2", `/Fe:${out}`, src, "advapi32.lib", "shell32.lib", "crypt32.lib"]);
  // /SUBSYSTEM 是链接选项，放在 /link 前面 cl 会忽略它（警告 D9002）。launch.c 的入口是 WinMain，链接器本来也会
  // 推断成 Windows 子系统，这里显式写出来，编完后再核对一遍。
  run("cl", ["/nologo", "/O2", `/Fe:${launchOut}`, launchSrc, "advapi32.lib", "/link", "/SUBSYSTEM:WINDOWS"]);
} else {
  console.error("build-sandbox-helper: gcc or cl not found");
  process.exit(1);
}

// launcher 必须是 Windows 子系统（2），控制台子系统（3）会让每条沙箱命令弹出控制台窗口。
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const launchImage = readFileSync(launchOut);
const peOffset = launchImage.readUInt32LE(0x3c);
const subsystem = launchImage.readUInt16LE(peOffset + 24 + 68);
if (subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
  console.error(`build-sandbox-helper: ${launchOut} has PE subsystem ${subsystem}, expected ${IMAGE_SUBSYSTEM_WINDOWS_GUI}`);
  process.exit(1);
}

console.log(`build-sandbox-helper: wrote ${out}`);
