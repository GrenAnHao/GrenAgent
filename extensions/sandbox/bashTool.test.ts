// 自有 bash 的契约测试：对外格式钉在 pi 1.0.2（dist/core/tools/bash.js），执行模型按 DSH tool-bash。
// 升级 pi 后这里红了，说明官方改了对外格式，要决定是否跟进。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import { jobs, __resetJobsForTest } from "../jobs/service.js";
import type { JobDoneInfo } from "../jobs/types.js";
import { jobLabel, processOutcome, type ExecFn } from "./bashJob.js";
import { BASH_PROMPT_SNIPPET, createGrenBashTool } from "./bashTool.js";

const tempDir = mkdtempSync(join(tmpdir(), "pi-bash-tool-test-"));

beforeEach(() => {
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});

/** 由测试驱动的假 exec：write 推输出，exit 结束；abort 时按 operations 的约定 reject "aborted"。 */
function scriptedExec() {
  let onData: ((data: Buffer) => void) | undefined;
  let settle: ((r: { exitCode: number | null }) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const calls: Array<{ command: string; options: Parameters<ExecFn>[2] }> = [];
  const exec = vi.fn<ExecFn>((command, _cwd, options) => {
    calls.push({ command, options });
    onData = options.onData;
    return new Promise<{ exitCode: number | null }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  return {
    exec,
    calls,
    write: (text: string) => onData?.(Buffer.from(text)),
    exit: (exitCode: number | null) => settle?.({ exitCode }),
    crash: (error: Error) => fail?.(error),
  };
}

const ctx = (sessionId = "s1") => ({
  cwd: tempDir,
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/sessions/s1.jsonl" },
  model: { provider: "deepseek", id: "deepseek-chat" },
});

type Result = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function tool(fake: ReturnType<typeof scriptedExec>, foregroundSec = 120) {
  return createGrenBashTool({ jobs, exec: fake.exec, foregroundTimeoutSec: () => foregroundSec, tempDir });
}

function run(
  t: ReturnType<typeof tool>,
  params: Record<string, unknown>,
  opts: { signal?: AbortSignal; onUpdate?: (u: unknown) => void; sessionId?: string } = {},
): Promise<Result> {
  return t.execute("call-1", params as never, opts.signal, opts.onUpdate as never, ctx(opts.sessionId) as never) as Promise<Result>;
}

/** 等假 exec 被调用（进程在 jobs.start 的 run() 里同步起，但 exec 是 async 的）。 */
async function started(fake: ReturnType<typeof scriptedExec>) {
  await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
}

describe("bash · schema and prompt (pi 1.0.2 contract)", () => {
  it("keeps name, command/timeout, the pi output schema, and strict-prefer sampling; adds run_in_background", () => {
    const t = tool(scriptedExec());
    expect(t.name).toBe("bash");
    const params = t.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(["command", "timeout", "run_in_background"]);
    expect(params.required).toEqual(["command"]);
    const out = t.outputSchema as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(out.properties)).toEqual(["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"]);
    expect(out.required).toEqual(["output", "truncated", "exit_code", "wall_time_seconds"]);
    expect(t.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(t.promptSnippet).toBe(BASH_PROMPT_SNIPPET);
    expect(t.promptGuidelines?.[0]).toBe("You can inspect PI_* environment variables for current model and session details.");
    expect(t.promptGuidelines?.[1]).toMatch(/^Use bash with run_in_background: true .*job_output.*job_kill/);
    expect(t.description).toContain("Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.");
  });

  it("rejects an invalid timeout with pi's message", async () => {
    await expect(run(tool(scriptedExec()), { command: "x", timeout: 0 })).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
  });
});

describe("bash · foreground results (pi 1.0.2 contract)", () => {
  it("success: tail text, structuredContent, streaming updates starting with empty content", async () => {
    const fake = scriptedExec();
    const updates: Array<{ content: Array<{ text: string }> }> = [];
    const pending = run(tool(fake), { command: "echo hi" }, { onUpdate: (u) => updates.push(u as never) });
    await started(fake);
    fake.write("hi\n");
    fake.exit(0);
    const r = await pending;
    expect(r.content).toEqual([{ type: "text", text: "hi\n" }]);
    expect(r.isError).toBeUndefined();
    expect(r.details).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ output: "hi\n", truncated: false, exit_code: 0 });
    expect(typeof r.structuredContent?.wall_time_seconds).toBe("number");
    expect(updates[0]).toEqual({ content: [], details: undefined });
    expect(updates.some((u) => u.content[0]?.text === "hi\n")).toBe(true);
  });

  it("the command is a job while it runs, and leaves with the result without a completion notice", async () => {
    const fake = scriptedExec();
    const settled: JobDoneInfo[] = [];
    jobs.onJobDone((_s, info) => settled.push(info));
    const pending = run(tool(fake), { command: "npm test" });
    await started(fake);
    expect(jobs.list("s1")).toMatchObject([{ id: "bash-1", kind: "bash", label: "npm test", status: "running" }]);
    fake.exit(0);
    await pending;
    expect(jobs.list("s1")).toEqual([]);
    expect(settled).toEqual([{ cause: "producer", awaited: true }]);
  });

  it("non-zero exit: isError with 'Command exited with code N'; empty output reads (no output)", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "false" });
    await started(fake);
    fake.exit(2);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe("(no output)\n\nCommand exited with code 2");
    expect(r.structuredContent).toMatchObject({ output: "", exit_code: 2 });
  });

  it("truncation names the full output file, which holds every byte", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "seq" });
    await started(fake);
    for (let i = 1; i <= 2100; i++) fake.write(`line ${i}\n`);
    fake.exit(0);
    const r = await pending;
    const text = r.content[0]?.text ?? "";
    expect(text).toMatch(/\n\n\[Showing lines 101-2100 of 2100\. Full output: .+\]$/);
    const path = r.details?.fullOutputPath as string;
    expect(text).toContain(path);
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(2101);
    expect(r.structuredContent).toMatchObject({ truncated: false, exit_code: 0 });
  });

  it("no exit code throws 'Command terminated without an exit code'", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "x" });
    await started(fake);
    fake.write("[sandbox: runner failed]\n");
    fake.exit(null);
    await expect(pending).rejects.toThrow("[sandbox: runner failed]\n\n\nCommand terminated without an exit code");
  });

  it("caller abort kills the process, throws 'Command aborted', and leaves no job", async () => {
    const fake = scriptedExec();
    const ac = new AbortController();
    const pending = run(tool(fake), { command: "sleep 60" }, { signal: ac.signal });
    await started(fake);
    fake.write("partial\n");
    ac.abort();
    await expect(pending).rejects.toThrow(/partial\n\n\nCommand aborted$|partial\n\nCommand aborted$/);
    expect(fake.calls[0]?.options.signal?.aborted).toBe(true);
    expect(jobs.list("s1")).toEqual([]);
  });

  it("a kill from outside the call (user, job_list + job_kill) tells the model the reason", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "sleep 60" });
    await started(fake);
    jobs.kill("bash-1", "s1", "cancelled by the user");
    await expect(pending).rejects.toThrow("Command stopped: cancelled by the user");
  });

  it("passes PI_* session facts and prefixes PATH with the pi bin dir", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "env" });
    await started(fake);
    fake.exit(0);
    await pending;
    const env = fake.calls[0]!.options.env!;
    expect(env).toMatchObject({ PI_SESSION_ID: "s1", PI_SESSION_FILE: "/sessions/s1.jsonl", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-chat" });
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path")!;
    expect(env[pathKey]).toMatch(/[\\/]bin/);
  });
});

