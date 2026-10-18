// 自有 bash 的契约测试：对外格式钉在 pi 1.0.2（dist/core/tools/bash.js），执行模型按 DSH tool-bash。
// 升级 pi 后这里红了，说明官方改了对外格式，要决定是否跟进。
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEscalationGrantsForTest, grantEscalation, takeEscalationGrant } from "../_shared/sandbox/escalationGrant.js";
import { escalationHintMarker, runnerFailedMarker, sandboxDenialMarker } from "../_shared/sandbox/facts.js";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import type { FileSandboxMode, SandboxRunFacts } from "../_shared/sandbox/types.js";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { __resetApprovalRoutesForTest, registerChildApprovalRoute, registerTopApprovalRoute } from "../_shared/approval-route.js";
import { jobs, __resetJobsForTest } from "../jobs/service.js";
import type { JobDoneInfo } from "../jobs/types.js";
import { jobLabel, processOutcome, type ExecFn } from "./bashJob.js";
import { BASH_PROMPT_SNIPPET, createGrenBashTool, type GrenBashDeps } from "./bashTool.js";
import { ESCALATION_GUIDELINE, type SandboxGate } from "./escalation.js";

const tempDir = mkdtempSync(join(tmpdir(), "pi-bash-tool-test-"));

beforeEach(() => {
  // 子代理里跑测试会继承 PI_IS_SUBAGENT=1，bash 会把审批通道判成没有。
  delete process.env.PI_IS_SUBAGENT;
  __resetEscalationGrantsForTest();
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});

