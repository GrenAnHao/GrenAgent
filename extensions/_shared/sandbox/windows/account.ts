// Dedicated local account for the Windows sandbox, same shape as Codex's elevated
// backend: the command runs as PiSandbox, so named pipes it creates are owned by
// that account and node/vitest piped spawn is allowed. Writes outside the granted
// workspace and temp directory fail because the account has no ACL there.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { SandboxUnavailableError } from "../errors.js";
import type { SandboxPolicy } from "../types.js";
import type { SandboxLogon } from "./runner.js";

export const SANDBOX_USERNAME = "PiSandbox";
export const SANDBOX_GROUP = "PiSandboxUsers";

const execFileAsync = promisify(execFile);

export type GrantRights = "M" | "RX" | "RAX" | "RD" | "RD1";

const LIST_RIGHTS = new Set<GrantRights>(["RD", "RD1"]);

export function icaclsGrantArgs(target: string, username: string, rights: GrantRights, propagate: boolean): string[] {
  // RAX is this directory only: read attributes + traverse, so node realpath can
  // lstat ancestors without granting list or read of their contents.
  // RD/RD1 is list on this directory only: FindFirstFile and readdir need it.
  const ace = rights === "RAX"
    ? `${username}:(RA,X)`
    : LIST_RIGHTS.has(rights)
      ? `${username}:(S,RD,RA)`
      : `${username}:(OI)(CI)${rights}`;
  const args = [target, "/grant:r", ace, "/C"];
  if (propagate && !LIST_RIGHTS.has(rights) && rights !== "RAX") args.push("/T");
  return args;
}

/** True when an icacls dump shows `username` can list the directory. */
export function windowsTempAllowsList(dump: string, username: string): boolean {
  const name = username.toLowerCase();
  return dump.split(/\r?\n/).some((line) => {
    if (!line.toLowerCase().includes(name)) return false;
    for (const match of line.matchAll(/\(([^)]*)\)/g)) {
      const bits = match[1].toUpperCase().split(",").map((bit) => bit.trim());
      if (bits.some((bit) => bit === "RD" || bit === "F" || bit === "M" || bit === "R" || bit === "RX")) {
        return true;
      }
    }
    return false;
  });
}

/** Profile directory the sandbox account actually owns. */
export function defaultSandboxHome(username: string, systemDrive = process.env.SystemDrive || "C:"): string {
  return join(systemDrive, "Users", username);
}

/**
 * Environment that matches the sandbox token. The helper copies the signed-in
 * user's environment, which otherwise advertises a home the account cannot use.
 */