describe("bash · foreground timeout moves the command to the background (DSH promoteOnTimeout)", () => {
  it("hands over the output so far and the job id; job_output continues after it; the finish notifies", async () => {
    const fake = scriptedExec();
    const notices: JobDoneInfo[] = [];
    jobs.onJobDone((_s, info) => notices.push(info));
    const pending = run(tool(fake), { command: "autoninja -C out chrome", timeout: 0.2 });
    await started(fake);
    fake.write("[1/5] CXX a.obj\n");
    await vi.waitFor(() => expect(jobs.snapshot("bash-1")?.ring.total).toBeGreaterThan(0));
    const r = await pending;
    const text = r.content[0]?.text ?? "";
    expect(text).toBe(
      "[1/5] CXX a.obj\n[still running after 0.2s; moved to background job bash-1]\n" +
        "The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.",
    );
    expect(r.isError).toBeUndefined();
    expect(r.details).toMatchObject({ promoted: true, jobId: "bash-1" });
    expect(typeof r.details?.jobStartedAt).toBe("number");
    expect(jobs.get("bash-1", "s1").status).toBe("running");

    fake.write("[5/5] LINK chrome.dll\n");
    fake.exit(0);
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.text).toBe("[5/5] LINK chrome.dll\n");
    expect(read.job.detail).toBe("exit code: 0");
    // 模型等到了结果：这次结算算 awaited；没等的话会发通知（见下一条）。
    expect(notices).toEqual([{ cause: "producer", awaited: true }]);
  });

  it("an unawaited promoted job notifies on completion", async () => {
    const fake = scriptedExec();
    const notices: JobDoneInfo[] = [];
    jobs.onJobDone((_s, info) => notices.push(info));
    const r = run(tool(fake), { command: "build", timeout: 0.1 });
    await started(fake);
    await r;
    fake.exit(1);
    await vi.waitFor(() => expect(notices).toEqual([{ cause: "producer", awaited: false }]));
    expect(jobs.get("bash-1", "s1")).toMatchObject({ status: "completed", detail: "exit code: 1" });
  });

  it("the configured default applies when the model gives no timeout", async () => {
    const fake = scriptedExec();
    const r = await (async () => {
      const pending = run(tool(fake, 0.1), { command: "build" });
      await started(fake);
      return pending;
    })();
    expect(r.content[0]?.text).toContain("[still running after 0.1s; moved to background job bash-1]");
    jobs.kill("bash-1", "s1");
  });
});

