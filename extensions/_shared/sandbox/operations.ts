import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { attributeRun } from "./attribute.js";
import { decodeSpawnChunk } from "./decodeSpawnChunk.js";
import { filterSecretEnv, withGitSafeDirectory } from "./env.js";
import { isStrictWidening } from "./escalate.js";
import { SandboxUnavailableError } from "./errors.js";
import { windowsSystemExe } from "./windows/elevate.js";
import { isConfined } from "./resolvePreset.js";
import { isLegacyWslBashPath, resolveBashShell, type BashShell } from "./shellPath.js";
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy, SandboxRunFacts } from "./types.js";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => Pick<ChildProcess, "pid" | "stdout" | "stderr" | "on" | "kill">;

export interface ExecOptions {
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * 沙箱事实作为数据返回（DSH ShellSandboxInfo）：拒绝、runner 失败、隔离起不来都不写进 onData，
 * onData 只转发子进程（含 runner）的输出，执行器不再往里追加沙箱说明。给模型的标记由 bash 工具渲染（facts.ts），
 * user_bash 经 userBash.ts 写回文字。
 */
export interface SandboxedBashOperations {
  exec: (
    command: string,
    cwd: string,
    options: ExecOptions,
  ) => Promise<{ exitCode: number | null; sandbox: SandboxRunFacts }>;
}

export interface SandboxedBashOperationsDeps {
  getPolicy: () => SandboxExecutionPolicy;
  confine: (argv: string[], policy: SandboxPolicy) => Promise<ConfinedArgv>;
  spawnImpl?: SpawnImpl;
  /** settings.json 的 shellPath（pi 的 SettingsManager.getShellPath）；没有就照 pi 的默认顺序找。 */
  shellPath?: () => string | undefined;
  /** 只为可测性：把 shellPath 解析成壳。生产用 pi 的 getShellConfig。给字符串时按 `-c` 传命令。 */
  resolveShell?: (shellPath: string | undefined) => Promise<BashShell | string> | BashShell | string;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal?: NodeJS.Signals) => void;
}

interface RunResult {
  exitCode: number | null;
  spawnError?: unknown;
  stdout?: string;
  stderr?: string;
}

/** WSL 的 bash 没在受限令牌下验证过。去掉了旧版的 `[sandbox: SANDBOX_UNAVAILABLE] ` 前缀和换行，user_bash 适配器会加回去。 */
const WINDOWS_WSL_UNAVAILABLE =
  "Windows OS sandbox cannot run WSL bash. The command was not executed. Point shellPath in settings.json at Git Bash (Git\\bin\\bash.exe), or switch approval to 完全权限.";

/**
 * Windows 受限运行时命令和工作目录经环境变量带进去（helper 照抄调用方环境）：CreateProcessWithLogonW 的命令行
 * 约 1024 字符上限，命令放在命令行里长一点就起不来；固定的引导脚本让命令行长度和命令长度无关。
 * 引导先删掉这两个变量，用户命令和它的子进程看不到；cd 不进工作目录就以 163 退出，按 runner 失败归因、命令不执行。
 */
export const BASH_COMMAND_ENV = "PI_BASH_COMMAND";
export const SANDBOX_CWD_ENV = "PI_SANDBOX_CWD";
export const CONFINED_BASH_BOOTSTRAP =
  `__pi_cmd=$${BASH_COMMAND_ENV}; __pi_cwd=$${SANDBOX_CWD_ENV}; unset ${BASH_COMMAND_ENV} ${SANDBOX_CWD_ENV}; ` +
  `cd -- "$__pi_cwd" 2>/dev/null || { printf '%s\\n' "pi-sandbox-win: the sandbox account cannot open the working directory $__pi_cwd; the command did not run" >&2; exit 163; }; ` +
  `unset __pi_cwd; eval "$__pi_cmd"`;

/** pi 的传法：一般是 `[shell, -c, command]`；WSL 的 bash.exe 命令走 stdin，argv 里不带命令。 */
export function shellArgv(shell: BashShell, command: string): { argv: string[]; input?: string } {
  if (shell.commandTransport === "stdin") return { argv: [shell.shell, ...shell.args], input: command };
  return { argv: [shell.shell, ...shell.args, command] };
}

