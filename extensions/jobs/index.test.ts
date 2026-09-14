import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(() => undefined) }));

import jobsExtension, { __resetJobsOwnersForTest } from "./index.js";
import { jobs, __resetJobsForTest } from "./service.js";
import { getConfig } from "../_shared/runtime-config.js";

type Execute = (id: string, params: Record<string, unknown>, s: null, u: null, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
type Handler = (event: unknown, ctx: unknown) => unknown;

function harness() {
  const tools: Record<string, Execute> = {};
  const handlers: Record<string, Handler> = {};
  const sendMessage = vi.fn();
  const pi = {
    registerTool: (t: { name: string; execute: Execute }) => { tools[t.name] = t.execute; },
    on: (ev: string, h: Handler) => { handlers[ev] = h; },
    sendMessage,
  };
  jobsExtension(pi as never);
  return { tools, handlers, sendMessage };
}

function sessionCtx(sessionId: string, idle = true) {
  return { cwd: "/ws", isIdle: () => idle, sessionManager: { getSessionId: () => sessionId } };
}

function startFor(owner: string) {
  let resolve!: (o: { status: "completed"; output: string }) => void;
  const done = new Promise<{ status: "completed"; output: string }>((r) => (resolve = r));
  const id = jobs.start({ kind: "subagent", label: "L", owner, workspace: "/ws", run: () => ({ cancel: () => {}, done }) });
  return { id, resolve };
}

beforeEach(() => {
  __resetJobsForTest();
  __resetJobsOwnersForTest();
});

describe("jobs extension · tools", () => {
  it("job_output returns [status] and output; job_list lists own; job_kill requests", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1"));
    const { id, resolve } = startFor("s1");
    expect((await h.tools.job_output("t", { job_id: id }, null, null, sessionCtx("s1"))).content[0].text).toBe("[status: running]");
    expect((await h.tools.job_list("t", {}, null, null, sessionCtx("s1"))).content[0].text).toContain(id);
    expect((await h.tools.job_kill("t", { job_id: id, reason: "r" }, null, null, sessionCtx("s1"))).content[0].text).toBe(`cancellation requested for job ${id}`);
    resolve({ status: "completed", output: "out" });
    const r = await h.tools.job_output("t", { job_id: id, wait: true, timeout_ms: 100 }, null, null, sessionCtx("s1"));
    expect(r.content[0].text).toBe("[status: completed]\nout");
    expect((await h.tools.job_kill("t", { job_id: id }, null, null, sessionCtx("s1"))).content[0].text).toContain("had already finished");
  });

  it("non-owner gets isError with the ownership message", async () => {
    const h = harness();
    const { id } = startFor("s1");
    const r = await h.tools.job_output("t", { job_id: id }, null, null, sessionCtx("s2"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`job ${id} 不属于当前会话`);
  });

  it("timeout_ms is capped by JOBS_WAIT_MAX_MS", async () => {
    vi.mocked(getConfig).mockImplementation((key: string) => (key === "JOBS_WAIT_MAX_MS" ? "50" : undefined));
    const h = harness();
    const { id } = startFor("s1");
    const t0 = Date.now();
    await h.tools.job_output("t", { job_id: id, wait: true, timeout_ms: 999999 }, null, null, sessionCtx("s1"));
    expect(Date.now() - t0).toBeLessThan(5000);
    vi.mocked(getConfig).mockImplementation(() => undefined);
  }, 10000);
});

describe("jobs extension · notice delivery", () => {
  it("busy owner → steer without triggerTurn", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1", false));
    const { resolve } = startFor("s1");
    resolve({ status: "completed", output: "o" });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
    const [msg, opts] = h.sendMessage.mock.calls[0];
    expect(msg).toMatchObject({ customType: "job-done", display: true, details: { jobId: "subagent-1", kind: "subagent", status: "completed" } });
    expect(msg.content.split("\n")[0]).toBe("Background job subagent-1 (subagent: L) finished completed.");
    expect(opts).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("idle owner → wake up to JOBS_WAKE_BUDGET times, then inject only; input resets", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1", true));
    for (let i = 0; i < 4; i++) startFor("s1").resolve({ status: "completed", output: String(i) });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(4));
    const optsList = h.sendMessage.mock.calls.map((c) => c[1]);
    expect(optsList.slice(0, 3)).toEqual(Array(3).fill({ triggerTurn: true, deliverAs: "followUp" }));
    expect(optsList[3]).toEqual({ triggerTurn: false });
    await h.handlers.input({ type: "input", text: "hi", source: "interactive" }, sessionCtx("s1"));
    startFor("s1").resolve({ status: "completed", output: "again" });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(5));
    expect(h.sendMessage.mock.calls[4][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("owner not attached → nothing sent, snapshot stays unreported", async () => {
    const h = harness();
    const { id, resolve } = startFor("nobody");
    resolve({ status: "completed", output: "o" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(jobs.snapshot(id)?.reported).toBe(false);
  });

  it("session_shutdown detaches and cancels live jobs", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1"));
    const cancel = vi.fn();
    let resolve!: (o: { status: "killed" }) => void;
    jobs.start({ kind: "subagent", label: "L", owner: "s1", workspace: "/ws", run: () => ({ cancel, done: new Promise((r) => (resolve = r)) }) });
    const p = h.handlers.session_shutdown({ type: "session_shutdown" }, sessionCtx("s1"));
    resolve({ status: "killed" });
    await p;
    expect(cancel).toHaveBeenCalledWith("owner disposed");
  });
});
