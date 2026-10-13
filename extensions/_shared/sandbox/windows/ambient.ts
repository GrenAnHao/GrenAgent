import { existsSync } from "node:fs";
import {
  ELEVATED_DONE,
  ELEVATED_PAYLOAD_BITS,
  psHasAce,
  psQuote,
  psSidOf,
  runElevated,
  type ElevatedRun,
} from "./elevate.js";

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
/** WD | AD | WEA | WA | DC | D（0x10156）：读回 ACL 时这些位都要在 DENY 里，且带 (OI)(CI)。 */
const WRITE_DENY_MASK = 0x10156;
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

export type AmbientStamp = (paths: string[], username: string, signal?: AbortSignal) => Promise<string[]>;

/**
 * 提权脚本：逐个目录盖上写拒绝，再经 .NET 按 SID 读回 ACL，确认有这条 DENY 的目录在结果里置对应的位。
 * 不写日志、不落文件（见 elevate.ts）。
 */
export function ambientStampScript(targets: string[], username: string): string {
  const deny = ambientDenyArgs("", username).slice(1).map(psQuote).join(", ");
  return [
    "$ErrorActionPreference = 'Continue'",
    psSidOf(username),
    `$targets = @(${targets.map(psQuote).join(", ")})`,
    "$mask = 0",
    "for ($i = 0; $i -lt $targets.Count; $i++) {",
    "  $t = $targets[$i]",
    `  $denyArgs = @(${deny})`,
    // icacls /deny does not merge: running it on a directory that already has the deny adds a second identical ACE.
    "  $has = $false",
    `  try { $has = ${psHasAce("$t", "$sid", { type: "Deny", mask: WRITE_DENY_MASK, inheritable: true })} } catch {}`,
    "  if (-not $has) { & icacls.exe $t @denyArgs | Out-Null }",
    `  try { if (${psHasAce("$t", "$sid", { type: "Deny", mask: WRITE_DENY_MASK, inheritable: true })}) { $mask = $mask -bor (1 -shl $i) } } catch {}`,
    "}",
    `exit (${ELEVATED_DONE} -bor $mask)`,
  ].join("\n");
}

/** 一次 UAC 把名单里缺的目录都盖上，返回确认有写拒绝的目录。脚本没走到最后（用户取消 UAC 等）时抛错。 */
export function createStampAmbient(run: ElevatedRun): AmbientStamp {
  return async (paths, username, signal) => {
    if (paths.length > ELEVATED_PAYLOAD_BITS) {
      throw new Error(`too many ambient targets for one elevation (${paths.length})`);
    }
    const bits = await run(ambientStampScript(paths, username), signal);
    if (bits === null) throw new Error("the elevated ambient write-deny did not finish");
    return paths.filter((_, index) => (bits & (1 << index)) !== 0);
  };
}

export const stampAmbientDenies: AmbientStamp = createStampAmbient(runElevated);

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
