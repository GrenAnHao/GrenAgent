import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsError } from "./types.js";
import { jobs, __resetJobsForTest } from "./service.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function startJob(over: { owner?: string; cancel?: () => void; readOutput?: () => string } = {}) {
  const d = deferred<{ status: "completed" | "failed" | "killed"; output?: string; error?: string }>();
  const cancel = over.cancel ?? vi.fn();
  const id = jobs.start({
    kind: "subagent",
    label: "do x",
    owner: over.owner ?? "s1",
    workspace: "/ws",
    run: () => ({ cancel, done: d.promise, ...(over.readOutput ? { readOutput: over.readOutput } : {}) }),
  });
  return { id, done: d, cancel };
}

beforeEach(() => __resetJobsForTest());

describe("JobsService", () => {
  it("ids are <kind>-N and increment", () => {
    expect(startJob().id).toBe("subagent-1");
    expect(startJob().id).toBe("subagent-2");
  });

  it("run() throwing registers nothing and rethrows", () => {
    expect(() => jobs.start({ kind: "subagent", label: "x", owner: "s1", workspace: "/ws", run: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(jobs.list("s1")).toEqual([]);
  });

  it("read / kill by a non-owner throw NOT_OWNER; list only shows own jobs", async () => {
    const { id } = startJob({ owner: "s1" });
    await expect(jobs.read(id, "s2")).rejects.toMatchObject({ code: "NOT_OWNER" });
    expect(() => jobs.kill(id, "s2")).toThrow(JobsError);
    expect(jobs.list("s2")).toEqual([]);
    expect(jobs.list("s1").map((j) => j.id)).toEqual([id]);
  });

  it("unknown id throws NOT_FOUND", async () => {
    await expect(jobs.read("subagent-99", "s1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("final-output job: running → empty; wait times out leaving the job alive; settled → output + reported", async () => {
    const { id, done } = startJob();
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "" });
    expect(await jobs.read(id, "s1", { wait: true, timeoutMs: 10 })).toEqual({ status: "running", text: "" });
    expect(jobs.hasLive("s1")).toBe(true);
    done.resolve({ status: "completed", output: "answer" });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 1000 });
    expect(r).toEqual({ status: "completed", text: "answer" });
    expect(jobs.snapshot(id)?.reported).toBe(true);
    expect(jobs.hasLive("s1")).toBe(false);
  });

  it("stream job returns readOutput delta", async () => {
    let n = 0;
    const { id } = startJob({ readOutput: () => `chunk${++n}` });
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "chunk1" });
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "chunk2" });
  });

  it("kill: live → requested + cancel(reason) + stopping; finished → already-finished", async () => {
    const { id, done, cancel } = startJob();
    expect(jobs.kill(id, "s1", "why")).toBe("requested");
    expect(cancel).toHaveBeenCalledWith("why");
    expect(jobs.snapshot(id)?.status).toBe("stopping");
    done.resolve({ status: "killed" });
    await jobs.read(id, "s1", { wait: true, timeoutMs: 100 });
    expect(jobs.kill(id, "s1")).toBe("already-finished");
  });

  it("rejected done becomes failed", async () => {
    const id = jobs.start({ kind: "subagent", label: "x", owner: "s1", workspace: "/ws", run: () => ({ cancel: () => {}, done: Promise.reject(new Error("bad")) }) });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 100 });
    expect(r.status).toBe("failed");
    expect(jobs.snapshot(id)?.error).toBe("bad");
  });

  it("onJobDone fires once per settled job with the snapshot", async () => {
    const seen: string[] = [];
    jobs.onJobDone((s) => seen.push(`${s.id}:${s.status}`));
    const { id, done } = startJob();
    done.resolve({ status: "completed", output: "o" });
    await vi.waitFor(() => expect(seen).toEqual([`${id}:completed`]));
  });

  it("detachOwner cancels and awaits every live job of that owner", async () => {
    const a = startJob({ owner: "s1" });
    const b = startJob({ owner: "s2" });
    // 计划原文在 detach 前 resolve a.done，settle 微任务可能先跑完导致 cancel 不会被叫。
    // 正确顺序：先 detach（job 仍活），再让 done 结算，await 才能结束。
    const detaching = jobs.detachOwner("s1");
    a.done.resolve({ status: "killed" });
    await detaching;
    expect(a.cancel).toHaveBeenCalledWith("owner disposed");
    expect(b.cancel).not.toHaveBeenCalled();
    expect(jobs.hasLive("s1")).toBe(false);
    expect(jobs.hasLive("s2")).toBe(true);
  });
});