/**
 * Windows 不受限运行 Git Bash 时，taskkill /t 按 Windows 父进程找子孙，msys 的 fork / exec 会把这条链断开，
 * `sleep 300 &` 这类后台子进程停止后还活着（pi 自己的 killProcessTree 一样）。msys 自己记着进程组：
 * 最外层的 bash 是组长，后台子进程跟着它在同一组。命令前面先把它的 msys pid 写进文件，停止时用 msys 的
 * `kill -9 -- -<pgid>` 整组结束，再照旧 taskkill。写在同一行，命令报错的行号不变。
 */
export const BASH_PID_FILE_ENV = "PI_BASH_PID_FILE";
const PID_FILE_PREFIX = `printf '%s' "$$" > "$${BASH_PID_FILE_ENV}" 2>/dev/null; unset ${BASH_PID_FILE_ENV}; `;

/** 停止后盯 pid 文件的间隔和次数（共约 3 秒）。 */
const MSYS_LATE_PID_POLL_MS = 200;
const MSYS_LATE_PID_POLLS = 15;

export function msysGroupKillScript(pgid: string): string {
  return `for __pi_i in 1 2 3 4 5 6 7 8 9 10; do kill -9 -- -${pgid} 2>/dev/null || exit 0; sleep 0.2; done`;
}

