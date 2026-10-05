import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { attributeRun } from "./attribute.js";
import { decodeSpawnChunk } from "./decodeSpawnChunk.js";
import { isStrictWidening } from "./escalate.js";
import { SandboxUnavailableError } from "./errors.js";
import { rememberPendingDenial } from "./pendingDenial.js";
import { isConfined } from "./resolvePreset.js";
import { resolveShellPath } from "./shellPath.js";
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy } from "./types.js";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
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

export interface SandboxedBashOperations {
  exec: (
    command: string,
    cwd: string,
    options: ExecOptions,
  ) => Promise<{ exitCode: number | null }>;
}

export interface SandboxedBashOperationsDeps {
  getPolicy: () => SandboxExecutionPolicy;
  confine: (argv: string[], policy: SandboxPolicy) => Promise<ConfinedArgv>;
  spawnImpl?: SpawnImpl;
  resolveShell?: () => Promise<string> | string;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal?: NodeJS.Signals) => void;
}

interface RunResult {
  exitCode: number | null;
  spawnError?: unknown;
  stdout?: string;
  stderr?: string;
}

const RUNNER_FAILED = "[sandbox: runner failed] The command never started.\n";
const WINDOWS_BASH_UNAVAILABLE =
  "[sandbox: SANDBOX_UNAVAILABLE] Windows OS sandbox cannot start Git Bash or WSL bash under a restricted token (Win32 error 5). The command was not executed. Switch approval to 完全权限.\n";

/**
 * CreateProcessWithLogonW passes lpCommandLine through the Secondary Logon
 * Service RPC which has a ~1024 character limit. PS_UTF8_PREFIX, shell flags,
 * and the launcher path consume ~450 chars of that. When the user command
 * exceeds this threshold, write it to a temp .ps1 file and invoke via -File.
 */
const WIN_COMMAND_FILE_THRESHOLD = 400;

function isWindowsBashExe(path: string): boolean {
  return /(?:^|[\\/])(?:bash|sh)\.exe$/i.test(path);
}

// Constrained Language Mode (OS sandbox / AppContainer) forbids setting
// [Console]::OutputEncoding — a bare assignment prints a VT-colored
// InvalidOperation on every command. Only set it in FullLanguage; always
// export NO_COLOR so pwsh $PSStyle stays plaintext even when the property set
// is illegal.
// AutoFlush：管道上的 PowerShell 默认攒满缓冲才写 stdout，界面要等命令结束才看到输出。
// 只在 FullLanguage 里换掉 Console.Out；约束语言模式碰 .NET 会在每条命令上打印错误。
export const PS_UTF8_PREFIX =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }; try { $__piOut = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()); $__piOut.AutoFlush = $true; [Console]::SetOut($__piOut); $__piErr = New-Object System.IO.StreamWriter ([Console]::OpenStandardError()); $__piErr.AutoFlush = $true; [Console]::SetError($__piErr) } catch {} }\n$env:NO_COLOR = '1'\n";

export function shellArgv(platform: NodeJS.Platform, shell: string, command: string): string[] {
  if (platform === "win32") {
    return [shell, "-NoProfile", "-NonInteractive", "-Command", PS_UTF8_PREFIX + command];
  }
  return [shell, "-c", command];
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
  // 解析壳路径要同步起 powershell 读注册表 PATH 再跑 where.exe，约 0.4s，而且跑在
  // Electron 主进程里，每条命令都卡一次事件循环。只解析一次；起不来（壳被卸载、路径失效）就丢掉缓存。
  let shellPath: Promise<string> | undefined;
  const resolveShell = () =>
    (shellPath ??= Promise.resolve((deps.resolveShell ?? resolveShellPath)()).catch((error: unknown) => {
      shellPath = undefined;
      throw error;
    }));
  const forgetShellOnSpawnError = (result: RunResult) => {
    if (result.spawnError) shellPath = undefined;
  };

  function run(argv: string[], cwd: string, options: ExecOptions): Promise<RunResult> {
    if (options.signal?.aborted) {
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

      const terminate = () => {
        const pid = child?.pid;
        if (pid == null) {
          pendingAbort = true;
          return;
        }
        if (platform === "win32") {
          spawnImpl("taskkill", ["/pid", String(pid), "/t", "/f"]);
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
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
      });

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
      delete env.PI_SANDBOX_MODE_ONCE;
      if (!env.NO_COLOR) env.NO_COLOR = "1";
      // 管道上的 Python 会把 stdout 整块缓冲到退出，卡片里看不到过程。
      if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = "1";

      const shell = await resolveShell();
      let base = shellArgv(platform, shell, command);
      let scriptFile: string | undefined;
      if (platform === "win32" && isConfined(policy.mode) && isWindowsBashExe(shell)) {
        options.onData?.(Buffer.from(WINDOWS_BASH_UNAVAILABLE));
        return { exitCode: null };
      }
      if (!isConfined(policy.mode)) {
        const result = await run(base, cwd, { ...options, env });
        forgetShellOnSpawnError(result);
        if (result.spawnError) {
          options.onData?.(Buffer.from(RUNNER_FAILED));
        }
        return { exitCode: result.exitCode };
      }

      // CreateProcessWithLogonW passes lpCommandLine through the Secondary Logon
      // Service RPC which has a ~1024 character limit. When the user command
      // exceeds the threshold, write it to a temp .ps1 file and invoke via -File.
      //
      // The script MUST live inside the workspace (not acquireTempDir) because
      // acquireTempDir resolves under the host user's %TEMP% which the sandbox
      // account cannot reach. The workspace is always granted to the sandbox
      // user before the process starts. (defect 8)
      if (platform === "win32" && command.length > WIN_COMMAND_FILE_THRESHOLD) {
        const name = `pi-cmd-${randomBytes(4).toString("hex")}.ps1`;
        scriptFile = join(policy.workspaceRoot, name);
        // UTF-8 BOM so both PowerShell 5.1 and 7 read the file correctly.
        writeFileSync(scriptFile, "\ufeff" + PS_UTF8_PREFIX + command, "utf8");
        base = [shell, "-NoProfile", "-NonInteractive", "-File", scriptFile];
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
          options.onData?.(Buffer.from(
            `[sandbox: SANDBOX_UNAVAILABLE] ${error.message} ${hint}\n`,
          ));
          return { exitCode: null };
        }
        throw error;
      }

      const result = await run(confined.argv, cwd, { ...options, env });
      forgetShellOnSpawnError(result);
      if (scriptFile) {
        try { unlinkSync(scriptFile); } catch { /* cleaned by 24h sweep */ }
      }
      const kind = attributeRun(result, confined);
      if (kind.kind === "denial") {
        rememberPendingDenial(cwd, command, policy.mode, policy.sessionId);
        options.onData?.(Buffer.from(
          `[sandbox: file access denied under ${policy.mode} mode]. Call bash_escalate with the exact same command, justification (>=20 chars), and a wider targetMode.\n`,
        ));
      }
      if (kind.kind === "runner-failure") {
        options.onData?.(Buffer.from(RUNNER_FAILED));
      }
      return { exitCode: result.exitCode };
    },
  };
}