/** 由测试驱动的假 exec：write 推输出，exit 结束（可带沙箱事实）；abort 时按 operations 的约定 reject "aborted"。 */
function scriptedExec() {
  let onData: ((data: Buffer) => void) | undefined;
  let settle: ((r: { exitCode: number | null; sandbox?: SandboxRunFacts }) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const calls: Array<{ command: string; options: Parameters<ExecFn>[2] }> = [];
  const exec = vi.fn<ExecFn>((command, _cwd, options) => {
    calls.push({ command, options });
    onData = options.onData;
    return new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  return {
    exec,
    calls,
    write: (text: string) => onData?.(Buffer.from(text)),
    exit: (exitCode: number | null, sandbox?: SandboxRunFacts) => settle?.({ exitCode, ...(sandbox ? { sandbox } : {}) }),
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

function tool(fake: ReturnType<typeof scriptedExec>, foregroundSec = 120, extra: Partial<GrenBashDeps> = {}) {
  return createGrenBashTool({ jobs, exec: fake.exec, foregroundTimeoutSec: () => foregroundSec, tempDir, ...extra });
}

function run(
  t: ReturnType<typeof tool>,
  params: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    onUpdate?: (u: unknown) => void;
    sessionId?: string;
    ctx?: Record<string, unknown>;
    callId?: string;
  } = {},
): Promise<Result> {
  const c = { ...ctx(opts.sessionId), ...opts.ctx };
  return t.execute(opts.callId ?? "call-1", params as never, opts.signal, opts.onUpdate as never, c as never) as Promise<Result>;
}

/** 等假 exec 被调用（进程在 jobs.start 的 run() 里同步起，但 exec 是 async 的）。 */
async function started(fake: ReturnType<typeof scriptedExec>) {
  await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
}

describe("bash · schema and prompt (pi 1.0.2 contract)", () => {
  it("keeps name, command/timeout, the pi output schema, and strict-prefer sampling; adds run_in_background and the escalation pair", () => {
    const t = tool(scriptedExec());
    expect(t.name).toBe("bash");
    const params = t.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(["command", "timeout", "run_in_background", "sandbox_permissions", "justification"]);
    expect(params.required).toEqual(["command"]);
    const out = t.outputSchema as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(out.properties)).toEqual(["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"]);
    expect(out.required).toEqual(["output", "truncated", "exit_code", "wall_time_seconds"]);
    expect(t.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
    expect(t.promptSnippet).toBe(BASH_PROMPT_SNIPPET);
    expect(t.promptGuidelines?.[0]).toBe("You can inspect PI_* environment variables for current model and session details.");
    expect(t.promptGuidelines?.[1]).toMatch(/^Use bash with run_in_background: true .*job_output.*job_kill/);
    expect(t.promptGuidelines?.[2]).toBe(ESCALATION_GUIDELINE);
    const sp = params.properties.sandbox_permissions as { anyOf?: Array<{ const?: string }> };
    expect(sp.anyOf?.map((s) => s.const)).toEqual(["workspace-write", "danger-full-access"]);
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

  it("anonymous pipe: running updates carry the job ref for the UI only; the settled result stays anonymous", async () => {
    const fake = scriptedExec();
    const updates: Array<{ content: Array<{ text: string }>; details?: Record<string, unknown> }> = [];
    const pending = run(tool(fake), { command: "npm test" }, { onUpdate: (u) => updates.push(u as never) });
    await started(fake);
    // job 一起来界面就能拿到引用，不用等第一块输出。
    await vi.waitFor(() => expect(updates.some((u) => u.details?.foregroundJob)).toBe(true));
    const ref = updates.find((u) => u.details?.foregroundJob)?.details?.foregroundJob as { jobId: string; jobStartedAt: number };
    expect(ref.jobId).toBe("bash-1");
    expect(ref.jobStartedAt).toBe(jobs.snapshot("bash-1")?.startedAt);

    // partial 每次整体替换 result，后续输出更新也要带着它，否则界面会丢掉引用。
    fake.write("hello\n");
    await vi.waitFor(() => expect(updates.some((u) => u.content[0]?.text === "hello\n" && u.details?.foregroundJob)).toBe(true));

    fake.exit(0);
    const r = await pending;
    // 模型看到的是最终结果：没有 id，记录随调用离开。
    expect(r.details).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("bash-1");
    expect(jobs.list("s1")).toEqual([]);
  });

  it("a command that is not a job (admission refused) emits updates without a job ref", async () => {
    jobs.configure({ maxConcurrentJobsPerOwner: 0 });
    const fake = scriptedExec();
    const updates: Array<{ details?: Record<string, unknown> }> = [];
    const pending = run(tool(fake), { command: "echo hi" }, { onUpdate: (u) => updates.push(u as never) });
    await started(fake);
    fake.write("hi\n");
    fake.exit(0);
    await pending;
    expect(updates.some((u) => u.details?.foregroundJob)).toBe(false);
  });

  it("stopping the anonymous job from the UI ends only this command and tells the model why", async () => {
    const fake = scriptedExec();
    const updates: Array<{ details?: Record<string, unknown> }> = [];
    const pending = run(tool(fake), { command: "sleep 600" }, { onUpdate: (u) => updates.push(u as never) });
    await started(fake);
    await vi.waitFor(() => expect(updates.some((u) => u.details?.foregroundJob)).toBe(true));
    const ref = updates.find((u) => u.details?.foregroundJob)?.details?.foregroundJob as { jobId: string };
    // 界面上点「停止」走 killJobForUser：原因记为 cancelled by the user。
    jobs.kill(ref.jobId, "s1", "cancelled by the user");
    await expect(pending).rejects.toThrow(/Command stopped: cancelled by the user/);
    expect(jobs.list("s1")).toEqual([]);
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
    fake.write("Killed\n");
    fake.exit(null);
    await expect(pending).rejects.toThrow("Killed\n\n\nCommand terminated without an exit code");
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

  it("processOutcome: a sandbox denial stays completed and carries the marker, plus the hint when on offer", () => {
    const exit = { kind: "exited" as const, exitCode: 1, sandbox: { mode: "read-only" as const, denied: true } };
    expect(processOutcome(exit, () => true)).toEqual({
      status: "completed",
      detail: `exit code: 1; ${sandboxDenialMarker("read-only")} ${escalationHintMarker()}`,
    });
    expect(processOutcome(exit)).toEqual({ status: "completed", detail: `exit code: 1; ${sandboxDenialMarker("read-only")}` });
  });

  it("processOutcome: a runner failure is failed with the runner marker and reason, never a hint", () => {
    const exit = {
      kind: "exited" as const,
      exitCode: null,
      sandbox: { mode: "read-only" as const, denied: false, runnerFailed: "unavailable" as const, detail: "runner missing" },
    };
    expect(processOutcome(exit, () => true)).toEqual({
      status: "failed",
      detail: `${runnerFailedMarker("read-only")} runner missing`,
    });
  });

  it("processOutcome: a clean run with facts reads as before", () => {
    expect(
      processOutcome({ kind: "exited", exitCode: 0, sandbox: { mode: "workspace-write", denied: false } }, () => true),
    ).toEqual({ status: "completed", detail: "exit code: 0" });
  });

  it("jobLabel flattens whitespace and caps length", () => {
    expect(jobLabel("cd x;\n  autoninja -C out\\Default chrome")).toBe("cd x; autoninja -C out\\Default chrome");
    expect(jobLabel("x".repeat(500))).toHaveLength(160);
  });
});

describe("bash · sandbox facts in the foreground (DSH tool-pwsh rendering)", () => {
  const READ_ONLY: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const withUi = { hasUI: true, ui: { select: vi.fn() } };

  it("a denial: marker and hint after the output, the exit status last; facts for the UI; structured result kept", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x" }, { ctx: withUi });
    await started(fake);
    fake.write("touch: x: Read-only file system\n");
    fake.exit(1, { mode: "read-only", denied: true });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      `touch: x: Read-only file system\n\n\n${sandboxDenialMarker("read-only")}\n${escalationHintMarker()}\n\nCommand exited with code 1`,
    );
    expect(r.details).toEqual({ sandbox: { mode: "read-only", denied: true } });
    expect(r.structuredContent).toMatchObject({ output: "touch: x: Read-only file system\n", exit_code: 1 });
  });

  it("a denial after truncated output: truncation note, then sandbox notes, then the exit status; details keep both", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "seq" }, { ctx: withUi });
    await started(fake);
    for (let i = 1; i <= 2100; i++) fake.write(`line ${i}\n`);
    fake.exit(1, { mode: "read-only", denied: true });
    const r = await pending;
    const text = r.content[0]?.text ?? "";
    const fullAt = text.indexOf("Full output: ");
    const markerAt = text.indexOf(sandboxDenialMarker("read-only"));
    const statusAt = text.indexOf("Command exited with code 1");
    expect(fullAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(fullAt);
    expect(statusAt).toBeGreaterThan(markerAt);
    expect(text.endsWith(`${sandboxDenialMarker("read-only")}\n${escalationHintMarker()}\n\nCommand exited with code 1`)).toBe(true);
    expect(r.details).toMatchObject({ truncation: { truncated: true }, sandbox: { mode: "read-only", denied: true } });
    expect(typeof r.details?.fullOutputPath).toBe("string");
  });

  it.each([
    ["the preset blocks escalation", { mode: "workspace-write", presetBlocksEscalation: true } as SandboxGate, withUi, "workspace-write"],
    ["there is no approval channel", READ_ONLY, { hasUI: false }, "read-only"],
    ["no sandbox gate is configured", undefined, withUi, "read-only"],
  ] as const)("no escalation hint when %s", async (_name, gate, extraCtx, mode) => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, gate ? { sandboxGate: () => gate } : {}), { command: "touch x" }, { ctx: extraCtx });
    await started(fake);
    fake.exit(1, { mode: mode as FileSandboxMode, denied: true });
    const text = (await pending).content[0]?.text ?? "";
    expect(text).toContain(sandboxDenialMarker(mode as FileSandboxMode));
    expect(text).not.toContain(escalationHintMarker());
  });

  it("a goal turn has no one to approve, so no hint", async () => {
    const fake = scriptedExec();
    const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
    const pending = runInWorkspace({ origin: "goal", workspace: tempDir, cwd: tempDir, config: {} }, () =>
      run(t, { command: "touch x" }, { ctx: withUi }),
    );
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const text = (await pending).content[0]?.text ?? "";
    expect(text).toContain(sandboxDenialMarker("read-only"));
    expect(text).not.toContain(escalationHintMarker());
  });

  it("a runner failure: isError, the runner marker and reason instead of an exit status, no structured result", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "echo hi" }, { ctx: withUi });
    await started(fake);
    fake.exit(null, { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(`${runnerFailedMarker("read-only")}\nrunner missing`);
    expect(r.structuredContent).toBeUndefined();
    expect(r.details).toEqual({
      sandbox: { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" },
    });
  });

  it("a clean run with facts has no notes and no details (pi contract)", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "echo hi" }, { ctx: withUi });
    await started(fake);
    fake.write("hi\n");
    fake.exit(0, { mode: "read-only", denied: false });
    const r = await pending;
    expect(r.content).toEqual([{ type: "text", text: "hi\n" }]);
    expect(r.details).toBeUndefined();
  });

  it("the unmanaged fallback renders facts too", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x" }, { sessionId: "", ctx: withUi });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const r = await pending;
    expect(r.content[0]?.text).toContain(sandboxDenialMarker("read-only"));
    expect(r.details).toEqual({ sandbox: { mode: "read-only", denied: true } });
  });
});

