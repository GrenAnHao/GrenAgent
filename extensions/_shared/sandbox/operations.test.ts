import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SandboxUnavailableError } from "./errors.js";
import { BASH_COMMAND_ENV, BASH_PID_FILE_ENV, CONFINED_BASH_BOOTSTRAP, createSandboxedBashOperations, msysGroupKillScript, SANDBOX_CWD_ENV } from "./operations.js";
import type { BashShell } from "./shellPath.js";
import type { ConfinedArgv, FileSandboxMode, SandboxExecutionPolicy } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";
import { windowsAccountConfined } from "./windows/runner.js";

const SHELL = "bash";
const GIT_BASH = "D:\\Kits\\Git\\bin\\bash.exe";
const WSL_BASH: BashShell = { shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" };
const COMMAND = "echo hi";
const CWD = "D:/work/repo";

function policy(mode: FileSandboxMode, sessionId = "sess-1"): SandboxExecutionPolicy {
  return { mode, network: "enabled", workspaceRoot: CWD, sessionId };
}

function confined(argv: string[]): ConfinedArgv {
  return {
    argv,
    enforcement: "full",
    denialExitCodes: [SANDBOX_DENIAL_EXIT],
    denialSignatures: ["erofs", "read-only file system"],
    runnerFailureRules: [{
      kind: "runner-launch-failed",
      exitCodes: [127],
      signatures: ["bwrap: executable not found"],
    }],
  };
}

function fakeChild(opts: {
  pid?: number;
  unsetPid?: boolean;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  hang?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  if (!opts.unsetPid) child.pid = opts.pid ?? 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("close", opts.exitCode ?? 1));
    return true;
  };
  if (!opts.hang) {
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      if (opts.spawnError) {
        child.emit("error", opts.spawnError);
        child.emit("close", null);
        return;
      }
      child.emit("close", opts.exitCode ?? 0);
    });
  }
  return child;
}

function collectOnData() {
  const chunks: string[] = [];
  return {
    onData: (data: Buffer | string) => {
      chunks.push(typeof data === "string" ? data : data.toString());
    },
    text: () => chunks.join(""),
  };
}

function makeOps(opts: {
  mode?: FileSandboxMode;
  sessionId?: string;
  confine?: ReturnType<typeof vi.fn>;
  spawnImpl?: ReturnType<typeof vi.fn>;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal?: NodeJS.Signals) => void;
  resolveShell?: (shellPath: string | undefined) => Promise<BashShell | string> | BashShell | string;
  shellPath?: () => string | undefined;
  fullAccessBlocked?: boolean;
}) {
  const spawnCalls: Array<{ file: string; args: readonly string[] }> = [];
  const spawnImpl = opts.spawnImpl ?? vi.fn((file: string, args: readonly string[]) => {
    spawnCalls.push({ file, args });
    return fakeChild({ exitCode: 0 });
  });
  const confine = opts.confine ?? vi.fn(async (_argv: string[], _policy: unknown) => (
    confined(["runner", "--", SHELL, "-c", COMMAND])
  ));
  const ops = createSandboxedBashOperations({
    getPolicy: () => ({
      ...policy(opts.mode ?? "read-only", opts.sessionId ?? "sess-1"),
      ...(opts.fullAccessBlocked ? { fullAccessBlocked: true } : {}),
    }),
    confine,
    spawnImpl,
    resolveShell: opts.resolveShell ?? (async () => SHELL),
    ...(opts.shellPath ? { shellPath: opts.shellPath } : {}),
    platform: opts.platform ?? "linux",
    kill: opts.kill,
  });
  return { ops, confine, spawnImpl, spawnCalls };
}

async function waitForSpawn(spawnImpl: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled());
}

