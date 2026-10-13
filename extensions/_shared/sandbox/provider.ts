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
import { defaultIo, defaultSandboxHome, ensureSandboxAccount, grantSandboxAccess, statProbeArgv, unreachableAs } from "./windows/account.js";
import { windowsAccountArgv, windowsAccountConfined, type SandboxLogon } from "./windows/runner.js";
import { assertWritableRootsDisjoint } from "./windows/sids.js";

const execFileAsync = promisify(execFile);
const WIN_HELPER_NAME = "pi-sandbox-win.exe";
const DEFAULT_HELPER_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface SandboxProbeResult {
  ok: boolean;
  reason?: string;
}

export interface WinHelperLookup {
  envHelper?: string;
  moduleDir?: string;
  resourcesPath?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}

export interface WinHelperResolveInput {
  helperPath?: string;
  envHelper?: string;
  moduleDir: string;
  resourcesPath?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}

export interface SandboxProviderDeps {
  platform?: NodeJS.Platform;
  probe?: () => Promise<SandboxProbeResult>;
  build?: (argv: string[], policy: SandboxPolicy) => ConfinedArgv;
  tempDir?: string;
  helperPath?: string;
  helperLookup?: WinHelperLookup;
  /** Win32 only. Default creates the PiSandbox account and grants workspace ACLs. */
  prepareWindowsIdentity?: (policy: SandboxPolicy, tempDir: string, signal?: AbortSignal, helperPath?: string) => Promise<SandboxLogon>;
}

/**
 * 选 A 预编译入仓：windows/bin/pi-sandbox-win.exe 提交进仓库。
 * extensions 打进 chunk 后 import.meta.url 会漂（与 runner.py 同模式），
 * 故 copyPiAdjacentAssets 再拷到 out/main 与 chunks；asar:true 下 exe 必须 unpack。
 *
 * 探测顺序：deps.helperPath → PI_SANDBOX_WIN_HELPER → 相对本文件
 * windows/bin/pi-sandbox-win.exe → process.resourcesPath 常见 unpacked →
 * out/main/pi-sandbox-win.exe。探测不到才 UNAVAILABLE。
 */
export function winHelperCandidates(input: {
  helperPath?: string;
  envHelper?: string;
  moduleDir: string;
  resourcesPath?: string;
  cwd?: string;
}): string[] {
  const candidates: string[] = [];
  if (input.helperPath) candidates.push(input.helperPath);
  if (input.envHelper) candidates.push(input.envHelper);
  candidates.push(join(input.moduleDir, "windows", "bin", WIN_HELPER_NAME));
  if (input.resourcesPath) {
    candidates.push(
      join(input.resourcesPath, "app.asar.unpacked", "out", "main", WIN_HELPER_NAME),
      join(input.resourcesPath, "app.asar.unpacked", "out", "main", "chunks", WIN_HELPER_NAME),
    );
  }
  candidates.push(join(input.moduleDir, WIN_HELPER_NAME));
  candidates.push(join(input.moduleDir, "..", WIN_HELPER_NAME));
  if (input.cwd) candidates.push(join(input.cwd, "out", "main", WIN_HELPER_NAME));
  return candidates;
}

export function resolveWinHelperPath(input: WinHelperResolveInput): string | undefined {
  const exists = input.exists ?? existsSync;
  for (const candidate of winHelperCandidates(input)) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function processResourcesPath(): string | undefined {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lookupWinHelper(deps: SandboxProviderDeps): string | undefined {
  const lookup = deps.helperLookup ?? {};
  return resolveWinHelperPath({
    helperPath: deps.helperPath,
    envHelper: "envHelper" in lookup ? lookup.envHelper : process.env.PI_SANDBOX_WIN_HELPER,
    moduleDir: lookup.moduleDir ?? DEFAULT_HELPER_MODULE_DIR,
    resourcesPath: lookup.resourcesPath ?? processResourcesPath(),
    cwd: lookup.cwd ?? process.cwd(),
    exists: lookup.exists,
  });
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

function probeWinHelper(helperPath: string | undefined): SandboxProbeResult {
  if (helperPath && existsSync(helperPath)) return { ok: true };
  return { ok: false, reason: `windows helper not found at ${helperPath ?? "any probe path"}` };
}

async function prepareWindowsIdentity(
  policy: SandboxPolicy,
  tempDir: string,
  signal?: AbortSignal,
  helperPath?: string,
): Promise<SandboxLogon> {
  if (signal?.aborted) throw new Error("aborted");
  const identity = await ensureSandboxAccount();
  const logon = { ...identity, home: identity.home ?? defaultSandboxHome(identity.username) };
  // Workspace ancestors are probed as the account itself, through the same helper the command uses.
  const io = helperPath
    ? defaultIo({
      unreachable: (paths, probeSignal) =>
        unreachableAs(windowsAccountArgv({ mode: "read-only", workspaceRoot: policy.workspaceRoot }, statProbeArgv(), helperPath, tempDir, logon), paths, probeSignal),
    })
    : undefined;
  await grantSandboxAccess(identity.username, policy, tempDir, io, signal);
  return logon;
}

function unwiredReason(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "darwin runner not wired";
  return `${platform} runner not wired`;
}

export function createSandboxProvider(deps: SandboxProviderDeps = {}): SandboxProvider {
  const platform = deps.platform ?? process.platform;
  const helperPath = lookupWinHelper(deps);

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
    async confine(argv, policy, signal) {
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
        if (!helperPath) {
          throw new SandboxUnavailableError("windows helper not found at any probe path");
        }
        const identity = await (deps.prepareWindowsIdentity ?? prepareWindowsIdentity)(policy, tempDir, signal, helperPath);
        confined = windowsAccountConfined(policy, argv, helperPath, tempDir, identity);
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