export function sandboxIdentityEnv(home: string, username: string): Record<string, string> {
  const local = join(home, "AppData", "Local");
  const temp = join(local, "Temp");
  const root = parse(home).root;
  const rest = home.slice(root.length).replace(/\//g, "\\");
  return {
    USERNAME: username,
    USERPROFILE: home,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: rest.startsWith("\\") ? rest : `\\${rest}`,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
  };
}

/**
 * Ancestors granted traverse up front: `.pi` and the private `pi-sandbox`
 * folder, which node cannot lstat. Workspace ancestors are probed instead
 * (grantWorkspaceAncestors), so only the ones the account cannot stat change.
 */
export function isGrantableAncestor(dir: string, home: string, tempDir: string): boolean {
  const key = grantKey(dir);
  const pi = `${grantKey(home)}/.pi`;
  const sandboxTemp = grantKey(dirname(tempDir));
  return key === pi || key.startsWith(`${pi}/`) || key === sandboxTemp;
}

/** Parents of `target`, stopping before the drive root. Closest parent first. */
export function ancestorDirectories(target: string): string[] {
  const dirs: string[] = [];
  let current = resolve(target);
  const root = grantKey(parse(current).root);
  for (;;) {
    const parent = dirname(current);
    const parentKey = grantKey(parent);
    if (parentKey === grantKey(current) || parentKey === root) break;
    dirs.push(parent);
    current = parent;
  }
  return dirs;
}

export function grantKey(target: string): string {
  return resolve(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function needsGrant(grants: Record<string, string>, target: string, rights: GrantRights): boolean {
  return grants[grantKey(target)] !== rights;
}

/** PATH entries under the signed-in user's profile. System directories stay as-is. */
export function profilePathDirs(pathEnv: string, home: string): string[] {
  const root = grantKey(home);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of pathEnv.split(";")) {
    const trimmed = entry.trim().replace(/^"/, "").replace(/"$/, "");
    if (!trimmed) continue;
    const key = grantKey(trimmed);
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolve(trimmed));
  }
  return out;
}

export interface AccountIo {
  userExists(username: string): Promise<boolean>;
  provision(username: string, group: string, password: string, blobPath: string): Promise<void>;
  readGrants(path: string): Promise<Record<string, string>>;
  writeGrants(path: string, grants: Record<string, string>): Promise<void>;
  grant(target: string, username: string, rights: GrantRights, propagate: boolean, signal?: AbortSignal): Promise<void>;
  /** Paths the sandbox account cannot read attributes of. Without it, workspace ancestors are left alone. */
  unreachable?(paths: string[], signal?: AbortSignal): Promise<string[]>;
  pathEnv(): string;
  home(): string;
  blobPath(): string;
  grantsPath(): string;
}

function password(): string {
  return `Aa1!${randomBytes(18).toString("base64url")}`;
}

async function defaultUserExists(username: string): Promise<boolean> {
  try {
    await execFileAsync("net", ["user", username], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function defaultProvision(username: string, group: string, plain: string, blobPath: string): Promise<void> {
  const dir = dirname(blobPath);
  await mkdir(dir, { recursive: true });
  const plainPath = join(tmpdir(), `pi-sandbox-plain-${randomBytes(8).toString("hex")}.txt`);
  const scriptPath = join(tmpdir(), `pi-sandbox-setup-${randomBytes(8).toString("hex")}.ps1`);
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.LocalAccounts
$plain = [IO.File]::ReadAllText(${psQuote(plainPath)}).Trim()
$sec = ConvertTo-SecureString $plain -AsPlainText -Force
if (-not (Get-LocalGroup -Name ${psQuote(group)} -ErrorAction SilentlyContinue)) {
  New-LocalGroup -Name ${psQuote(group)} -Description 'Pi sandbox accounts' | Out-Null
}
if (-not (Get-LocalUser -Name ${psQuote(username)} -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name ${psQuote(username)} -Password $sec -UserMayNotChangePassword -PasswordNeverExpires -AccountNeverExpires | Out-Null
} else {
  Set-LocalUser -Name ${psQuote(username)} -Password $sec
}
Add-LocalGroupMember -Group ${psQuote(group)} -Member ${psQuote(username)} -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group 'Users' -Member ${psQuote(username)} -ErrorAction SilentlyContinue
Remove-LocalGroupMember -Group 'Administrators' -Member ${psQuote(username)} -ErrorAction SilentlyContinue
# Grant list-directory on the system temp so Remove-Item, cmd del, and
# readdirSync work consistently (defect 5 + 7). This runs elevated so it
# can modify the system directory ACL.
$winTemp = Join-Path $env:SystemRoot 'Temp'
if (Test-Path $winTemp) {
  & icacls.exe $winTemp /grant ${psQuote(username + ':(S,RD,RA)')} /C 2>$null | Out-Null
}
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$prot = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[IO.File]::WriteAllBytes(${psQuote(blobPath)}, $prot)
Remove-Item -LiteralPath ${psQuote(plainPath)} -Force
`.trim();
  await writeFile(scriptPath, script, "utf8");
  await writeFile(plainPath, plain, "utf8");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true },
    );
  } catch {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptPath)}`,
      ],
      { windowsHide: true },
    );
  } finally {
    await rm(plainPath, { force: true }).catch(() => undefined);
    await rm(scriptPath, { force: true }).catch(() => undefined);
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Timestamp of the last elevation attempt. Re-attempts are allowed after a
// cooldown so that a transient UAC denial does not permanently disable the
// grant for the entire process lifetime.
let listGrantElevatedAt = 0;
const ELEVATION_COOLDOWN_MS = 5 * 60 * 1000;

async function defaultGrant(
  target: string,
  username: string,
  rights: GrantRights,
  propagate: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (rights === "RAX") {
    // Add-Type compiles C# on first use; with powershell.exe startup that alone can pass 5s.
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      raxScript(target, username),
    ], signal, 30_000);
    return;
  }
  const args = icaclsGrantArgs(target, username, rights, propagate);
  if (!LIST_RIGHTS.has(rights)) {
    await runCommand("icacls", args, signal);
    return;
  }
  try {
    await runCommand("icacls", args, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "aborted") throw error;
    await confirmElevatedListGrant(target, username, args, signal);
  }
}

async function confirmElevatedListGrant(
  target: string,
  username: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (listGrantElevatedAt > 0 && Date.now() - listGrantElevatedAt < ELEVATION_COOLDOWN_MS) {
    throw new Error("windows temp list grant already attempted recently");
  }
  listGrantElevatedAt = Date.now();
  const id = randomBytes(8).toString("hex");
  const scriptPath = join(tmpdir(), `pi-sandbox-icacls-${id}.ps1`);
  const logPath = join(tmpdir(), `pi-sandbox-icacls-${id}.log`);
  // Start-Process -Verb RunAs leaves ExitCode null, and `exit $null` is 0.
  // The elevated script writes the ACL dump; that dump is the only success signal.
  const script = `
$ErrorActionPreference = 'Continue'
& icacls.exe ${args.map(psQuote).join(" ")}
$code = $LASTEXITCODE
$dump = & icacls.exe ${psQuote(target)} 2>&1 | Out-String
[IO.File]::WriteAllText(${psQuote(logPath)}, "code=$code\`n$dump")
if ($code -ne 0) { exit $code }
`.trim();
  await writeFile(scriptPath, script, "utf8");
  try {
    await runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptPath)}; if ($null -eq $p) { exit 1 }; if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) { exit $p.ExitCode }`,
      ],
      signal,
      120_000,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "aborted") throw error;
  } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  await rm(logPath, { force: true }).catch(() => undefined);
  if (!windowsTempAllowsList(log, username)) {
    throw new Error("windows temp list grant was not confirmed");
  }
}

/**
 * Adds SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_TRAVERSE (icacls `(S,X,RA)`) on this
 * directory only. Set-Acl and icacls go through SetNamedSecurityInfo, which rewrites
 * every descendant even for a non-inheritable ACE: 30k files took 30-47s, so a
 * profile root or a Downloads folder looked hung. SetFileSecurityW writes this one
 * descriptor. Setting SE_DACL_AUTO_INHERIT_REQ (0x0100, high byte of the control
 * word) keeps the DACL's auto-inherited flag, which SetFileSecurityW drops otherwise.
 */
function raxScript(target: string, username: string): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace PiSandbox -Name Acl -MemberDefinition '[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileSecurityW(string path, int info, byte[] sd);'
$sid = (New-Object System.Security.Principal.NTAccount(${psQuote(username)})).Translate([System.Security.Principal.SecurityIdentifier])
$current = New-Object System.Security.AccessControl.DirectorySecurity(${psQuote(target)}, [System.Security.AccessControl.AccessControlSections]::Access)
$raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($current.GetSecurityDescriptorSddlForm('Access'))
$sd = New-Object System.Security.AccessControl.CommonSecurityDescriptor($true, $false, $raw)
$sd.DiscretionaryAcl.AddAccess('Allow', $sid, 0x1000a0, 'None', 'None')
$bytes = New-Object byte[] $sd.BinaryLength
$sd.GetBinaryForm($bytes, 0)
if ($sd.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) { $bytes[3] = $bytes[3] -bor 0x01 }
if (-not [PiSandbox.Acl]::SetFileSecurityW(${psQuote(target)}, 4, $bytes)) {
  throw (New-Object System.ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
}
`.trim();
}

