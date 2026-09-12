import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { seatbeltArgv } from "./darwin/seatbelt.js";
import { SandboxUnavailableError } from "./errors.js";
import { bwrapArgv } from "./linux/bwrap.js";
import type { ConfinedArgv, SandboxPolicy, SandboxProvider } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";
import { acquireTempDir, dispose as disposeTempDir } from "./tempDirs.js";
import { windowsConfined } from "./windows/runner.js";
import { assertWritableRootsDisjoint } from "./windows/sids.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WIN_HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "windows/bin/pi-sandbox-win.exe",
);

export interface SandboxProbeResult {
  ok: boolean;
  reason?: string;
}

export interface SandboxProviderDeps {
  platform?: NodeJS.Platform;
  probe?: () => Promise<SandboxProbeResult>;
  build?: (argv: string[], policy: SandboxPolicy) => ConfinedArgv;
  tempDir?: string;
  helperPath?: string;
}

/** Record Landlock ABI when present. Missing Landlock does not change enforcement. */
export async function probeLandlockAbi(): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const lsm = await readFile("/proc/sys/kernel/lsm", "utf8");
    if (!/\blandlock\b/.test(lsm)) return null;
    return 1;
  } catch {
    return null;
  }
}

async function probeBwrap(): Promise<SandboxProbeResult> {
  try {
    await execFileAsync("bwrap", ["--version"]);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

function linuxConfined(argv: string[], policy: SandboxPolicy, tempDir: string): ConfinedArgv {
  return {
    argv: bwrapArgv(policy, argv, tempDir),
    enforcement: "full",
    denialExitCodes: [SANDBOX_DENIAL_EXIT],
    denialSignatures: ["erofs", "read-only file system"],
    runnerFailureRules: [{
      kind: "runner-launch-failed",
      exitCodes: [127],
      signatures: ["bwrap: executable not found"],
    }],
  };
}

function probeSeatbelt(): SandboxProbeResult {
  if (existsSync("/usr/bin/sandbox-exec")) return { ok: true };
  return { ok: false, reason: "sandbox-exec not found at /usr/bin/sandbox-exec" };
}

function darwinConfined(argv: string[], policy: SandboxPolicy, tempDir: string): ConfinedArgv {
  return {
    argv: seatbeltArgv(policy, argv, tempDir),
    enforcement: "full",
    denialExitCodes: [SANDBOX_DENIAL_EXIT],
    denialSignatures: ["operation not permitted", "read-only file system"],
    runnerFailureRules: [{
      kind: "runner-missing",
      exitCodes: [127],
      signatures: ["sandbox-exec: command not found"],
    }],
  };
}

function sameArgv(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function probeWinHelper(helperPath: string): SandboxProbeResult {
  if (existsSync(helperPath)) return { ok: true };
  return { ok: false, reason: `windows helper not found at ${helperPath}` };
}

function unwiredReason(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "darwin runner not wired";
  return `${platform} runner not wired`;
}

export function createSandboxProvider(deps: SandboxProviderDeps = {}): SandboxProvider {
  const platform = deps.platform ?? process.platform;
  const helperPath = deps.helperPath ?? DEFAULT_WIN_HELPER;

  function tempDirFor(policy: SandboxPolicy): string {
    return deps.tempDir ?? acquireTempDir(policy.sessionId ?? "default", policy.workspaceRoot);
  }

  async function defaultProbe(): Promise<SandboxProbeResult> {
    if (platform === "linux") return probeBwrap();
    if (platform === "darwin") return probeSeatbelt();
    if (platform === "win32") return probeWinHelper(helperPath);
    return { ok: false, reason: unwiredReason(platform) };
  }

  return {
    async confine(argv, policy) {
      const result = await (deps.probe ?? defaultProbe)();
      if (!result.ok) {
        throw new SandboxUnavailableError(result.reason ?? "sandbox unavailable");
      }

      const tempDir = tempDirFor(policy);

      if (platform === "linux") {
        await probeLandlockAbi();
      }

      if (platform === "win32") {
        assertWritableRootsDisjoint(policy.workspaceRoot, tempDir);
      }

      let confined: ConfinedArgv;
      if (deps.build) {
        confined = deps.build(argv, policy);
      } else if (platform === "linux") {
        confined = linuxConfined(argv, policy, tempDir);
      } else if (platform === "darwin") {
        confined = darwinConfined(argv, policy, tempDir);
      } else if (platform === "win32") {
        confined = windowsConfined(policy, argv, helperPath, tempDir);
      } else {
        throw new SandboxUnavailableError(unwiredReason(platform));
      }

      if (sameArgv(confined.argv, argv)) {
        throw new SandboxUnavailableError("confine must not return the caller's argv unwrapped");
      }
      return confined;
    },
    async dispose(sessionId) {
      disposeTempDir(sessionId);
    },
  };
}
