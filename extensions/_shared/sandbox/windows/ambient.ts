import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Windows 自带、对所有本地账户可写的目录。PiSandbox 在 Users 组里，什么授权都没有也能往这些目录写。
 * 照 sandbox-runtime 的 ambient.rs，在这些目录上给 PiSandbox 加一条可继承的写拒绝（只对这个账户，读不受影响）。
 *
 * 刻意不在名单里：
 * - C:\Windows\Temp：沙箱要用它，account.ts 专门给过列目录权，写拒绝会让里面的删除和读目录失效。
 * - 盘根（C:\、D:\）：显式 ALLOW 压得过继承来的 DENY，语义上行得通，但 SetNamedSecurityInfo 会把 ACE 写到整卷
 *   每个对象上。数据盘的写权限来自 Authenticated Users，由 launch.c 的受限令牌挡住，不在这里处理。
 */
const SYSTEM_ROOT_TAILS = [
  "Tasks",
  "tracing",
  "Registration\\CRMLog",
  "System32\\FxsTmp",
  "System32\\com\\dmp",
  "System32\\spool\\PRINTERS",
  "System32\\spool\\drivers\\color",
  "SysWOW64\\FxsTmp",
  "SysWOW64\\com\\dmp",
  "SysWOW64\\Tasks",
];

/** WRITE_DATA | APPEND_DATA | WRITE_EA | WRITE_ATTRIBUTES | DELETE | DELETE_CHILD。读和遍历不动。 */
const WRITE_DENY = "(OI)(CI)(WD,AD,WEA,WA,D,DC)";
/** grants.json 里的值；带版本号，规则变了换成 DW2，旧记录就不算数。 */
export const AMBIENT_RIGHTS = "DW1";
const ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000;

export function ambientDenyTargets(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const candidates = [
    env.ProgramData || "C:\\ProgramData",
    env.PUBLIC || "C:\\Users\\Public",
    ...SYSTEM_ROOT_TAILS.map((tail) => `${systemRoot}\\${tail}`),
  ];
  return [...new Set(candidates)].filter((path) => exists(path));
}

export function ambientDenyArgs(target: string, username: string): string[] {
  return [target, "/deny", `${username}:${WRITE_DENY}`, "/C"];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when an icacls dump has a DENY ACE for exactly this account (not for a group whose name starts with it). */
export function ambientDenyPresent(dump: string, username: string): boolean {
  const account = new RegExp(`(^|[\\\\\\s])${escapeRegExp(username)}:`, "i");
  return dump.split(/\r?\n/).some((line) => account.test(line) && line.toUpperCase().includes("(DENY)"));
}

/** 提权脚本写的日志：每个目标一段，`### <路径>` 开头，后面是 icacls 的 ACL 转储。返回转储里看得到写拒绝的目标。 */
export function parseAmbientLog(log: string, username: string): string[] {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith("### ")) {
      current = line.slice(4).trim();
      sections.set(current, []);
    } else if (current) {
      sections.get(current)?.push(line);
    }
  }
  return [...sections.entries()]
    .filter(([, lines]) => ambientDenyPresent(lines.join("\n"), username))
    .map(([path]) => path);
}

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function ambientScript(targets: string[], username: string, logPath: string): string {
  const lines = ["$ErrorActionPreference = 'Continue'", `$log = ${psQuote(logPath)}`];
  for (const target of targets) {
    lines.push(`& icacls.exe ${ambientDenyArgs(target, username).map(psQuote).join(" ")} | Out-Null`);
    lines.push(`Add-Content -LiteralPath $log -Value ('### ' + ${psQuote(target)})`);
    lines.push(`& icacls.exe ${psQuote(target)} 2>&1 | Out-String | Add-Content -LiteralPath $log`);
  }
  return lines.join("\n");
}

export type AmbientStamp = (paths: string[], username: string, signal?: AbortSignal) => Promise<string[]>;

/**
 * 一次 UAC 把名单里缺的目录都盖上。Start-Process -Verb RunAs 拿不到子进程退出码，所以成功与否只看提权脚本写出的
 * ACL 转储（和 account.ts 里 Windows\Temp 的授权同一个做法）。返回转储里确认有写拒绝的目录。
 */
export const stampAmbientDenies: AmbientStamp = async (paths, username, signal) => {
  const id = randomBytes(8).toString("hex");
  const scriptPath = join(tmpdir(), `pi-sandbox-ambient-${id}.ps1`);
  const logPath = join(tmpdir(), `pi-sandbox-ambient-${id}.log`);
  await writeFile(scriptPath, ambientScript(paths, username, logPath), "utf8");
  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptPath)}`,
      ],
      { windowsHide: true, timeout: 120_000, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw new Error("aborted");
    throw error;
  } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  }
  const log = await readFile(logPath, "utf8").catch(() => "");
  await rm(logPath, { force: true }).catch(() => undefined);
  return parseAmbientLog(log, username);
};

let lastAttemptAt = 0;

export function __resetAmbientAttemptForTest(): void {
  lastAttemptAt = 0;
}

export function ambientKey(path: string): string {
  return `ambient:${path.toLowerCase()}`;
}

export interface AmbientOptions {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * 给名单里还没记录的目录盖上写拒绝，确认过的记进 grants。拒绝 UAC 或提权失败不算错：沙箱照常用，只是这些目录
 * 仍然可写；冷却期内不再弹窗。abort 照常向上抛。返回 grants 是否有变化。
 */
export async function applyAmbientDenies(
  username: string,
  grants: Record<string, string>,
  stamp: AmbientStamp,
  options: AmbientOptions = {},
): Promise<boolean> {
  const missing = ambientDenyTargets(options.env, options.exists)
    .filter((path) => grants[ambientKey(path)] !== AMBIENT_RIGHTS);
  if (missing.length === 0) return false;
  const now = (options.now ?? Date.now)();
  if (lastAttemptAt > 0 && now - lastAttemptAt < ATTEMPT_COOLDOWN_MS) return false;
  lastAttemptAt = now;
  let confirmed: string[];
  try {
    confirmed = await stamp(missing, username, options.signal);
  } catch (error) {
    if (error instanceof Error && error.message === "aborted") throw error;
    return false;
  }
  for (const path of confirmed) grants[ambientKey(path)] = AMBIENT_RIGHTS;
  return confirmed.length > 0;
}
