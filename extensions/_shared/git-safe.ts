import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * 在一个沙箱可能写过的工作区里，宿主（Pi 自己，以真实用户身份）运行 git 的方式。
 *
 * 沙箱里的命令能改工作区里的文件，也就能改 `.git/config`、`.gitattributes`、放一个 `git.exe`。宿主在没人点任何东西的时候
 * 就会在工作区里跑 git（文件浏览器每次加载文件树都跑 `git status`），所以：
 * - 不让 Windows 在工作区里找 git：Windows 对不带路径的程序名先在子进程的当前目录里找 `.exe`，当前目录若是工作区，
 *   工作区根里的 `git.exe` 就会被运行。这里子进程的当前目录用 Temp，用 `git -C <工作区>` 指向仓库。默认环境里（没有
 *   `NoDefaultCurrentDirectoryInExePath`）实测会被打中。
 * - 清洗会把 git 指向别处或塞进配置的环境变量（`GIT_DIR`、`GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS` ……）。
 *   用户自己的 `GIT_CONFIG_GLOBAL/SYSTEM` 保留：工作区碰不到它们。
 * - 用 `-c`（命令行级，优先级最高）关掉 `core.fsmonitor`（它是个会被执行的命令），把 `core.hooksPath` 指向空设备。
 * - `GIT_NO_LAZY_FETCH=1`：partial clone 缺对象时 git 会按 `remote.<n>.uploadpack`、`core.sshCommand` 等去取，那些都是命令。
 * - 配置里由 local/worktree/command 范围定义的 filter 驱动，clean/smudge/process 都置空：`.gitattributes` 把文件指派给驱动，
 *   `git status`、`git diff` 比较内容时会运行 clean。用户自己在 global/system 里定义的驱动（典型是 LFS）保留，
 *   否则 LFS 仓库里只是改过时间戳的文件会被报成已修改。`status`/`diff` 另加 `--ignore-submodules=dirty`（子模块有自己的
 *   配置，列不出来）；`diff` 调用方另加 `--no-textconv --no-ext-diff`。
 * - `log.showSignature=false`：打开它 `git log` 会去运行配置里的 `gpg.program`。
 *
 * 两种模式：
 * - `automatic`（默认）：宿主自己发起、没人点任何东西的调用（文件树、git 面板的状态/diff/分支/历史）。hooks 关、filter 置空。
 * - `user`：用户主动点的操作（checkout、建分支）。hooks 和 filter 保留，那是用户自己的工作流（LFS 的 smudge 不能关，
 *   否则检出的是指针文本）；宿主分不出哪个 hook 或 filter 是被放进去的，这是留下的缺口。其余加固照旧。
 *
 * 没有封住的（不要把这里当成"工作区里什么都执行不了"）：
 * - 先列驱动、再执行是两个 git 进程，各读一次 `.git/config`。沙箱能写 `.git/config` 的话，可以在两次读取之间换内容，
 *   让第二次读到一个第一次没列出的驱动。代码层面封不住，要在系统层面不让沙箱账户写 `.git/config`（含 `config.worktree`、
 *   `.git/modules/<子模块>/config`）。列驱动本身失败（超时、输出超限、配置损坏）则直接报错，不放行。
 * - 工作区可写的 `.git` 文件（`gitdir:`）、`include.path`、`core.worktree`、`core.excludesFile`、`objects/info/alternates`
 *   可以指向 `\\host\share`，宿主会以真实用户身份去访问那个共享，可能带出 NTLM 凭据（推断，没有实测网络）。
 * - 宿主自己环境里的 `GIT_EXTERNAL_DIFF`、`GIT_PAGER`、`GIT_SSH*`、`GIT_EXEC_PATH`、`GIT_TRACE*` 按可信处理，没有清洗。
 * - 以后的 git 若支持写在配置里的 hooks（`hook.<name>.command`），`core.hooksPath` 管不到。
 * - 用户在自己的终端里敲的 git、编辑器里的 git 不经过这里。
 */

/** 会把 git 指向别的仓库、索引或配置，或把设置塞进配置的环境变量（DSH process.ts 的清单，GIT_CONFIG_GLOBAL/SYSTEM 除外）。 */
const SCRUBBED_GIT_ENV =
  /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|REPLACE_REF_BASE|ATTR_SOURCE|CONFIG|CONFIG_(COUNT|PARAMETERS|KEY_.+|VALUE_.+))$/;

export const SAFE_GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function safeGitEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SCRUBBED_GIT_ENV.test(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...extra };
}

export type SafeGitMode = "automatic" | "user";

export function safeGitPrefix(mode: SafeGitMode = "automatic"): string[] {
  const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  const prefix = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];
  if (mode === "automatic") prefix.push("-c", `core.hooksPath=${nullHooks}`);
  return prefix;
}

const FILTER_KEY = /^filter\.(.*)\.[^.]+$/;

