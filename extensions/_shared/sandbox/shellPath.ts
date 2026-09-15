import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export interface ResolveShellPathDeps {
  platform?: NodeJS.Platform;
  which?: (name: string) => string | undefined | null;
  exists?: (path: string) => boolean;
  statSize?: (path: string) => number;
}

function winWhereExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return `${root}\\System32\\where.exe`;
}

function getWindowsSearchPath(): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const chunk of (process.env.PATH ?? "").split(";")) {
    if (chunk && !seen.has(chunk.toLowerCase())) {
      seen.add(chunk.toLowerCase());
      parts.push(chunk);
    }
  }
  try {
    const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const ps = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const result = spawnSync(
      ps,
      [
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { encoding: "utf-8", timeout: 5000, windowsHide: true },
    );
    if (result.status === 0 && result.stdout) {
      for (const chunk of result.stdout.trim().split(";")) {
        if (chunk && !seen.has(chunk.toLowerCase())) {
          seen.add(chunk.toLowerCase());
          parts.push(chunk);
        }
      }
    }
  } catch {
    // registry PATH is best-effort
  }
  return parts.join(";");
}

function spawnWhereAll(name: string): string[] {
  const result = spawnSync(winWhereExe(), [name], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, PATH: getWindowsSearchPath() },
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return [];
}

function spawnWhere(name: string): string | undefined {
  return spawnWhereAll(name)[0];
}

/** Windows Store / System32 bash.exe is the WSL launcher, not Git Bash. */
export function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return (
    normalized.endsWith("\\system32\\bash.exe")
    || normalized.endsWith("\\syswow64\\bash.exe")
    || normalized.endsWith("\\sysnative\\bash.exe")
  );
}

function windowsPowershell51(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function isWindowsAppsAlias(path: string): boolean {
  return path.replace(/\//g, "\\").toLowerCase().includes("\\microsoft\\windowsapps\\");
}

function defaultStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isUsableWin32Exe(
  path: string,
  exists: (p: string) => boolean,
  statSize: (p: string) => number,
): boolean {
  if (isWindowsAppsAlias(path)) return false;
  if (!exists(path)) return false;
  return statSize(path) > 0;
}

export async function resolveShellPath(deps: ResolveShellPathDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return "bash";

  const which = deps.which ?? spawnWhere;
  const exists = deps.exists ?? existsSync;
  const statSize = deps.statSize ?? defaultStatSize;
  const ps51 = windowsPowershell51();

  const pwshHits: string[] = [];
  const fromWhich = which("pwsh.exe");
  if (fromWhich) pwshHits.push(fromWhich);
  if (!deps.which) {
    for (const hit of spawnWhereAll("pwsh.exe")) {
      if (!pwshHits.includes(hit)) pwshHits.push(hit);
    }
  }
  for (const hit of pwshHits) {
    if (isUsableWin32Exe(hit, exists, statSize)) return hit;
  }
  if (isUsableWin32Exe(ps51, exists, statSize)) return ps51;
  return ps51;
}
