import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ResolveShellPathDeps {
  platform?: NodeJS.Platform;
  which?: (name: string) => string | undefined | null;
  exists?: (path: string) => boolean;
}

const DEFAULT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

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

function spawnWhere(name: string): string | undefined {
  const result = spawnSync(winWhereExe(), [name], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, PATH: getWindowsSearchPath() },
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  return undefined;
}

export async function resolveShellPath(deps: ResolveShellPathDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return "bash";

  const which = deps.which ?? spawnWhere;
  const exists = deps.exists ?? existsSync;

  const bash = which("bash.exe");
  if (bash) return bash;

  for (const path of DEFAULT_BASH_PATHS) {
    if (exists(path)) return path;
  }

  const gitExe = which("git.exe");
  if (gitExe) {
    const gitRoot = gitExe.replace(/\\cmd\\git\.exe$/i, "").replace(/\\git\.exe$/i, "");
    const bashPath = `${gitRoot}\\bin\\bash.exe`;
    if (exists(bashPath)) return bashPath;
  }

  return "bash.exe";
}