describe("bash · same-call escalation (DSH sandbox_permissions)", () => {
  const READ_ONLY: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const JUSTIFY = "需要把构建产物写进工作区";
  const ask = (answer: string | undefined) => ({ hasUI: true, ui: { select: vi.fn(async () => answer) } });
  const widen = (command: string, extra: Record<string, unknown> = {}) => ({
    command,
    sandbox_permissions: "workspace-write",
    justification: JUSTIFY,
    ...extra,
  });

  it("asks, then runs this one call widened through the normal job path", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("npm run build"), { ctx: c });
    await started(fake);
    expect(c.ui.select).toHaveBeenCalledWith(
      `沙箱升权\n\nnpm run build\n\n${JUSTIFY}\n\n→ workspace-write`,
      ["允许本次", "拒绝"],
      undefined,
    );
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
    // 和普通命令一样是 job：可见、可停。
    expect(jobs.list("s1")).toMatchObject([{ id: "bash-1", status: "running" }]);
    fake.write("built\n");
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toBe("built\n");
    expect(r.details).toEqual({ sandbox: { mode: "workspace-write", denied: false, escalatedFrom: "read-only" } });
  });

  it("output beyond the limit is truncated like any other command", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("seq"), { ctx: ask("允许本次") });
    await started(fake);
    for (let i = 1; i <= 2100; i++) fake.write(`line ${i}\n`);
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(r.content[0]?.text).toMatch(/\[Showing lines 101-2100 of 2100\. Full output: .+\]$/);
    expect(r.details).toMatchObject({ sandbox: { escalatedFrom: "read-only" } });
  });

  it("an approved escalation that did not widen at execution is not reported as escalated", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("echo hi"), { ctx: ask("允许本次") });
    await started(fake);
    // exec 按自己的策略没有放宽：事实里的模式还是起步的 read-only。
    fake.exit(0, { mode: "read-only", denied: false });
    const r = await pending;
    expect(r.details).toBeUndefined();
  });

  it("a widened run that is still denied reports the widened mode", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch ../x"), { ctx: ask("允许本次") });
    await started(fake);
    fake.exit(1, { mode: "workspace-write", denied: true });
    const r = await pending;
    expect(r.details).toEqual({ sandbox: { mode: "workspace-write", denied: true, escalatedFrom: "read-only" } });
    expect(r.content[0]?.text).toContain(`${sandboxDenialMarker("workspace-write")}\n${escalationHintMarker()}`);
  });

  it.each([
    ["the user rejects", "拒绝", 'the user rejected escalating this command to "workspace-write"; it stays denied, so stop and explain instead of working around it'],
    ["the prompt is dismissed", undefined, 'approval for escalating to "workspace-write" was cancelled'],
  ] as const)("nothing runs when %s", async (_name, answer, message) => {
    const fake = scriptedExec();
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), { ctx: ask(answer) }),
    ).rejects.toThrow(message);
    expect(fake.exec).not.toHaveBeenCalled();
    expect(jobs.list("s1")).toEqual([]);
  });

  it.each([
    [{ sandbox_permissions: "workspace-write" }, "requires a justification"],
    [{ sandbox_permissions: "workspace-write", justification: "  " }, "expected a non-empty sentence"],
    [{ justification: JUSTIFY }, "only valid together with sandbox_permissions"],
  ])("malformed escalation %j fails before asking", async (extra, message) => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x", ...extra }, { ctx: c }),
    ).rejects.toThrow(message);
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("asking for the current mode runs normally without a prompt", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const gate: SandboxGate = { mode: "workspace-write", presetBlocksEscalation: false };
    const pending = run(tool(fake, 120, { sandboxGate: () => gate }), widen("echo hi"), { ctx: c });
    await started(fake);
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
    expect(r.details).toBeUndefined();
  });

  it("a safety pre-approval for this call is used instead of a second prompt", async () => {
    const fake = scriptedExec();
    const c = ask("拒绝");
    grantEscalation("s1", "call-7", "workspace-write");
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), { ctx: c, callId: "call-7" });
    await started(fake);
    fake.exit(0, { mode: "workspace-write", denied: false });
    await pending;
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
  });

  it("a safety grant is spent even when a later check fails, so it cannot leak to another call", async () => {
    const fake = scriptedExec();
    grantEscalation("s1", "call-8", "workspace-write");
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x", { timeout: 0 }), {
        ctx: ask("允许本次"),
        callId: "call-8",
      }),
    ).rejects.toThrow("Invalid timeout");
    expect(takeEscalationGrant("s1", "call-8", "workspace-write")).toBe(false);
  });

  it("aborting while the approval prompt is open runs nothing", async () => {
    const fake = scriptedExec();
    const ac = new AbortController();
    const select = vi.fn(
      (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), {
      ctx: { hasUI: true, ui: { select } },
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(select).toHaveBeenCalled());
    expect(select.mock.calls[0]?.[2]).toEqual({ signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow('approval for escalating to "workspace-write" was cancelled');
    expect(fake.exec).not.toHaveBeenCalled();
    expect(jobs.list("s1")).toEqual([]);
  });

  it("an already-aborted call does not open the approval prompt", async () => {
    const fake = scriptedExec();
    const ac = new AbortController();
    ac.abort();
    const c = ask("允许本次");
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), { ctx: c, signal: ac.signal }),
    ).rejects.toThrow("Command aborted");
    expect(c.ui.select).not.toHaveBeenCalled();
  });

  it("a goal turn cannot escalate", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
    await expect(
      runInWorkspace({ origin: "goal", workspace: tempDir, cwd: tempDir, config: {} }, () =>
        run(t, widen("touch x"), { ctx: c }),
      ),
    ).rejects.toThrow("no approval channel is available");
    expect(c.ui.select).not.toHaveBeenCalled();
  });

  it("a subagent with a route to its parent window asks there, then runs widened", async () => {
    __resetApprovalRoutesForTest();
    const parentSelect = vi.fn<(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>>(async () => "允许本次");
    registerTopApprovalRoute("/sessions/top.jsonl", { select: parentSelect });
    registerChildApprovalRoute({
      sessionPath: "/sessions/s1.jsonl",
      parentSessionPath: "/sessions/top.jsonl",
      agentId: "sa-1",
      label: "build",
    });
    try {
      const fake = scriptedExec();
      const c = ask("拒绝");
      const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
      const pending = runInWorkspace({ origin: "subagent", workspace: tempDir, cwd: tempDir, config: {} }, () =>
        run(t, widen("npm run build"), { ctx: c }),
      );
      await started(fake);
      expect(parentSelect.mock.calls[0]?.[0]).toBe(`子代理 build（sa-1） 沙箱升权\n\nnpm run build\n\n${JUSTIFY}\n\n→ workspace-write`);
      expect(c.ui.select).not.toHaveBeenCalled();
      expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
      fake.exit(0, { mode: "workspace-write", denied: false });
      await pending;
    } finally {
      __resetApprovalRoutesForTest();
    }
  });

  it("a subagent without a route still cannot escalate", async () => {
    __resetApprovalRoutesForTest();
    const fake = scriptedExec();
    const c = ask("允许本次");
    const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
    await expect(
      runInWorkspace({ origin: "subagent", workspace: tempDir, cwd: tempDir, config: {} }, () =>
        run(t, widen("touch x"), { ctx: c }),
      ),
    ).rejects.toThrow("no approval channel is available");
    expect(c.ui.select).not.toHaveBeenCalled();
  });

  it("a background escalation asks first, then starts the job widened", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const r = await run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("npm run dev", { run_in_background: true }), {
      ctx: c,
    });
    expect(r.details).toMatchObject({ background: true, jobId: "bash-1" });
    await started(fake);
    expect(c.ui.select).toHaveBeenCalledTimes(1);
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
    jobs.kill("bash-1", "s1");
  });

  it("the host environment cannot widen a call on its own", async () => {
    process.env.PI_SANDBOX_MODE_ONCE = "danger-full-access";
    try {
      const fake = scriptedExec();
      const pending = run(tool(fake), { command: "echo hi" });
      await started(fake);
      fake.exit(0);
      await pending;
      expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
    } finally {
      delete process.env.PI_SANDBOX_MODE_ONCE;
    }
  });
});