const STAT_PROBE_ENV = "PI_SANDBOX_STAT_PATHS";
/** Prints the index of every listed path the running account cannot read attributes of. */
const STAT_PROBE_SCRIPT =
  `$i = 0; foreach ($p in $env:${STAT_PROBE_ENV}.Split('|')) { try { [void][IO.File]::GetAttributes($p) } catch { $i }; $i++ }`;

/** Windows PowerShell argv for the stat probe; the caller wraps it to run as the sandbox account. */
export function statProbeArgv(systemRoot = process.env.SystemRoot || "C:\\Windows"): string[] {
  const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return [shell, "-NoProfile", "-NonInteractive", "-Command", STAT_PROBE_SCRIPT];
}

/** Indices printed by the stat probe, mapped back to paths. */
export function parseStatProbe(stdout: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const path = paths[Number(trimmed)];
    if (path !== undefined) out.push(path);
  }
  return out;
}

/**
 * Runs the stat probe through `argv` (the helper launching statProbeArgv as the
 * sandbox account). Paths go through the environment, which the helper copies,
 * so the 1024-character CreateProcessWithLogonW command line stays short.
 */
export function unreachableAs(argv: string[], paths: string[], signal?: AbortSignal): Promise<string[]> {
  if (paths.length === 0) return Promise.resolve([]);
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  const limit = AbortSignal.timeout(30_000);
  const stop = signal ? AbortSignal.any([signal, limit]) : limit;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd: process.env.SystemRoot || "C:\\Windows",
      env: { ...windowsPowerShellEnv(), [STAT_PROBE_ENV]: paths.join("|") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    };
    stop.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stop.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      stop.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (limit.aborted) reject(new Error("timed out probing sandbox access"));
      else if (code === 0) resolvePromise(parseStatProbe(stdout, paths));
      else reject(new Error(stderr.trim() || `sandbox access probe exited ${code}`));
    });
  });
}

