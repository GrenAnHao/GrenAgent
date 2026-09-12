import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxUnavailableError } from "./errors.js";
import { createSandboxedBashOperations } from "./operations.js";
import {
  consumePendingDenial,
  __resetPendingDenialsForTest,
} from "./pendingDenial.js";
import type { ConfinedArgv, FileSandboxMode, SandboxExecutionPolicy } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";

afterEach(() => {
  __resetPendingDenialsForTest();
});

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
  stdout?: string;
  stderr?: string;
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
    resolveShell: async () => SHELL,
    platform: opts.platform,
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

  it("does not spawn when confine throws SandboxUnavailableError", async () => {
    const { ops, spawnImpl } = makeOps({
      confine: vi.fn(async () => {
        throw new SandboxUnavailableError("runner missing");
      }),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(text()).toMatch(/UNAVAILABLE/);
    expect(text()).toMatch(/Enable the OS runner or switch approval to 完全权限/);
  });

  it("records a pending denial with sessionId on exit 162", async () => {
    const sessionId = "deny-session";
    const { ops } = makeOps({
      mode: "read-only",
      sessionId,
      spawnImpl: vi.fn(() => fakeChild({ exitCode: SANDBOX_DENIAL_EXIT })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result.exitCode).toBe(SANDBOX_DENIAL_EXIT);
    expect(text()).toContain(`[sandbox: file access denied under read-only mode]`);
    expect(text()).toMatch(/bash_escalate/);
    expect(consumePendingDenial(CWD, COMMAND, sessionId)).toEqual({ mode: "read-only" });
    expect(consumePendingDenial(CWD, COMMAND)).toBeUndefined();
  });

  it("records a pending denial from stderr Read-only file system on exit 1", async () => {
    const sessionId = "ro-session";
    const { ops } = makeOps({
      mode: "read-only",
      sessionId,
      spawnImpl: vi.fn(() => fakeChild({
        exitCode: 1,
        stderr: "touch: foo: Read-only file system\n",
      })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result.exitCode).toBe(1);
    expect(text()).toContain(`[sandbox: file access denied under read-only mode]`);
    expect(text()).toMatch(/bash_escalate/);
    expect(consumePendingDenial(CWD, COMMAND, sessionId)).toEqual({ mode: "read-only" });
  });

  it("does not treat the same denial phrase on stdout as a denial", async () => {
    const sessionId = "stdout-echo";
    const { ops } = makeOps({
      mode: "read-only",
      sessionId,
      spawnImpl: vi.fn(() => fakeChild({
        exitCode: 1,
        stdout: "Read-only file system\n",
      })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result.exitCode).toBe(1);
    expect(text()).not.toMatch(/bash_escalate/);
    expect(consumePendingDenial(CWD, COMMAND, sessionId)).toBeUndefined();
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
    await ops.exec(COMMAND, CWD, { onData, env });
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

  it("writes spawnError and attributes runner-failure", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops } = makeOps({
      spawnImpl: vi.fn(() => fakeChild({ spawnError: err })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result.exitCode).toBeNull();
    expect(text()).toContain("[sandbox: runner failed] The command never started.");
  });

  it("reports runner-failure for spawnError without confine", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops, confine } = makeOps({
      mode: "danger-full-access",
      spawnImpl: vi.fn(() => fakeChild({ spawnError: err })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(text()).toContain("[sandbox: runner failed] The command never started.");
  });
});
