import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * 提权运行 PowerShell 脚本，不落任何文件。
 *
 * 以前的做法是把脚本写进 %TEMP% 再 `Start-Process -Verb RunAs -File`，结果让提权进程写一份日志回来。
 * UAC 弹窗等用户点的那几秒里，同用户的任何进程都能把脚本换掉，换成的代码以管理员身份运行；
 * 提权进程往用户可写目录写日志，也给了重定向写入的机会。现在：
 * - 脚本经 `-EncodedCommand` 内联传进提权进程；
 * - 结果编码进退出码：脚本走到最后才以 ELEVATED_DONE（高位魔数）加低 16 位结果退出。
 *   负数和其他高位都不算：NTSTATUS、CLR 崩溃、被结束的进程都会带上别的高位。
 *   `Start-Process -Verb RunAs -PassThru` 之后先取一次 `$p.Handle`，否则读回的退出码是空的；
 * - 提权脚本第一行把 PSModulePath 钉到 $PSHOME\Modules：默认第一项是用户可写的 Documents，
 *   放在那里的同名模块会以管理员身份加载；
 * - powershell.exe 用 System32 下的绝对路径，不经 PATH 查找。
 */
export const ELEVATED_DONE = 0x2a5a0000;
/** 结果能用的位数：魔数以下。 */
export const ELEVATED_PAYLOAD_BITS = 16;
const PAYLOAD_MASK = 0xffff;
const CANCELLED = "PI-ELEVATE-CANCELLED";
const EXIT_PREFIX = "PI-ELEVATE-EXIT ";
const ERROR_CANCELLED = 1223;
const ELEVATION_TIMEOUT_MS = 120_000;
const FAILURE_DETAIL_MAX = 200;

/** 每个提权脚本的第一行。只是赋值，不调用任何命令，所以这一行本身不会触发模块自动加载。 */
export const ELEVATED_PRELUDE = '$env:PSModulePath = "$PSHOME\\Modules"';

export function windowsPowerShellPath(systemRoot = process.env.SystemRoot || "C:\\Windows"): string {
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * 系统自带工具（icacls、taskkill、net……）一律走 System32 下的绝对路径。裸名字会让 Windows 先在进程的当前目录里
 * 找可执行文件：Pi 或子代理在工作区里启动时，沙箱命令往工作区根目录放一个 icacls.exe，下次授权或回收就会以真实
 * 用户身份运行它。默认环境里没有 NoDefaultCurrentDirectoryInExePath，实测会被打中。
 */
export function windowsSystemExe(name: string, systemRoot = process.env.SystemRoot || "C:\\Windows"): string {
  return join(systemRoot, "System32", name);
}

/** 提权脚本里的 icacls：Windows 目录取自 API，不取环境变量（环境变量由发起提权的进程决定）。 */
export const PS_ICACLS = "(Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe')";

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

/** PowerShell 单引号字符串。PowerShell 把 U+2018–U+201B 也当单引号，只双写 ASCII 引号挡不住注入。 */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * 非提权的外层脚本：起提权进程、等它结束、把退出码打到 stdout。
 * 只有 UAC 被拒（ERROR_CANCELLED）打 CANCELLED；其他启动失败写 stderr 并以 1 退出。
 */
export function elevationLauncher(script: string, shell = windowsPowerShellPath()): string {
  const payload = encodePowerShell(`${ELEVATED_PRELUDE}\n${script}`);
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psQuote(shell)} -Verb RunAs -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${payload}'`,
    "} catch {",
    "  for ($e = $_.Exception; $e; $e = $e.InnerException) {",
    `    if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${ERROR_CANCELLED}) { [Console]::Out.Write('${CANCELLED}'); exit 0 }`,
    "  }",
    "  [Console]::Error.Write($_.Exception.Message)",
    "  exit 1",
    "}",
    "$null = $p.Handle",
    "$p.WaitForExit()",
    `[Console]::Out.Write('${EXIT_PREFIX}' + $p.ExitCode)`,
  ].join("\n");
}

/** 提权脚本的结果位；没走到最后（取消、出错、崩溃、输出读不懂）返回 null。 */
export function parseElevationResult(stdout: string): number | null {
  const match = new RegExp(`${EXIT_PREFIX}(-?\\d+)`).exec(stdout);
  if (!match) return null;
  const code = Number(match[1]);
  if (!Number.isInteger(code) || code < 0 || (code & ~PAYLOAD_MASK) !== ELEVATED_DONE) return null;
  return code & PAYLOAD_MASK;
}