/** `git config --null --name-only --get-regexp ^filter\.` 的输出里有哪些 filter 驱动（名字可以为空：`[filter ""]`）。 */
export function parseFilterDrivers(nullSeparated: string): Set<string> {
  const drivers = new Set<string>();
  for (const key of nullSeparated.split("\0")) {
    const match = FILTER_KEY.exec(key.trim());
    if (match) drivers.add(match[1] ?? "");
  }
  return drivers;
}

/** 范围是用户自己的：这些范围里的定义工作区碰不到。 */
const USER_SCOPES = new Set(["system", "global"]);

/**
 * `git config --show-scope --null --name-only --get-regexp ^filter\.` 的输出（`范围\0键\0` 成对）里，
 * 至少有一个键来自 local/worktree/command 范围的驱动。用户在 global/system 里定义、工作区没有重新定义的驱动不在其中。
 */
export function parseUntrustedFilterDrivers(nullSeparated: string): Set<string> {
  const tokens = nullSeparated.split("\0");
  const drivers = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (USER_SCOPES.has((tokens[i] ?? "").trim())) continue;
    const match = FILTER_KEY.exec((tokens[i + 1] ?? "").trim());
    if (match) drivers.add(match[1] ?? "");
  }
  return drivers;
}

/** 把这些驱动的 clean/smudge/process 全部置空的 GIT_CONFIG_* 环境（不写 git 配置）。 */
export function filterOverrideEnv(drivers: Iterable<string>): Record<string, string> {
  const pairs: Array<[string, string]> = [];
  for (const driver of drivers) {
    for (const command of ["clean", "smudge", "process"]) pairs.push([`filter.${driver}.${command}`, ""]);
    pairs.push([`filter.${driver}.required`, "false"]);
  }
  if (pairs.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export interface SafeGitOptions {
  /** 默认 automatic；用户主动点的操作传 "user"。 */
  mode?: SafeGitMode;
  /** 这些退出码不算失败。 */
  allowCodes?: readonly number[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SafeGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 不会运行 filter 的子命令，不用先去读一遍配置里有哪些驱动。 */
const FILTER_FREE = new Set(["rev-parse", "branch", "log", "show-ref", "check-ref-format", "config", "symbolic-ref"]);

/** 子模块有自己的配置，超级项目这边列不出它的驱动；dirty 只是不去看子模块工作区里的改动，子模块指针的变化照旧报告。 */
function ignoreSubmodules(args: string[]): string[] {
  const [command, ...rest] = args;
  if ((command !== "status" && command !== "diff") || rest.includes("--no-index")) return args;
  return [command, "--ignore-submodules=dirty", ...rest];
}

interface ExecResult extends SafeGitResult {
  /** 没能正常跑完的原因（没装 git、超时、输出超限）；跑完了就是空。 */
  cause: string;
}

function exec(args: string[], env: NodeJS.ProcessEnv, options: SafeGitOptions): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    // 子进程的当前目录是 Temp：沙箱写不进用户的 Temp 根目录，Windows 找 git.exe 时先看的这个目录里不会有它的东西。
    execFile(
      "git",
      args,
      {
        cwd: tmpdir(),
        env,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? SAFE_GIT_TIMEOUT_MS,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (options.signal?.aborted) {
          reject(new Error("git was cancelled"));
          return;
        }
        const numeric = error && typeof (error as { code?: unknown }).code === "number";
        const code = error ? (numeric ? (error as { code: number }).code : -1) : 0;
        let cause = "";
        if (error && !numeric) cause = (error as { killed?: boolean }).killed ? "git timed out or was stopped" : error.message;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr), cause });
      },
    );
  });
}

function failure(args: string[], result: ExecResult): Error {
  return new Error(`git ${args.join(" ")} failed: ${(result.cause || result.stderr || result.stdout).trim()}`);
}

/**
 * 在 `workspace` 里运行 `git <args>`，按上面的规则加固。返回退出码和输出；退出码不在 `allowCodes`（默认只有 0）里就抛错，
 * 错误里带原因。
 */
export async function runSafeGit(workspace: string, args: string[], options: SafeGitOptions = {}): Promise<SafeGitResult> {
  const mode = options.mode ?? "automatic";
  const prefix = ["-C", workspace, ...safeGitPrefix(mode)];
  let env = safeGitEnv(options.env);
  let finalArgs = args;
  if (mode === "automatic" && !FILTER_FREE.has(args[0] ?? "")) {
    const listArgs = ["config", "--show-scope", "--null", "--name-only", "--get-regexp", "^filter\\."];
    const listed = await exec([...prefix, ...listArgs], env, options);
    // 1 是"一个都没有"。其他结果（超时、输出超限、配置损坏）说明不知道有哪些驱动，不能往下跑。
    if (listed.code !== 0 && listed.code !== 1) throw failure(listArgs, listed);
    env = safeGitEnv({ ...filterOverrideEnv(parseUntrustedFilterDrivers(listed.stdout)), ...options.env });
    finalArgs = ignoreSubmodules(args);
  }
  const result = await exec([...prefix, ...finalArgs], env, options);
  if (!(options.allowCodes ?? [0]).includes(result.code)) throw failure(args, result);
  return result;
}
