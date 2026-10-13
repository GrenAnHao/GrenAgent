import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SandboxUnavailableError } from "./errors.js";
import { createSandboxedBashOperations, PS_CWD_GUARD, PS_CWD_GUARD_ENV, PS_UTF8_PREFIX } from "./operations.js";
import type { ConfinedArgv, FileSandboxMode, SandboxExecutionPolicy } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";
import { windowsAccountConfined } from "./windows/runner.js";

const SHELL = "bash";
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
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  if (!opts.unsetPid) child.pid = opts.pid ?? 4242;
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
  resolveShell?: () => Promise<string> | string;
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
    getPolicy: () => policy(opts.mode ?? "read-only", opts.sessionId ?? "sess-1"),
    confine,
    spawnImpl,
    resolveShell: opts.resolveShell ?? (async () => SHELL),
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
      if (file === "taskkill") {
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
    const taskkill = spawnImpl.mock.calls.find((call) => call[0] === "taskkill");
    expect(taskkill).toBeTruthy();
    expect(taskkill?.[1]).toEqual(expect.arrayContaining(["/t"]));
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

  it("spawns PowerShell -Command with UTF-8 prefix on win32", async () => {
    const { ops, confine, spawnImpl } = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: async () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${PS_UTF8_PREFIX}echo hi`,
      ],
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it("passes UTF-8-prefixed PowerShell argv into confine on win32", async () => {
    const confine = vi.fn(async (argv: string[]) => confined(["runner", "--", ...argv]));
    const { ops, spawnImpl } = makeOps({
      mode: "read-only",
      platform: "win32",
      resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      confine,
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    const handed = confine.mock.calls[0]?.[0] as string[];
    expect(handed[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(handed.slice(1, 4)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(handed[4]).toBe(`${PS_UTF8_PREFIX}iex $env:${PS_CWD_GUARD_ENV}\necho hi`);
    expect(spawnImpl).toHaveBeenCalledWith(
      "runner",
      ["--", ...handed],
      expect.objectContaining({
        cwd: CWD,
        env: expect.objectContaining({ [PS_CWD_GUARD_ENV]: PS_CWD_GUARD }),
      }),
    );
  });

  it("guards the working directory only for confined PowerShell", async () => {
    const { ops, spawnImpl } = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
    await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    const [, args, options] = spawnImpl.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args[3]).not.toContain(PS_CWD_GUARD_ENV);
    expect(options.env[PS_CWD_GUARD_ENV]).toBeUndefined();
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
      resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      confine,
      spawnImpl: vi.fn(() => fakeChild({
        exitCode: 163,
        stderr: `pi-sandbox-win: the sandbox account cannot open the working directory ${CWD}; the command did not run\n`,
      })),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(result.sandbox).toMatchObject({ mode: "workspace-write", denied: false, runnerFailed: "runner" });
  });

  it("PowerShell prefix only sets Console.OutputEncoding in FullLanguage", () => {
    expect(PS_UTF8_PREFIX).toContain("LanguageMode");
    expect(PS_UTF8_PREFIX).toContain("FullLanguage");
    expect(PS_UTF8_PREFIX).toContain("$env:NO_COLOR");
    expect(PS_UTF8_PREFIX).toContain("AutoFlush = $true");
    expect(PS_UTF8_PREFIX).toContain("[Console]::SetOut");
    expect(PS_UTF8_PREFIX).toMatch(
      /if\s*\(\s*\$ExecutionContext\.SessionState\.LanguageMode -eq 'FullLanguage'\s*\)/,
    );
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

  it("refuses Windows bash.exe under the restricted-token helper", async () => {
    const { ops, confine, spawnImpl } = makeOps({
      mode: "read-only",
      platform: "win32",
      resolveShell: async () => "C:\\Git\\bin\\bash.exe",
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result.sandbox).toMatchObject({ mode: "read-only", denied: false, runnerFailed: "unavailable" });
    expect(result.sandbox.detail).toContain("Git Bash or WSL bash");
    expect(result.sandbox.detail).toContain("完全权限");
    expect(text()).toBe("");
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

  it("writes long-command script to workspace, not tmpdir (defect 8 regression)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-ops-d8-"));
    try {
      const longCommand = "Write-Output '" + "A".repeat(500) + "'";
      let confinedArgv: string[] = [];
      const confine = vi.fn(async (argv: string[]) => {
        confinedArgv = argv;
        return confined(["runner", "--", ...argv]);
      });
      const spawnImpl = vi.fn(() => fakeChild({ exitCode: 0 }));
      const opsInner = createSandboxedBashOperations({
        getPolicy: () => ({ mode: "read-only" as const, network: "enabled" as const, workspaceRoot: workDir, sessionId: "d8" }),
        confine,
        spawnImpl,
        resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        platform: "win32",
      });
      await opsInner.exec(longCommand, workDir, { onData: () => {}, env: {} });
      expect(confine).toHaveBeenCalled();
      const fileArg = confinedArgv.find((a) => a.endsWith(".ps1"));
      expect(fileArg).toBeDefined();
      // The script must live under the workspace root, NOT under os.tmpdir().
      const normalWork = workDir.replace(/\//g, "\\");
      expect(fileArg!.startsWith(normalWork)).toBe(true);
      // It should not contain "pi-sandbox" (the old acquireTempDir prefix).
      expect(fileArg).not.toContain("pi-sandbox");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans up the workspace script file after execution (defect 8)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-ops-d8c-"));
    try {
      const longCommand = "Write-Output '" + "B".repeat(500) + "'";
      let capturedFile: string | undefined;
      const confine = vi.fn(async (argv: string[]) => {
        capturedFile = argv.find((a) => a.endsWith(".ps1"));
        return confined(["runner", "--", ...argv]);
      });
      const spawnImpl = vi.fn(() => fakeChild({ exitCode: 0 }));
      const opsInner = createSandboxedBashOperations({
        getPolicy: () => ({ mode: "read-only" as const, network: "enabled" as const, workspaceRoot: workDir, sessionId: "d8c" }),
        confine,
        spawnImpl,
        resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        platform: "win32",
      });
      await opsInner.exec(longCommand, workDir, { onData: () => {}, env: {} });
      // After exec returns, the temp file should have been cleaned up.
      expect(capturedFile).toBeDefined();
      expect(existsSync(capturedFile!)).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("PowerShell UTF-8 prefix live", () => {
  it("emits UTF-8 中文 on stdout, not GBK", async () => {
    const { spawn } = await import("node:child_process");
    const { resolveShellPath } = await import("./shellPath.js");
    const { PS_UTF8_PREFIX } = await import("./operations.js");
    const shell = await resolveShellPath();
    const script = `${PS_UTF8_PREFIX}Write-Output "中文"`;
    const text: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (d: Buffer) => text.push(d));
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    const buf = Buffer.concat(text);
    expect(buf.toString("hex")).toContain("e4b8ade69687");
    expect(buf.toString("hex")).not.toContain("d6d0cec4");
  }, 15000);

  it("encoding prefix is silent under ConstrainedLanguage", async () => {
    const { spawn } = await import("node:child_process");
    const { resolveShellPath } = await import("./shellPath.js");
    const { PS_UTF8_PREFIX } = await import("./operations.js");
    const shell = await resolveShellPath();
    const script =
      `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ${PS_UTF8_PREFIX}Write-Output 'hello-clm'`;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toContain("hello-clm");
    expect(text).not.toMatch(/Cannot set property/i);
    expect(text).not.toMatch(/language mode/i);
  }, 15000);

  it("cwd guard re-enters a reachable cwd, hides its variable, and stays silent under ConstrainedLanguage", async () => {
    const { spawn } = await import("node:child_process");
    const { resolveShellPath } = await import("./shellPath.js");
    const shell = await resolveShellPath();
    const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-guard-"));
    const run = (before: string) => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const script = `${before}${PS_UTF8_PREFIX}iex $env:${PS_CWD_GUARD_ENV}\n`
        + "'loc=' + (Get-Location).Path; 'leaked=' + [bool]$env:" + PS_CWD_GUARD_ENV;
      const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        cwd,
        env: { ...process.env, [PS_CWD_GUARD_ENV]: PS_CWD_GUARD },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
    });
    try {
      // PowerShell's location drifted away from the process cwd, as when the sandbox account cannot normalize it.
      const drifted = await run("Set-Location -LiteralPath $env:SystemRoot; ");
      expect(drifted.code).toBe(0);
      expect(drifted.text).toContain(`loc=${cwd}`);
      expect(drifted.text).toContain("leaked=False");
      const clm = await run("$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ");
      expect(clm.code).toBe(0);
      expect(clm.text).toContain("leaked=False");
      expect(clm.text).not.toContain("pi-sandbox-win:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