/**
 * Environment for a Windows PowerShell 5.1 child. A PSModulePath inherited from
 * pwsh 7 (app started from a pwsh terminal) makes 5.1 autoload 7's modules and
 * fail: Get-Acl reports CouldNotAutoloadMatchingModule. Without it, 5.1 uses its own.
 */
export function windowsPowerShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }
  return env;
}

function runCommand(command: string, args: string[], signal?: AbortSignal, timeoutMs = 5000): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  const limit = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, limit]) : limit;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: windowsPowerShellEnv(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const kill = () => {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    };
    const onAbort = () => kill();
    stop.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      stop.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      stop.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (limit.aborted) reject(new Error(`timed out granting ${command}`));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

export function defaultIo(extra: Pick<AccountIo, "unreachable"> = {}): AccountIo {
  const root = join(homedir(), ".pi", "sandbox");
  return {
    ...extra,
    userExists: defaultUserExists,
    provision: defaultProvision,
    async readGrants(path) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
      } catch {
        return {};
      }
    },
    async writeGrants(path, grants) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(grants), "utf8");
    },
    grant: defaultGrant,
    pathEnv: () => process.env.PATH ?? "",
    home: () => homedir(),
    blobPath: () => join(root, "account.bin"),
    grantsPath: () => join(root, "grants.json"),
  };
}