describe("createSandboxedBashOperations", () => {
  it("spawns [shell, -c, command] and skips confine in danger-full-access", async () => {
    const { ops, confine, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const { onData } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith(
      SHELL,
      ["-c", COMMAND],
      expect.objectContaining({ cwd: CWD }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.sandbox).toEqual({ mode: "danger-full-access", denied: false });
  });

  it("spawns the argv returned by confine in other modes", async () => {
    const wrapped = ["bwrap", "--ro-bind", "/", "/", "--", SHELL, "-c", COMMAND];
    const { ops, confine, spawnImpl } = makeOps({
      mode: "workspace-write",
      confine: vi.fn(async () => confined(wrapped)),
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith(
      wrapped[0],
      wrapped.slice(1),
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it("does not spawn when confine throws SandboxUnavailableError; reports it as a fact", async () => {
    const { ops, spawnImpl } = makeOps({
      confine: vi.fn(async () => {
        throw new SandboxUnavailableError("runner missing");
      }),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: null,
      sandbox: {
        mode: "read-only",
        denied: false,
        runnerFailed: "unavailable",
        detail: "runner missing The command was not executed. Enable the OS runner or switch approval to 完全权限.",
      },
    });
    expect(text()).toBe("");
  });

  it("does not tell the user to drop the sandbox when a grant fails", async () => {
    const { ops, spawnImpl } = makeOps({
      confine: vi.fn(async () => {
        throw new SandboxUnavailableError("failed to grant PiSandbox access to C:/work: icacls exited 5");
      }),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.sandbox.runnerFailed).toBe("unavailable");
    expect(result.sandbox.detail).toMatch(/failed to grant PiSandbox/);
    expect(result.sandbox.detail).toMatch(/The command was not executed\.$/);
    expect(result.sandbox.detail).not.toMatch(/完全权限/);
  });

  it("reports a denial on exit 162 as a fact, not as output", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: SANDBOX_DENIAL_EXIT })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: SANDBOX_DENIAL_EXIT, sandbox: { mode: "read-only", denied: true } });
    expect(text()).toBe("");
  });

  it("reports a denial from stderr Read-only file system on exit 1; the output is only the command's", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stderr: "touch: foo: Read-only file system\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 1, sandbox: { mode: "read-only", denied: true } });
    expect(text()).toBe("touch: foo: Read-only file system\n");
  });

  it("does not treat the same denial phrase on stdout as a denial", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stdout: "Read-only file system\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 1, sandbox: { mode: "read-only", denied: false } });
    expect(text()).toBe("Read-only file system\n");
  });

  it("reports a runner launch failure matched by its exit code and signature", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 127, stderr: "bwrap: executable not found\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 127, sandbox: { mode: "read-only", denied: false, runnerFailed: "runner" } });
    expect(text()).toBe("bwrap: executable not found\n");
  });

  it("does not spawn when already aborted", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const ac = new AbortController();
    ac.abort();
    await expect(ops.exec(COMMAND, CWD, { signal: ac.signal, env: {} })).rejects.toThrow("aborted");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("kills the process group on POSIX abort and throws aborted", async () => {
    const kills: Array<{ pid: number; signal?: NodeJS.Signals }> = [];
    let hung: ReturnType<typeof fakeChild> | undefined;
    const spawnImpl = vi.fn(() => {
      hung = fakeChild({ hang: true, pid: 4242 });
      return hung;
    });
    const { ops } = makeOps({
      platform: "linux",
      spawnImpl,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        hung?.emit("close", null);
      },
    });
    const ac = new AbortController();
    const { onData } = collectOnData();
    const promise = ops.exec(COMMAND, CWD, { onData, signal: ac.signal, env: {} });
    await waitForSpawn(spawnImpl);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("uses taskkill /t on Windows abort and throws aborted", async () => {
    let hung: ReturnType<typeof fakeChild> | undefined;
    const spawnImpl = vi.fn((file: string, args: readonly string[]) => {
      if (/taskkill/i.test(file)) {
        queueMicrotask(() => hung?.emit("close", 1));
        return fakeChild({ exitCode: 0 });
      }
      hung = fakeChild({ hang: true, pid: 4242 });
      return hung;
    });
    const { ops } = makeOps({ platform: "win32", spawnImpl });
    const ac = new AbortController();
    const { onData } = collectOnData();
    const promise = ops.exec(COMMAND, CWD, { onData, signal: ac.signal, env: {} });
    await waitForSpawn(spawnImpl);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
    const taskkill = spawnImpl.mock.calls.find((call) => /taskkill/i.test(String(call[0])));
    expect(taskkill).toBeTruthy();
    expect(taskkill?.[1]).toEqual(expect.arrayContaining(["/t"]));
    // A bare name is looked up in the process's working directory first, and that can be the workspace.
    expect(String(taskkill?.[0])).toMatch(/^[A-Za-z]:[\\/].*System32[\\/]taskkill\.exe$/i);
  });

  it("kills the msys process group, then taskkills, when an unconfined Git Bash run is aborted", async () => {
    let hung: ReturnType<typeof fakeChild> | undefined;
    let pidFile = "";
    const spawnImpl = vi.fn((file: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (/taskkill/i.test(file)) {
        queueMicrotask(() => hung?.emit("close", 1));
        return fakeChild({ exitCode: 0 });
      }
      if (hung) return fakeChild({ exitCode: 0 });
      // 真的 bash 会先把自己的 msys pid 写进这个文件。
      pidFile = String(options?.env?.[BASH_PID_FILE_ENV] ?? "");
      writeFileSync(pidFile, "327");
      hung = fakeChild({ hang: true, pid: 4242 });
      return hung;
    });
    const { ops } = makeOps({ mode: "danger-full-access", platform: "win32", resolveShell: async () => GIT_BASH, spawnImpl });
    const ac = new AbortController();
    const promise = ops.exec(COMMAND, CWD, { onData: () => {}, signal: ac.signal, env: {} });
    await waitForSpawn(spawnImpl);
    const [, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(args[0]).toBe("-c");
    expect(args[1]).toMatch(new RegExp(`unset ${BASH_PID_FILE_ENV}; echo hi$`));
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
    const files = spawnImpl.mock.calls.map((call) => String(call[0]));
    const groupKill = spawnImpl.mock.calls.find((call, i) => i > 0 && call[0] === GIT_BASH);
    expect(groupKill?.[1]).toEqual(["-c", msysGroupKillScript("327")]);
    expect(msysGroupKillScript("327")).toContain("kill -9 -- -327");
    expect(files.findIndex((f) => /taskkill/i.test(f))).toBeGreaterThan(files.indexOf(GIT_BASH, 1));
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(false), { timeout: 5000 });
  });

  it("kills a bash that only wrote its pid after the abort (the wrapper was still starting it)", async () => {
    let hung: ReturnType<typeof fakeChild> | undefined;
    let pidFile = "";
    const spawnImpl = vi.fn((file: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (/taskkill/i.test(file)) {
        queueMicrotask(() => hung?.emit("close", 1));
        return fakeChild({ exitCode: 0 });
      }
      if (hung) return fakeChild({ exitCode: 0 });
      pidFile = String(options?.env?.[BASH_PID_FILE_ENV] ?? "");
      hung = fakeChild({ hang: true, pid: 4242 });
      return hung;
    });
    const { ops } = makeOps({ mode: "danger-full-access", platform: "win32", resolveShell: async () => GIT_BASH, spawnImpl });
    const ac = new AbortController();
    const promise = ops.exec(COMMAND, CWD, { onData: () => {}, signal: ac.signal, env: {} });
    await waitForSpawn(spawnImpl);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
    // 停止时还没有 pid：只有 taskkill。
    expect(spawnImpl.mock.calls.filter((call, i) => i > 0 && call[0] === GIT_BASH)).toHaveLength(0);
    // 包装之后才把 bash 拉起来，bash 写下 pid：照样整组结束。
    writeFileSync(pidFile, "512");
    await vi.waitFor(() => {
      const groupKill = spawnImpl.mock.calls.find((call, i) => i > 0 && call[0] === GIT_BASH);
      expect(groupKill?.[1]).toEqual(["-c", msysGroupKillScript("512")]);
    }, { timeout: 2000 });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(false), { timeout: 5000 });
  });

  it("terminates once pid appears after a pending abort", async () => {
    const kills: Array<{ pid: number; signal?: NodeJS.Signals }> = [];
    const child = fakeChild({ hang: true, unsetPid: true });
    const spawnImpl = vi.fn(() => child);
    const { ops } = makeOps({
      platform: "linux",
      spawnImpl,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        child.emit("close", null);
      },
    });
    const ac = new AbortController();
    const promise = ops.exec(COMMAND, CWD, { signal: ac.signal, env: {} });
    await waitForSpawn(spawnImpl);
    ac.abort();
    expect(kills).toEqual([]);
    child.pid = 4242;
    child.emit("spawn");
    await expect(promise).rejects.toThrow("aborted");
    expect(kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  it("treats timeout as seconds and throws timeout:N", async () => {
    let terminated = false;
    let hung: ReturnType<typeof fakeChild> | undefined;
    const { ops } = makeOps({
      platform: "linux",
      spawnImpl: vi.fn(() => {
        hung = fakeChild({ hang: true, pid: 4242 });
        return hung;
      }),
      kill: () => {
        terminated = true;
        hung?.emit("close", null);
      },
    });
    const promise = ops.exec(COMMAND, CWD, { timeout: 1, env: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminated).toBe(false);
    await expect(promise).rejects.toThrow("timeout:1");
    expect(terminated).toBe(true);
  }, 3000);

  it("an isolated workspace policy caps a PI_SANDBOX_MODE_ONCE full-access widening at workspace-write", async () => {
    const confine = vi.fn(async (_argv: string[], p: { mode: string }) => {
      expect(p.mode).toBe("workspace-write");
      return confined(["runner", "--", SHELL, "-c", COMMAND]);
    });
    const { ops } = makeOps({ mode: "workspace-write", confine, fullAccessBlocked: true });
    const result = await ops.exec(COMMAND, CWD, { env: { PI_SANDBOX_MODE_ONCE: "danger-full-access" } });
    expect(confine).toHaveBeenCalled();
    expect(result.sandbox?.mode).toBe("workspace-write");
  });

  it("applies a legal PI_SANDBOX_MODE_ONCE widening without mutating the caller env", async () => {
    const confine = vi.fn(async (_argv: string[], p: { mode: string }) => {
      expect(p.mode).toBe("workspace-write");
      return confined(["runner", "--", SHELL, "-c", COMMAND]);
    });
    const { ops, spawnImpl } = makeOps({ mode: "read-only", confine });
    const env: NodeJS.ProcessEnv = { PI_SANDBOX_MODE_ONCE: "workspace-write", KEEP: "1" };
    const { onData } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env });
    expect(result.sandbox).toEqual({ mode: "workspace-write", denied: false });
    expect(confine).toHaveBeenCalled();
    expect(env.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
    expect(spawnImpl).toHaveBeenCalledWith(
      "runner",
      ["--", SHELL, "-c", COMMAND],
      expect.objectContaining({
        env: expect.objectContaining({ KEEP: "1" }),
      }),
    );
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.PI_SANDBOX_MODE_ONCE).toBeUndefined();
    expect(spawnedEnv).not.toBe(env);
  });

  it("strips PI_SANDBOX_MODE_ONCE from spawn env even without widening", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "read-only" });
    const env: NodeJS.ProcessEnv = { PI_SANDBOX_MODE_ONCE: "read-only" };
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env });
    expect(env.PI_SANDBOX_MODE_ONCE).toBe("read-only");
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.PI_SANDBOX_MODE_ONCE).toBeUndefined();
  });

  it("drops credential-looking variables from a confined run but keeps PI_ and ordinary ones", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "workspace-write" });
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "t", OPENAI_API_KEY: "k", PI_HUMAN_ORIGIN_TOKEN: "1", KEEP: "1" };
    await ops.exec(COMMAND, CWD, { onData: () => {}, env });
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.GH_TOKEN).toBeUndefined();
    expect(spawnedEnv.OPENAI_API_KEY).toBeUndefined();
    expect(spawnedEnv.PI_HUMAN_ORIGIN_TOKEN).toBe("1");
    expect(spawnedEnv.KEEP).toBe("1");
    expect(env.GH_TOKEN).toBe("t");
  });

  it("passes credential-looking variables through when the run is not confined", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "t" };
    await ops.exec(COMMAND, CWD, { onData: () => {}, env });
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.GH_TOKEN).toBe("t");
  });

  it("reports a shell that cannot spawn as a runner failure", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops } = makeOps({ spawnImpl: vi.fn(() => fakeChild({ spawnError: err })) });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({
      exitCode: null,
      sandbox: { mode: "read-only", denied: false, runnerFailed: "runner", detail: "the shell could not start (ENOENT)" },
    });
    expect(text()).toBe("");
  });

  it("reports runner-failure for spawnError without confine", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops, confine } = makeOps({
      mode: "danger-full-access",
      spawnImpl: vi.fn(() => fakeChild({ spawnError: err })),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: null,
      sandbox: { mode: "danger-full-access", denied: false, runnerFailed: "runner", detail: "the shell could not start (ENOENT)" },
    });
  });

  it("spawns Git Bash -c command on win32 when not confined, like pi", async () => {
    const { ops, confine, spawnImpl } = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: { HOME: "C:\\Users\\me" } });
    expect(confine).not.toHaveBeenCalled();
    const [file, args, options] = spawnImpl.mock.calls[0] as [string, string[], { cwd: string; env: NodeJS.ProcessEnv }];
    expect(file).toBe(GIT_BASH);
    expect(args[0]).toBe("-c");
    // 命令前面只多一段同一行的 pid 记录（停止时按 msys 进程组结束），命令本身原样在后面。
    expect(args[1]).toMatch(new RegExp(`^printf '%s' "\\$\\$" > "\\$${BASH_PID_FILE_ENV}" 2>/dev/null; unset ${BASH_PID_FILE_ENV}; echo hi$`));
    expect(options.env[BASH_PID_FILE_ENV]).toMatch(/pi-bash-[0-9a-f]+\.pid$/);
    expect(options.cwd).toBe(CWD);
    // 完全权限下环境原样：命令和 cwd 不经环境变量带，HOME 不动。
    expect(options.env[BASH_COMMAND_ENV]).toBeUndefined();
    expect(options.env[SANDBOX_CWD_ENV]).toBeUndefined();
    expect(options.env.HOME).toBe("C:\\Users\\me");
  });

  it("hands confine a fixed bootstrap and carries the command and cwd in env on confined win32", async () => {
    const confine = vi.fn(async (argv: string[]) => confined(["runner", "--", ...argv]));
    const { ops, spawnImpl } = makeOps({
      mode: "read-only",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
      confine,
    });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: { HOME: "C:\\Users\\me", Home: "x" } });
    const handed = confine.mock.calls[0]?.[0] as string[];
    expect(handed).toEqual([GIT_BASH, "-c", CONFINED_BASH_BOOTSTRAP]);
    const [file, args, options] = spawnImpl.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe("runner");
    expect(args).toEqual(["--", ...handed]);
    expect(options.env[BASH_COMMAND_ENV]).toBe(COMMAND);
    expect(options.env[SANDBOX_CWD_ENV]).toBe(CWD);
    // 登录用户的家目录不带进沙箱（不分大小写）。
    expect(Object.keys(options.env).some((key) => key.toUpperCase() === "HOME")).toBe(false);
  });

  it("keeps the confined Windows command line the same length however long the command is", async () => {
    const confine = vi.fn(async (argv: string[]) => confined(["runner", "--", ...argv]));
    const { ops, spawnImpl } = makeOps({ mode: "workspace-write", platform: "win32", resolveShell: async () => GIT_BASH, confine });
    const long = `printf '%s' "${"x\"y".repeat(2000)}"`;
    await ops.exec(long, CWD, { onData: () => {}, env: {} });
    const handed = confine.mock.calls[0]?.[0] as string[];
    expect(handed).toEqual([GIT_BASH, "-c", CONFINED_BASH_BOOTSTRAP]);
    // CreateProcessWithLogonW 约 1024 字符；引导脚本加 bash 路径远在上限以内。
    expect(handed.join(" ").length).toBeLessThan(500);
    expect((spawnImpl.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env[BASH_COMMAND_ENV]).toBe(long);
  });

  it("lets git in the sandbox account trust the workspace on confined Windows runs", async () => {
    const { ops, spawnImpl } = makeOps({
      mode: "workspace-write",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
    });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    const spawned = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawned.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(spawned.GIT_CONFIG_VALUE_0).toBe(CWD);
  });

  it("does not touch git config on unconfined or non-Windows runs", async () => {
    const full = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
    });
    await full.ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect((full.spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv).GIT_CONFIG_COUNT).toBeUndefined();
    const linux = makeOps({ mode: "workspace-write" });
    await linux.ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect((linux.spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv).GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("keeps the plain -c argv on confined non-Windows runs", async () => {
    const confine = vi.fn(async (argv: string[]) => confined(["runner", "--", ...argv]));
    const { ops, spawnImpl } = makeOps({ mode: "workspace-write", confine });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(confine.mock.calls[0]?.[0]).toEqual([SHELL, "-c", COMMAND]);
    expect((spawnImpl.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env[BASH_COMMAND_ENV]).toBeUndefined();
  });

  it("stops with a runner failure instead of running elsewhere when the shell cannot enter cwd", async () => {
    const confine = vi.fn(async (argv: string[]) => ({
      ...windowsAccountConfined(
        { mode: "workspace-write", network: "enabled", workspaceRoot: CWD, sessionId: "g" },
        argv,
        "C:\\helper\\pi-sandbox-win.exe",
        "C:\\temp",
        { username: "PiSandbox", blobPath: "C:\\blob" },
      ),
    }));
    const { ops } = makeOps({
      mode: "workspace-write",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
      confine,
      spawnImpl: vi.fn(() => fakeChild({
        exitCode: 163,
        stderr: `pi-sandbox-win: the sandbox account cannot open the working directory ${CWD}; the command did not run\n`,
      })),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(result.sandbox).toMatchObject({ mode: "workspace-write", denied: false, runnerFailed: "runner" });
  });

  it("reports Git Bash's Permission denied on a failed confined Windows run as a sandbox denial", async () => {
    const confine = vi.fn(async (argv: string[]) => windowsAccountConfined(
      { mode: "workspace-write", network: "enabled", workspaceRoot: CWD, sessionId: "d" },
      argv,
      "C:\\helper\\pi-sandbox-win.exe",
      "C:\\temp",
      { username: "PiSandbox", blobPath: "C:\\blob" },
    ));
    const { ops } = makeOps({
      mode: "workspace-write",
      platform: "win32",
      resolveShell: async () => GIT_BASH,
      confine,
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stderr: "/usr/bin/bash: line 1: /d/outside/no.txt: Permission denied\n" })),
    });
    const result = await ops.exec("echo x > /d/outside/no.txt", CWD, { onData: () => {}, env: {} });
    expect(result.sandbox).toMatchObject({ mode: "workspace-write", denied: true });
  });

  it("sets NO_COLOR on the spawned shell", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(spawnImpl).toHaveBeenCalledWith(
      SHELL,
      ["-c", COMMAND],
      expect.objectContaining({ env: expect.objectContaining({ NO_COLOR: "1" }) }),
    );
  });

  it("sets PYTHONUNBUFFERED so piped Python output streams", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(spawnImpl).toHaveBeenCalledWith(
      SHELL,
      ["-c", COMMAND],
      expect.objectContaining({ env: expect.objectContaining({ PYTHONUNBUFFERED: "1" }) }),
    );
  });

  it("keeps a caller-provided PYTHONUNBUFFERED", async () => {
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access" });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: { PYTHONUNBUFFERED: "0" } });
    expect(spawnImpl).toHaveBeenCalledWith(
      SHELL,
      ["-c", COMMAND],
      expect.objectContaining({ env: expect.objectContaining({ PYTHONUNBUFFERED: "0" }) }),
    );
  });

  it("resolves the shell once and reuses it across commands", async () => {
    const resolveShell = vi.fn(async () => SHELL);
    const { ops } = makeOps({ mode: "danger-full-access", resolveShell });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(resolveShell).toHaveBeenCalledTimes(1);
  });

  it("resolves the shell again after the cached one fails to spawn", async () => {
    const resolveShell = vi.fn(async () => SHELL);
    let calls = 0;
    const spawnImpl = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
        return fakeChild({ spawnError: error });
      }
      return fakeChild({ exitCode: 0 });
    });
    const { ops } = makeOps({ mode: "danger-full-access", resolveShell, spawnImpl });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(resolveShell).toHaveBeenCalledTimes(2);
  });

  it("strips ANSI from streamed bash output", async () => {
    const { ops } = makeOps({
      mode: "danger-full-access",
      spawnImpl: vi.fn(() =>
        fakeChild({
          exitCode: 0,
          stdout: Buffer.from("\x1b[31;1mCannot set property\x1b[0m\n"),
        }),
      ),
    });
    const { onData, text } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(text()).toBe("Cannot set property\n");
  });

  it("refuses WSL bash under the Windows sandbox without spawning", async () => {
    const { ops, confine, spawnImpl } = makeOps({
      mode: "read-only",
      platform: "win32",
      resolveShell: async () => WSL_BASH,
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result.sandbox).toMatchObject({ mode: "read-only", denied: false, runnerFailed: "unavailable" });
    expect(result.sandbox.detail).toContain("WSL");
    expect(result.sandbox.detail).toContain("shellPath");
    expect(text()).toBe("");
  });

  it("feeds the command to WSL bash on stdin when not confined, like pi", async () => {
    const spawnImpl = vi.fn(() => fakeChild({ exitCode: 0 }));
    const { ops } = makeOps({ mode: "danger-full-access", platform: "win32", resolveShell: async () => WSL_BASH, spawnImpl });
    const written: string[] = [];
    spawnImpl.mockImplementationOnce(() => {
      const child = fakeChild({ exitCode: 0 });
      child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
      return child;
    });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    const [file, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { stdio: unknown[] }];
    expect(file).toBe(WSL_BASH.shell);
    expect(args).toEqual(["-s"]);
    expect(options.stdio[0]).toBe("pipe");
    expect(written.join("")).toBe(COMMAND);
  });

  it("passes the settings shellPath to the resolver and resolves again when it changes", async () => {
    let configured: string | undefined = "D:\\Kits\\Git\\bin\\bash.exe";
    const resolveShell = vi.fn(async (shellPath: string | undefined) => shellPath ?? SHELL);
    const { ops, spawnImpl } = makeOps({ mode: "danger-full-access", resolveShell, shellPath: () => configured });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(resolveShell).toHaveBeenCalledTimes(1);
    expect(resolveShell).toHaveBeenLastCalledWith("D:\\Kits\\Git\\bin\\bash.exe");
    configured = undefined;
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(resolveShell).toHaveBeenCalledTimes(2);
    expect(resolveShell).toHaveBeenLastCalledWith(undefined);
    expect(spawnImpl.mock.calls.map((call) => call[0])).toEqual(["D:\\Kits\\Git\\bin\\bash.exe", "D:\\Kits\\Git\\bin\\bash.exe", SHELL]);
  });

  it("reports a missing bash as unavailable with pi's install hint and does not spawn", async () => {
    const { ops, spawnImpl } = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: () => { throw new Error("No bash shell found. Options:\n  1. Install Git for Windows"); },
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result.sandbox).toMatchObject({ denied: false, runnerFailed: "unavailable" });
    expect(result.sandbox.detail).toContain("Install Git for Windows");
    expect(result.sandbox.detail).toContain("The command was not executed.");
  });

  it("decodes UTF-16LE WSL errors before display", async () => {
    const payload = Buffer.from(
      "拒绝访问。\r\n错误代码: Bash/Service/CreateInstance/E_ACCESSDENIED\r\n",
      "utf16le",
    );
    const { ops } = makeOps({
      mode: "danger-full-access",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stdout: payload })),
    });
    const { onData, text } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(text()).toContain("Bash/Service/CreateInstance/E_ACCESSDENIED");
    expect(text()).toContain("拒绝访问");
  });

});

