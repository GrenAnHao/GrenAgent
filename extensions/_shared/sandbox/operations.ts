import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { attributeRun } from "./attribute.js";
import { decodeSpawnChunk } from "./decodeSpawnChunk.js";
import { isStrictWidening } from "./escalate.js";
import { SandboxUnavailableError } from "./errors.js";
import { rememberPendingDenial } from "./pendingDenial.js";
import { isConfined } from "./resolvePreset.js";
import { resolveShellPath } from "./shellPath.js";
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy } from "./types.js";

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

function isWindowsBashExe(path: string): boolean {
  return /(?:^|[\\/])(?:bash|sh)\.exe$/i.test(path);
}

export const PS_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";

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

      const shell = await (deps.resolveShell ?? resolveShellPath)();
      const base = shellArgv(platform, shell, command);
      if (platform === "win32" && isConfined(policy.mode) && isWindowsBashExe(shell)) {
        options.onData?.(Buffer.from(WINDOWS_BASH_UNAVAILABLE));
        return { exitCode: null };
      }
      if (!isConfined(policy.mode)) {
        const result = await run(base, cwd, { ...options, env });
        if (result.spawnError) {
          options.onData?.(Buffer.from(RUNNER_FAILED));
        }
        return { exitCode: result.exitCode };
      }

      let confined: ConfinedArgv;
      try {
        confined = await deps.confine(base, { ...policy, mode: policy.mode });
      } catch (error) {
        if (error instanceof SandboxUnavailableError) {
          options.onData?.(Buffer.from(
            `[sandbox: SANDBOX_UNAVAILABLE] ${error.message} The command was not executed. Enable the OS runner or switch approval to 完全权限.\n`,
          ));
          return { exitCode: null };
        }
        throw error;
      }

      const result = await run(confined.argv, cwd, { ...options, env });
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