function readMsysPid(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return /^\d+$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

function asBashShell(value: BashShell | string): BashShell {
  return typeof value === "string" ? { shell: value, args: ["-c"] } : value;
}

export function createSandboxedBashOperations(
  deps: SandboxedBashOperationsDeps,
): SandboxedBashOperations {
  const spawnImpl: SpawnImpl = deps.spawnImpl
    ?? ((command, args, options) => defaultSpawn(command, [...args], options));
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? ((pid, signal) => {
    process.kill(pid, signal);
  });
  // 没配 shellPath 时 pi 要同步跑一次 where.exe 找 bash，跑在 agent-host 的事件循环上。按 shellPath 设置缓存，
  // 设置改了就重新解析；起不来（壳被卸载、路径失效）就丢掉缓存。
  let cached: { key: string; shell: Promise<BashShell> } | undefined;
  const resolveShell = (): Promise<BashShell> => {
    const configured = deps.shellPath?.() || undefined;
    const key = configured ?? "";
    if (cached?.key !== key) {
      const shell = Promise.resolve()
        .then(() => (deps.resolveShell ?? resolveBashShell)(configured))
        .then(asBashShell);
      const entry = { key, shell };
      cached = entry;
      shell.catch(() => { if (cached === entry) cached = undefined; });
    }
    return cached.shell;
  };
  const forgetShellOnSpawnError = (result: RunResult) => {
    if (result.spawnError) cached = undefined;
  };

  /** msysGroup：Windows 上不受限的 Git Bash，停止时先按 msys 进程组结束（见 BASH_PID_FILE_ENV）。 */
  function run(
    argv: string[],
    cwd: string,
    options: ExecOptions,
    input?: string,
    msysGroup?: { shell: string; pidFile: string },
  ): Promise<RunResult> {
    if (options.signal?.aborted) {
      if (msysGroup) rmSync(msysGroup.pidFile, { force: true });
      return Promise.reject(new Error("aborted"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let spawnError: unknown;
      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<SpawnImpl> | undefined;
      let pendingAbort = false;
      let timedOut = false;
      let aborted = false;
      /** 停止后还在盯 pid 文件：文件交给盯的那边删。 */
      let watchingPidFile = false;

      const killMsysGroup = (shell: string, msysPid: string) => {
        // 刚 fork 出来的进程可能还没登记进 msys 的进程表，一次 kill 会漏掉：脚本反复整组 kill，直到组里没人为止。
        spawnImpl(shell, ["-c", msysGroupKillScript(msysPid)], { stdio: "ignore", windowsHide: true })
          .on("error", () => { /* 进程组已经没了，或壳起不来：taskkill 照常 */ });
      };

      /**
       * 外层的 bin\bash.exe 是包装，真正的 bash 是它拉起来的。停得太早时 taskkill 的进程快照里还没有这个 bash，
       * 只杀掉包装，bash 之后照样起来、写 pid 文件、跑命令。所以停止后再盯几秒 pid 文件，晚到的 pid 再整组结束一次。
       */
      const stopMsysGroup = (group: { shell: string; pidFile: string }) => {
        let killed = readMsysPid(group.pidFile);
        if (killed) killMsysGroup(group.shell, killed);
        if (watchingPidFile) return;
        watchingPidFile = true;
        let polls = 0;
        const watch = setInterval(() => {
          const late = readMsysPid(group.pidFile);
          if (late && late !== killed) {
            killed = late;
            killMsysGroup(group.shell, late);
          }
          if (++polls >= MSYS_LATE_PID_POLLS) {
            clearInterval(watch);
            rmSync(group.pidFile, { force: true });
          }
        }, MSYS_LATE_PID_POLL_MS);
        watch.unref?.();
      };

      const terminate = () => {
        const pid = child?.pid;
        if (pid == null) {
          pendingAbort = true;
          return;
        }
        if (platform === "win32") {
          if (msysGroup) stopMsysGroup(msysGroup);
          spawnImpl(windowsSystemExe("taskkill.exe"), ["/pid", String(pid), "/t", "/f"]);
          return;
        }
        try {
          kill(-pid, "SIGTERM");
        } catch {
          // the process group may already be gone
        }
      };

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        // 正常结束就删 pid 文件；停止后由 stopMsysGroup 盯完再删。
        if (msysGroup && !watchingPidFile) rmSync(msysGroup.pidFile, { force: true });
        if (timedOut) {
          reject(new Error(`timeout:${options.timeout}`));
          return;
        }
        if (aborted) {
          reject(new Error("aborted"));
          return;
        }
        resolve({
          exitCode: spawnError ? null : exitCode,
          spawnError,
          stdout,
          stderr,
        });
      };

      const onAbort = () => {
        aborted = true;
        terminate();
        if (!pendingAbort) finish(null);
      };

      child = spawnImpl(argv[0] ?? "", argv.slice(1), {
        cwd,
        env: options.env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: platform !== "win32",
      });
      if (input !== undefined) {
        const stdin = (child as Partial<ChildProcess>).stdin;
        stdin?.on("error", () => { /* 进程没读完就退出了 */ });
        stdin?.end(input);
      }

      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err.code ?? err.message;
        finish(null);
      });
      child.stdout?.on("data", (data: Buffer) => {
        const decoded = decodeSpawnChunk(data);
        stdout += decoded.toString();
        options.onData?.(decoded);
      });
      child.stderr?.on("data", (data: Buffer) => {
        const decoded = decodeSpawnChunk(data);
        stderr += decoded.toString();
        options.onData?.(decoded);
      });
      child.on("close", (code) => {
        finish(typeof code === "number" ? code : null);
      });
      child.on("spawn", () => {
        if (!pendingAbort) return;
        pendingAbort = false;
        terminate();
        if (aborted || timedOut) finish(null);
      });

      options.signal?.addEventListener("abort", onAbort);

      if (options.timeout != null && options.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          terminate();
          if (!pendingAbort) finish(null);
        }, options.timeout * 1000);
      }
    });
  }

  return {
    async exec(command, cwd, options) {
      const policy = { ...deps.getPolicy() };
      const env = { ...(options.env ?? process.env) };
      const once = env.PI_SANDBOX_MODE_ONCE;
      if (
        (once === "workspace-write" || once === "danger-full-access")
        && isStrictWidening(policy.mode, once)
      ) {
        policy.mode = once;
      }
      // 独立工作区：单次放宽同样不能越过 workspace-write（getPolicy 已经把起步模式钳住了）。
      if (policy.fullAccessBlocked && policy.mode === "danger-full-access") policy.mode = "workspace-write";
      delete env.PI_SANDBOX_MODE_ONCE;
      if (!env.NO_COLOR) env.NO_COLOR = "1";
      // 管道上的 Python 会把 stdout 整块缓冲到退出，卡片里看不到过程。
      if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = "1";
      const facts = (extra: Partial<SandboxRunFacts> = {}): SandboxRunFacts => ({
        mode: policy.mode,
        denied: false,
        ...extra,
      });
      const shellFailed = (result: RunResult) =>
        facts({ runnerFailed: "runner", detail: `the shell could not start (${String(result.spawnError)})` });

      let shell: BashShell;
      try {
        shell = await resolveShell();
      } catch (error) {
        // pi 找不到 bash 时的报错本身就带安装说明。
        const detail = error instanceof Error ? error.message : String(error);
        return { exitCode: null, sandbox: facts({ runnerFailed: "unavailable", detail: `${detail}\nThe command was not executed.` }) };
      }
      if (!isConfined(policy.mode)) {
        const msys = platform === "win32" && shell.commandTransport !== "stdin" && !isLegacyWslBashPath(shell.shell);
        if (!msys) {
          const { argv, input } = shellArgv(shell, command);
          const result = await run(argv, cwd, { ...options, env }, input);
          forgetShellOnSpawnError(result);
          return { exitCode: result.exitCode, sandbox: result.spawnError ? shellFailed(result) : facts() };
        }
        const pidFile = join(tmpdir(), `pi-bash-${randomBytes(6).toString("hex")}.pid`);
        const argv = [shell.shell, ...shell.args, PID_FILE_PREFIX + command];
        const result = await run(argv, cwd, { ...options, env: { ...env, [BASH_PID_FILE_ENV]: pidFile } }, undefined, { shell: shell.shell, pidFile });
        forgetShellOnSpawnError(result);
        return { exitCode: result.exitCode, sandbox: result.spawnError ? shellFailed(result) : facts() };
      }
      if (platform === "win32" && (shell.commandTransport === "stdin" || isLegacyWslBashPath(shell.shell))) {
        return { exitCode: null, sandbox: facts({ runnerFailed: "unavailable", detail: WINDOWS_WSL_UNAVAILABLE }) };
      }
      // 沙箱没有网络围栏，凭据类环境变量不带进受限命令。
      const filteredEnv = filterSecretEnv(env);
      const confinedEnv = platform === "win32"
        ? withGitSafeDirectory(filteredEnv, policy.workspaceRoot)
        : filteredEnv;
      let base = shellArgv(shell, command).argv;
      if (platform === "win32") {
        confinedEnv[BASH_COMMAND_ENV] = command;
        confinedEnv[SANDBOX_CWD_ENV] = cwd;
        // 调用方的 HOME 指向登录用户的家目录；去掉后 msys 按令牌的账户取家目录（PiSandbox 的 profile）。
        for (const key of Object.keys(confinedEnv)) if (key.toUpperCase() === "HOME") delete confinedEnv[key];
        base = [shell.shell, ...shell.args, CONFINED_BASH_BOOTSTRAP];
      }

      let confined: ConfinedArgv;
      try {
        if (options.signal?.aborted) throw new Error("aborted");
        confined = await deps.confine(base, { ...policy, mode: policy.mode }, options.signal);
        if (options.signal?.aborted) throw new Error("aborted");
      } catch (error) {
        if (error instanceof Error && error.message === "aborted") throw error;
        if (error instanceof SandboxUnavailableError) {
          const hint = error.message.includes("failed to grant ")
            ? "The command was not executed."
            : "The command was not executed. Enable the OS runner or switch approval to 完全权限.";
          return { exitCode: null, sandbox: facts({ runnerFailed: "unavailable", detail: `${error.message} ${hint}` }) };
        }
        throw error;
      }

      const result = await run(confined.argv, cwd, { ...options, env: confinedEnv });
      forgetShellOnSpawnError(result);
      const kind = attributeRun(result, confined);
      if (kind.kind === "denial") return { exitCode: result.exitCode, sandbox: facts({ denied: true }) };
      if (kind.kind === "runner-failure") {
        return {
          exitCode: result.exitCode,
          sandbox: result.spawnError ? shellFailed(result) : facts({ runnerFailed: "runner" }),
        };
      }
      return { exitCode: result.exitCode, sandbox: facts() };
    },
  };
}