describe("bash · run_in_background", () => {
  it("returns the job id and an existing log path immediately", async () => {
    const fake = scriptedExec();
    const r = await run(tool(fake), { command: "npm run dev", run_in_background: true });
    expect(r.content[0]?.text).toMatch(/^started background job bash-1\nfull log: .+\nYou will be notified when it finishes; read newer output with job_output, stop it with job_kill\.$/);
    expect(r.details).toMatchObject({ background: true, jobId: "bash-1" });
    await started(fake);
    fake.write("ready on :3000\n");
    fake.exit(0);
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.text).toBe("ready on :3000\n");
    expect(readFileSync(r.details?.logPath as string, "utf8")).toBe("ready on :3000\n");
  });

  it("refuses without a session id", async () => {
    await expect(run(tool(scriptedExec()), { command: "x", run_in_background: true }, { sessionId: "" })).rejects.toThrow(/needs a session/);
  });
});

describe("bash · unmanaged fallback (no session, or admission refused)", () => {
  it("without a session the command runs like pi's original: the timeout kills it", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "x", timeout: 5 }, { sessionId: "" });
    await started(fake);
    expect(fake.calls[0]?.options.timeout).toBe(5);
    fake.crash(new Error("timeout:5"));
    await expect(pending).rejects.toThrow("Command timed out after 5 seconds");
    expect(jobs.list("")).toEqual([]);
  });

  it("past the per-owner job limit the command still runs, unmanaged", async () => {
    jobs.configure({ maxConcurrentJobsPerOwner: 1, pumpPollMs: 5 });
    const holder = scriptedExec();
    await run(tool(holder), { command: "server", run_in_background: true });
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "echo ok" });
    await started(fake);
    fake.write("ok\n");
    fake.exit(0);
    expect((await pending).content[0]?.text).toBe("ok\n");
    expect(jobs.list("s1").map((j) => j.id)).toEqual(["bash-1"]);
    jobs.kill("bash-1", "s1");
  });
});