export async function ensureSandboxAccount(io: AccountIo = defaultIo()): Promise<SandboxLogon> {
  const blobPath = io.blobPath();
  const username = SANDBOX_USERNAME;
  let ready = false;
  try {
    await readFile(blobPath);
    ready = await io.userExists(username);
  } catch {
    ready = false;
  }
  if (!ready) {
    try {
      await io.provision(username, SANDBOX_GROUP, password(), blobPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SandboxUnavailableError(
        `Windows sandbox account ${username} is not ready (${detail}). Approve the one-time account setup, or switch approval to 完全权限.`,
      );
    }
  }
  return { username, blobPath, home: defaultSandboxHome(username) };
}

export async function grantSandboxAccess(
  username: string,
  policy: SandboxPolicy,
  tempDir: string,
  io: AccountIo = defaultIo(),
  signal?: AbortSignal,
): Promise<void> {
  const grantsPath = io.grantsPath();
  const grants = await io.readGrants(grantsPath);
  const targets: Array<{ path: string; rights: GrantRights }> = [
    { path: tempDir, rights: "M" },
    { path: policy.workspaceRoot, rights: policy.mode === "workspace-write" ? "M" : "RX" },
  ];
  const seenAncestors = new Set<string>();
  for (const dir of [...ancestorDirectories(policy.workspaceRoot), ...ancestorDirectories(tempDir)]) {
    const key = grantKey(dir);
    if (seenAncestors.has(key)) continue;
    if (!isGrantableAncestor(dir, io.home(), tempDir)) continue;
    seenAncestors.add(key);
    targets.push({ path: dir, rights: "RAX" });
  }
  for (const dir of profilePathDirs(io.pathEnv(), io.home())) {
    targets.push({ path: dir, rights: "RX" });
  }
  // C:\Windows\Temp allows creating files but not listing them. PowerShell 7
  // Remove-Item calls FindFirstFile before DeleteFile, and node readdir uses
  // the same list right. RD1 is cached only after an elevated icacls dump
  // shows the ACE. A stale "RD" record is not that confirmation.
  const windowsTemp = join(process.env.SystemRoot || "C:\\Windows", "Temp");
  targets.push({ path: windowsTemp, rights: "RD1" });
  let changed = false;
  for (const target of targets) {
    if (signal?.aborted) throw new Error("aborted");
    if (!existsSync(target.path)) continue;
    if (!needsGrant(grants, target.path, target.rights)) continue;
    try {
      const propagate = target.rights === "M" || target.rights === "RX";
      await io.grant(target.path, username, target.rights, propagate, signal);
      grants[grantKey(target.path)] = target.rights;
      changed = true;
    } catch (error) {
      if (error instanceof Error && error.message === "aborted") throw error;
      if (target.rights === "RX" || target.rights === "RAX" || LIST_RIGHTS.has(target.rights)) continue;
      const detail = error instanceof Error ? error.message : String(error);
      throw new SandboxUnavailableError(`failed to grant ${username} access to ${target.path}: ${detail}`);
    }
  }
  if (await grantWorkspaceAncestors(username, policy.workspaceRoot, grants, io, signal)) changed = true;
  if (changed) await io.writeGrants(grantsPath, grants);
}

/** grants.json value for an ancestor the probe found the account can already stat. */
export const REACHABLE = "reachable";
const ANCESTOR_RETRY_MS = 5 * 60 * 1000;
/** Workspace ancestors whose probe or grant failed in this process, keyed to when they may be retried. */
const ancestorRetryAt = new Map<string, number>();

export function __resetAncestorRetryForTest(): void {
  ancestorRetryAt.clear();
}

/**
 * PowerShell resolves its location by reading the attributes of every ancestor
 * of the process cwd. When the sandbox account cannot (a private Downloads,
 * anything two levels under the user profile), it silently starts in C:\ and
 * every command runs there. Probe the ancestors not yet in grants.json as the
 * sandbox account and grant (RA,X) only on the ones it cannot stat.
 * A failed probe or grant is retried after a cooldown, not on every command;
 * meanwhile the shell's working-directory guard stops the command instead.
 */
async function grantWorkspaceAncestors(
  username: string,
  workspaceRoot: string,
  grants: Record<string, string>,
  io: AccountIo,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!io.unreachable) return false;
  const now = Date.now();
  const pending = ancestorDirectories(workspaceRoot).filter((dir) => {
    const key = grantKey(dir);
    return grants[key] === undefined && (ancestorRetryAt.get(key) ?? 0) <= now && existsSync(dir);
  });
  if (pending.length === 0) return false;
  const retryLater = (dir: string) => ancestorRetryAt.set(grantKey(dir), now + ANCESTOR_RETRY_MS);
  let blocked: Set<string>;
  try {
    blocked = new Set((await io.unreachable(pending, signal)).map(grantKey));
  } catch (error) {
    if (error instanceof Error && error.message === "aborted") throw error;
    pending.forEach(retryLater);
    return false;
  }
  let changed = false;
  for (const dir of pending) {
    if (signal?.aborted) throw new Error("aborted");
    const key = grantKey(dir);
    if (!blocked.has(key)) {
      grants[key] = REACHABLE;
      changed = true;
      continue;
    }
    try {
      await io.grant(dir, username, "RAX", false, signal);
      grants[key] = "RAX";
      changed = true;
    } catch (error) {
      if (error instanceof Error && error.message === "aborted") throw error;
      retryLater(dir);
    }
  }
  return changed;
}