describe("bash · sandbox facts in background jobs", () => {
  it("a denied background job's detail carries the hint when escalation is on offer", async () => {
    const fake = scriptedExec();
    const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
    await run(tool(fake, 120, { sandboxGate: () => gate }), { command: "touch x", run_in_background: true }, {
      ctx: { hasUI: true, ui: { select: vi.fn() } },
    });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.job.detail).toBe(`exit code: 1; ${sandboxDenialMarker("read-only")} ${escalationHintMarker()}`);
  });

  it("a denied background job settles completed with the marker in its detail", async () => {
    const fake = scriptedExec();
    await run(tool(fake), { command: "touch x", run_in_background: true });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.status).toBe("completed");
    expect(read.job.detail).toBe(`exit code: 1; ${sandboxDenialMarker("read-only")}`);
  });

  it("a background job whose sandbox never started settles failed with the runner marker", async () => {
    const fake = scriptedExec();
    await run(tool(fake), { command: "echo hi", run_in_background: true });
    await started(fake);
    fake.exit(null, { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.status).toBe("failed");
    expect(read.job.detail).toBe(`${runnerFailedMarker("read-only")} runner missing`);
  });
});

describe("bash on a real shell", () => {
  const win = process.platform === "win32";
  const ops = createSandboxedBashOperations({
    getPolicy: () => ({ mode: "danger-full-access", network: "enabled", workspaceRoot: tempDir, sessionId: "real" }),
    confine: async () => {
      throw new Error("unconfined policy must not confine");
    },
    // Windows 上照 pi 解析 Git Bash（settings.json 的 shellPath，或默认位置）。
    shellPath: () => (win ? SettingsManager.create(process.cwd(), getAgentDir()).getShellPath() : undefined),
    ...(win ? {} : { resolveShell: () => "/bin/sh" }),
  });
  const real = () => createGrenBashTool({ jobs, exec: ops.exec, tempDir });

  it("a slow command moves to the background with its first line, then finishes there", async () => {
    const command = "printf 'first\\n'; sleep 2.5; printf 'second\\n'";
    const r = await run(real(), { command, timeout: 1.2 });
    const handed = r.content[0]?.text ?? "";
    // 负载高时壳启动就可能超过 1.2s，转后台时未必已有 first：只断言交接不重不漏。
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
    const command = "printf 'hello\\n'; exit 3";
    const r = await run(real(), { command });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^hello\r?\n\n\nCommand exited with code 3$|^hello\r?\n\nCommand exited with code 3$/);
    expect(jobs.list("s1")).toEqual([]);
  }, 30_000);

  it("job_kill stops a background command", async () => {
    const command = "echo started; sleep 60";
    await run(real(), { command, run_in_background: true });
    // 等命令真的跑起来再停：停得太早时 Git Bash 的包装还没拉起 bash，进程要靠停止后几秒的补刀收掉，测试进程等不到那时。
    await vi.waitFor(async () => {
      expect((await jobs.read("bash-1", "s1", {})).text).toContain("started");
    }, { timeout: 15_000, interval: 100 });
    jobs.kill("bash-1", "s1", "test cleanup");
    const settled = await jobs.wait("bash-1", 15_000, "s1");
    expect(settled).toMatchObject({ status: "killed", detail: "killed before exit; test cleanup" });
    if (win) {
      // Git Bash 的子进程不在 Windows 父进程链上，要靠 msys 进程组 kill 收掉：等它们真的没了（测试进程退出会带走还在路上的 kill）。
      const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const alive = () => Number(execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command",
        "@(Get-CimInstance Win32_Process -Filter \"Name='sleep.exe' or Name='bash.exe'\" | Where-Object { $_.CommandLine -like '*echo started; sleep 60*' -or $_.CommandLine -match 'sleep(\\.exe)?\"?\\s+60\\s*$' }).Count"], { encoding: "utf8" }).trim()) || 0;
      await vi.waitFor(() => expect(alive()).toBe(0), { timeout: 10_000, interval: 300 });
    }
  }, 30_000);
});