/** 命令行是 `sleep <seconds>` 的 sleep.exe 有几个（按命令行数，tasklist 只看得到映像名）。 */
function sleepCount(seconds: number): number {
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const out = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command",
    `@(Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -match '\\s${seconds}\\s*$' }).Count`], { encoding: "utf8" });
  return Number(out.trim()) || 0;
}

describe.skipIf(process.platform !== "win32")("Git Bash bootstrap live", () => {
  /** 照 pi 解析：settings.json 的 shellPath，没有就按 pi 的默认顺序。解析到 WSL 就跳过（引导脚本只给 Git Bash 用）。 */
  async function gitBash(): Promise<string | undefined> {
    const { getAgentDir, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { resolveBashShell, isLegacyWslBashPath } = await import("./shellPath.js");
    try {
      const shell = await resolveBashShell(SettingsManager.create(process.cwd(), getAgentDir()).getShellPath());
      return shell.commandTransport === "stdin" || isLegacyWslBashPath(shell.shell) ? undefined : shell.shell;
    } catch {
      return undefined;
    }
  }

  async function runBootstrap(shell: string, command: string, cwd: string, spawnCwd: string) {
    const { spawn } = await import("node:child_process");
    return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(shell, ["-c", CONFINED_BASH_BOOTSTRAP], {
        cwd: spawnCwd,
        env: { ...process.env, [BASH_COMMAND_ENV]: command, [SANDBOX_CWD_ENV]: cwd },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
    });
  }

  it("enters the cwd, hides its variables, keeps UTF-8 and the exit code", async () => {
    const shell = await gitBash();
    if (!shell) return;
    const cwd = mkdtempSync(join(tmpdir(), "pi-bash-boot-"));
    try {
      const result = await runBootstrap(
        shell,
        `echo 中文; pwd -W; echo "leaked=\${${BASH_COMMAND_ENV}:-no}/\${${SANDBOX_CWD_ENV}:-no}"; printf '%s\\n' "a'b\\"c"; exit 5`,
        cwd,
        process.env.SystemRoot ?? "C:\\Windows",
      );
      expect(result.code).toBe(5);
      expect(result.out).toContain("中文");
      expect(result.out).toContain(cwd.replace(/\\/g, "/"));
      expect(result.out).toContain("leaked=no/no");
      expect(result.out).toContain(`a'b"c`);
      expect(result.err).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it("kills Git Bash and its background children on abort when not confined", async () => {
    const shell = await gitBash();
    if (!shell) return;
    // 只数这条用例自己的 sleep（独有的秒数），别的用例同时跑的 sleep 不算。
    const sleeps = () => sleepCount(317);
    const cwd = mkdtempSync(join(tmpdir(), "pi-bash-abort-"));
    const ops = createSandboxedBashOperations({
      getPolicy: () => ({ mode: "danger-full-access", network: "enabled", workspaceRoot: cwd, sessionId: "abort" }),
      confine: async () => { throw new Error("unconfined policy must not confine"); },
      resolveShell: () => shell,
    });
    try {
      const before = sleeps();
      const controller = new AbortController();
      const running = ops.exec("sleep 317 & sleep 317; wait", cwd, { onData: () => {}, signal: controller.signal });
      running.catch(() => undefined);
      const startBy = Date.now() + 15_000;
      while (Date.now() < startBy && sleeps() < before + 2) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sleeps()).toBeGreaterThanOrEqual(before + 2);
      controller.abort();
      await expect(running).rejects.toThrow("aborted");
      const goneBy = Date.now() + 10_000;
      while (Date.now() < goneBy && sleeps() > before) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sleeps()).toBe(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 40000);

  it("exits 163 with the runner marker and runs nothing when the cwd cannot be entered", async () => {
    const shell = await gitBash();
    if (!shell) return;
    const parent = mkdtempSync(join(tmpdir(), "pi-bash-boot-missing-"));
    try {
      const missing = join(parent, "gone");
      const result = await runBootstrap(shell, "echo ran", missing, parent);
      expect(result.code).toBe(163);
      expect(result.out).not.toContain("ran");
      expect(result.err).toContain("pi-sandbox-win: the sandbox account cannot open the working directory");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30000);
});