describe("bash job helpers", () => {
  it("processOutcome: non-zero exit is completed; abort is killed; no exit code or a throw is failed", () => {
    expect(processOutcome({ kind: "exited", exitCode: 0 })).toEqual({ status: "completed", detail: "exit code: 0" });
    expect(processOutcome({ kind: "exited", exitCode: 3 })).toEqual({ status: "completed", detail: "exit code: 3" });
    expect(processOutcome({ kind: "aborted" })).toEqual({ status: "killed", detail: "killed before exit" });
    expect(processOutcome({ kind: "exited", exitCode: null }).status).toBe("failed");
    expect(processOutcome({ kind: "error", error: new Error("spawn ENOENT") })).toEqual({ status: "failed", detail: "spawn ENOENT" });
  });

  it("jobLabel flattens whitespace and caps length", () => {
    expect(jobLabel("cd x;\n  autoninja -C out\\Default chrome")).toBe("cd x; autoninja -C out\\Default chrome");
    expect(jobLabel("x".repeat(500))).toHaveLength(160);
  });
});

describe("bash on a real shell", () => {
  const win = process.platform === "win32";
  const ops = createSandboxedBashOperations({
    getPolicy: () => ({ mode: "danger-full-access", network: "enabled", workspaceRoot: tempDir, sessionId: "real" }),
    confine: async () => {
      throw new Error("unconfined policy must not confine");
    },
    resolveShell: () => (win ? "powershell.exe" : "/bin/sh"),
  });
  const real = () => createGrenBashTool({ jobs, exec: ops.exec, tempDir });

  it("a slow command moves to the background with its first line, then finishes there", async () => {
    const command = win
      ? "Write-Output first; Start-Sleep -Milliseconds 2500; Write-Output second"
      : "printf 'first\\n'; sleep 2.5; printf 'second\\n'";
    const r = await run(real(), { command, timeout: 1.2 });
    const handed = r.content[0]?.text ?? "";
    // 负载高时 PowerShell 启动就可能超过 1.2s，转后台时未必已有 first：只断言交接不重不漏。
    expect(handed).toMatch(/(^|\n)\[still running after 1\.2s; moved to background job bash-1\]\n/);
    const before = handed.slice(0, handed.indexOf("[still running"));
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 15_000 });
    expect(read.status).toBe("completed");
    expect(read.job.detail).toBe("exit code: 0");
    const all = `${before}${read.text}`;
    expect(all.match(/first/g)).toHaveLength(1);
    expect(all.match(/second/g)).toHaveLength(1);
    expect(all.indexOf("first")).toBeLessThan(all.indexOf("second"));
  }, 30_000);

  it("a fast command returns in the foreground with exit code and output", async () => {
    const command = win ? "Write-Output hello; exit 3" : "printf 'hello\\n'; exit 3";
    const r = await run(real(), { command });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^hello\r?\n\n\nCommand exited with code 3$|^hello\r?\n\nCommand exited with code 3$/);
    expect(jobs.list("s1")).toEqual([]);
  }, 30_000);

  it("job_kill stops a background command", async () => {
    const command = win ? "Start-Sleep -Seconds 60" : "sleep 60";
    await run(real(), { command, run_in_background: true });
    await new Promise((r) => setTimeout(r, 500));
    jobs.kill("bash-1", "s1", "test cleanup");
    const settled = await jobs.wait("bash-1", 15_000, "s1");
    expect(settled).toMatchObject({ status: "killed", detail: "killed before exit; test cleanup" });
  }, 30_000);
});
