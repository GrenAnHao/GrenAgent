import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SandboxUnavailableError } from "./errors.js";
import { bwrapArgv } from "./linux/bwrap.js";
import type { ConfinedArgv, SandboxPolicy, SandboxProvider } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TEMP_DIR = "/tmp/pi-sandbox";

export interface SandboxProbeResult {
  ok: boolean;
  reason?: string;
}

export interface SandboxProviderDeps {
  platform?: NodeJS.Platform;
  probe?: () => Promise<SandboxProbeResult>;
  build?: (argv: string[], policy: SandboxPolicy) => ConfinedArgv;
  tempDir?: string;
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

function sameArgv(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function unwiredReason(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "darwin runner not wired";
  if (platform === "win32") return "win32 runner not wired";
  return `${platform} runner not wired`;
}

export function createSandboxProvider(deps: SandboxProviderDeps = {}): SandboxProvider {
  const platform = deps.platform ?? process.platform;
  const tempDir = deps.tempDir ?? DEFAULT_TEMP_DIR;

  async function defaultProbe(): Promise<SandboxProbeResult> {
    if (platform === "linux") return probeBwrap();
    return { ok: false, reason: unwiredReason(platform) };
  }

  return {
    async confine(argv, policy) {
      const result = await (deps.probe ?? defaultProbe)();
      if (!result.ok) {
        throw new SandboxUnavailableError(result.reason ?? "sandbox unavailable");
      }

      if (platform === "linux") {
        await probeLandlockAbi();
      }

      let confined: ConfinedArgv;
      if (deps.build) {
        confined = deps.build(argv, policy);
      } else if (platform === "linux") {
        confined = linuxConfined(argv, policy, tempDir);
      } else {
        throw new SandboxUnavailableError(unwiredReason(platform));
      }

      if (sameArgv(confined.argv, argv)) {
        throw new SandboxUnavailableError("confine must not return the caller's argv unwrapped");
      }
      return confined;
    },
    async dispose(_sessionId) {
      // Task 7 will release per-session temp dirs.
    },
  };
}