interface LaunchError {
  killed?: boolean;
  code?: number | string | null;
  cmd?: string;
}

/** 外层失败时的错误：不带命令行（里面有整段提权脚本），stderr 只取第一行。 */
export function elevationFailure(error: LaunchError, stderr: string): Error {
  if (error.killed) return new Error("the elevation did not finish in time");
  const detail = stderr.trim().split(/\r?\n/)[0]?.slice(0, FAILURE_DETAIL_MAX) ?? "";
  return new Error(`the elevation could not run (exit ${error.code ?? "unknown"}${detail ? `: ${detail}` : ""})`);
}

export interface AceQuery {
  type: "Allow" | "Deny";
  /** 每一位都要有。 */
  mask: number;
  /** 要求 (OI)(CI) 且不带 propagation 限制。 */
  inheritable?: boolean;
}

/** 脚本片段：`$sidVar` 在 `$pathExpr` 上有一条符合 `query` 的显式 ACE 时为真。按 SID 比，不解析本地化的 icacls 输出。 */
export function psHasAce(pathExpr: string, sidVar: string, query: AceQuery): string {
  const inherit = query.inheritable ? " -and [int]$_.InheritanceFlags -eq 3 -and [int]$_.PropagationFlags -eq 0" : "";
  return `@([System.IO.Directory]::GetAccessControl(${pathExpr}).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference -eq ${sidVar} -and $_.AccessControlType -eq '${query.type}' -and (([int]$_.FileSystemRights -band ${query.mask}) -eq ${query.mask})${inherit} }).Count -gt 0`;
}

/** 脚本片段：把账户名解析成 SID，赋给 `$sid`。 */
export function psSidOf(username: string): string {
  return `$sid = (New-Object System.Security.Principal.NTAccount(${psQuote(username)})).Translate([System.Security.Principal.SecurityIdentifier])`;
}

export type ElevatedRun = (script: string, signal?: AbortSignal) => Promise<number | null>;

/** `execFile` 的最小形状，测试里换成假的。 */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number; signal?: AbortSignal },
  callback: (error: (Error & { code?: number | string; killed?: boolean; cmd?: string }) | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

/** 外层进程自己崩溃：退出码是 NTSTATUS 错误码（0xC0000005 访问冲突等）。普通失败、超时、被取消都不是。 */
function crashed(error: { code?: number | string | null; killed?: boolean }): boolean {
  return !error.killed && typeof error.code === "number" && error.code >= 0xc0000000;
}

/**
 * 提权跑 `script`，返回它的结果位；用户取消或脚本没走到最后返回 null。
 * abort 只能停掉外层：提权进程已经起来了就由它跑完。
 *
 * 外层 Windows PowerShell 5.1 偶尔会在几百毫秒内自己崩溃（System.AccessViolationException，退出码 0xC0000005），
 * 什么也没报告。每个提权脚本都可以安全地跑两遍（账户创建只是再设一次同一个密码，授权和盖章都先查再做），
 * 所以这种崩溃重试一次；超时、普通失败、用户取消不重试。
 */
export function createRunElevated(exec: ExecFileLike = execFile as unknown as ExecFileLike): ElevatedRun {
  const attempt = (script: string, signal?: AbortSignal): Promise<{ bits: number | null } | { crash: Error }> => new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const shell = windowsPowerShellPath();
    exec(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", elevationLauncher(script, shell)],
      { env: windowsPowerShellEnv(), windowsHide: true, timeout: ELEVATION_TIMEOUT_MS, signal },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (error) {
          const failure = elevationFailure(error, String(stderr));
          if (crashed(error)) resolvePromise({ crash: failure });
          else reject(failure);
          return;
        }
        resolvePromise({ bits: parseElevationResult(String(stdout)) });
      },
    );
  });
  return async (script, signal) => {
    const first = await attempt(script, signal);
    if ("bits" in first) return first.bits;
    const second = await attempt(script, signal);
    if ("bits" in second) return second.bits;
    throw second.crash;
  };
}

export const runElevated: ElevatedRun = createRunElevated();
