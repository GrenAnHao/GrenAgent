import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsError, type JobHandle, type JobOutcome, type JobOutputSource } from "./types.js";
import { jobs, __resetJobsForTest } from "./service.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function startJob(over: { owner?: string; cancel?: (reason?: string) => void; output?: JobOutputSource[]; onRun?: (job: JobHandle) => void } = {}) {
  const d = deferred<JobOutcome>();
  const cancel = over.cancel ?? vi.fn();
  const id = jobs.start({
    kind: "bash",
    label: "do x",
    owner: over.owner ?? "s1",
    workspace: "/ws",
    ...(over.output ? { output: over.output } : {}),
    run: (job) => {
      over.onRun?.(job);
      return { cancel, done: d.promise };
    },
  });
  return { id, done: d, cancel };
}

/** 可脚本化的拉取源：append 写入，read 按偏移非消耗读取。 */
function liveSource(channel?: "stdout" | "stderr") {
  let text = "";
  const source: JobOutputSource = {
    ...(channel ? { channel } : {}),
    read: (from) => {
      const raw = Buffer.from(text, "utf8");
      return { text: raw.subarray(from).toString("utf8"), nextOffset: raw.length, lossy: false, spillPath: "/spill/out.log" };
    },
  };
  return { source, write: (s: string) => (text += s) };
}

beforeEach(() => {
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});

describe("JobsService", () => {
  it("ids are <kind>-N and increment", () => {
    expect(startJob().id).toBe("bash-1");
    expect(startJob().id).toBe("bash-2");
  });

  it("run() throwing registers nothing and rethrows", () => {
    expect(() => jobs.start({ kind: "bash", label: "x", owner: "s1", workspace: "/ws", run: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(jobs.list("s1")).toEqual([]);
  });

  it("read / kill by a non-owner throw NOT_OWNER; list only shows own jobs", async () => {
    const { id } = startJob({ owner: "s1" });
    await expect(jobs.read(id, "s2")).rejects.toMatchObject({ code: "NOT_OWNER" });
    expect(() => jobs.kill(id, "s2")).toThrow(JobsError);
    expect(() => jobs.readAt(id, 0, "s2")).toThrow(JobsError);
    expect(jobs.list("s2")).toEqual([]);
    expect(jobs.list("s1").map((j) => j.id)).toEqual([id]);
  });

  it("unknown id throws NOT_FOUND", async () => {
    await expect(jobs.read("bash-99", "s1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("job without output: running → empty; wait times out leaving the job alive; terminal read marks reported", async () => {
    const { id, done } = startJob();
    expect(await jobs.read(id, "s1")).toMatchObject({ status: "running", text: "" });
    expect(await jobs.read(id, "s1", { wait: true, timeoutMs: 10 })).toMatchObject({ status: "running", text: "" });
    expect(jobs.hasLive("s1")).toBe(true);
    done.resolve({ status: "completed" });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 1000 });
    expect(r).toMatchObject({ status: "completed", text: "" });
    expect(jobs.snapshot(id)?.reported).toBe(true);
    expect(jobs.hasLive("s1")).toBe(false);
  });

  it("stream job: the pump copies the source into the ring; reads consume, readAt does not", async () => {
    const src = liveSource();
    const { id, done } = startJob({ output: [src.source] });
    src.write("line-1\n");
    await vi.waitFor(() => expect(jobs.snapshot(id)?.ring.total).toBe(7));
    expect(await jobs.read(id, "s1")).toMatchObject({ status: "running", text: "line-1\n" });
    expect((await jobs.read(id, "s1")).text).toBe("");
    src.write("line-2\n");
    done.resolve({ status: "completed", detail: "exit code: 0" });
    await jobs.wait(id, 1000, "s1");
    // 结算前的最后一次排干已经把 line-2 落环。
    expect(jobs.readAt(id, 0, "s1").chunks.map((c) => c.text).join("")).toBe("line-1\nline-2\n");
    expect(await jobs.read(id, "s1")).toMatchObject({ status: "completed", text: "line-2\n" });
    expect(jobs.get(id, "s1")).toMatchObject({ detail: "exit code: 0", ring: { spillPaths: ["/spill/out.log"] } });
  });

  it("producer appends land in the ring; stderr renders as one trailing [stderr] section", async () => {
    let handle!: JobHandle;
    const { id, done } = startJob({ onRun: (job) => (handle = job) });
    handle.append("a\n", { channel: "stdout" });
    handle.append("warn\n", { channel: "stderr" });
    handle.append("b", { channel: "stdout" });
    handle.append("narration", { channel: "log" });
    expect((await jobs.read(id, "s1")).text).toBe("a\nb\n[stderr]\nwarn\n");
    done.resolve({ status: "completed" });
    await jobs.wait(id, 1000, "s1");
    handle.append("late");
    expect(jobs.readAt(id, 0, "s1").chunks.some((c) => c.text === "late")).toBe(false);
  });

  it("progress shows while running and clears at settlement", async () => {
    let handle!: JobHandle;
    const { id, done } = startJob({ onRun: (job) => (handle = job) });
    handle.updateProgress("3/10");
    expect(jobs.get(id, "s1").progress).toBe("3/10");
    done.resolve({ status: "completed", detail: "ok" });
    await jobs.wait(id, 1000, "s1");
    expect(jobs.get(id, "s1")).toMatchObject({ detail: "ok" });
    expect(jobs.get(id, "s1").progress).toBeUndefined();
  });

  it("kill: live → requested + cancel(reason) + stopping; reason merges into the killed detail", async () => {
    const { id, done, cancel } = startJob();
    expect(jobs.kill(id, "s1", "why")).toBe("requested");
    expect(cancel).toHaveBeenCalledWith("why");
    expect(jobs.snapshot(id)?.status).toBe("stopping");
    done.resolve({ status: "killed", detail: "killed before exit" });
    await jobs.wait(id, 1000, "s1");
    expect(jobs.get(id, "s1").detail).toBe("killed before exit; why");
    expect(jobs.kill(id, "s1")).toBe("already-finished");
  });

  it("a job that outran its kill keeps the producer detail alone", async () => {
    const { id, done } = startJob();
    jobs.kill(id, "s1", "too late");
    done.resolve({ status: "completed", detail: "exit code: 0" });
    await jobs.wait(id, 1000, "s1");
    expect(jobs.get(id, "s1")).toMatchObject({ status: "completed", detail: "exit code: 0" });
  });

  it("rejected done becomes failed", async () => {
    const id = jobs.start({ kind: "bash", label: "x", owner: "s1", workspace: "/ws", run: () => ({ cancel: () => {}, done: Promise.reject(new Error("bad")) }) });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 100 });
    expect(r.status).toBe("failed");
    expect(jobs.snapshot(id)?.detail).toBe("bad");
  });

  it("onJobDone reports the cause and whether a live wait was released (awaited)", async () => {
    const seen: string[] = [];
    jobs.onJobDone((s, info) => seen.push(`${s.id}:${s.status}:${info.cause}:${info.awaited}`));
    const a = startJob();
    a.done.resolve({ status: "completed" });
    await vi.waitFor(() => expect(seen).toEqual([`${a.id}:completed:producer:false`]));

    const b = startJob();
    const waiting = jobs.wait(b.id, 1000, "s1");
    b.done.resolve({ status: "completed" });
    await waiting;
    expect(seen[1]).toBe(`${b.id}:completed:producer:true`);

    // 超时的等待已经离开集合：之后的结算不算 awaited。
    const c = startJob();
    await jobs.wait(c.id, 5, "s1");
    jobs.kill(c.id, "s1");
    c.done.resolve({ status: "killed" });
    await vi.waitFor(() => expect(seen[2]).toBe(`${c.id}:killed:kill:false`));
  });

  it("an aborted wait rejects while the job stays live", async () => {
    const { id } = startJob();
    const ac = new AbortController();
    const waiting = jobs.wait(id, 10_000, "s1", ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow("wait aborted");
    expect(jobs.get(id, "s1").status).toBe("running");
  });

  it("admission refuses past the per-owner limit, counting running and stopping only", async () => {
    jobs.configure({ maxConcurrentJobsPerOwner: 2, pumpPollMs: 5 });
    const a = startJob();
    startJob();
    expect(() => startJob()).toThrow(/background job limit reached/);
    expect(() => startJob({ owner: "s2" })).not.toThrow();
    a.done.resolve({ status: "completed" });
    await jobs.wait(a.id, 1000, "s1");
    expect(() => startJob()).not.toThrow();
  });

  it("remove drops a settled record and refuses a live one", async () => {
    const { id, done } = startJob();
    expect(() => jobs.remove(id, "s1")).toThrow(/still running/);
    done.resolve({ status: "completed" });
    await jobs.wait(id, 1000, "s1");
    jobs.remove(id, "s1");
    expect(jobs.list("s1")).toEqual([]);
  });

  it("settlement trims to the settled cap but keeps every unread byte until the first terminal read", async () => {
    jobs.configure({ retainBytes: 1024, settledRetainBytes: 4, pumpPollMs: 5 });
    let handle!: JobHandle;
    const { id, done } = startJob({ onRun: (job) => (handle = job) });
    handle.append("0123456789");
    done.resolve({ status: "completed" });
    await jobs.wait(id, 1000, "s1");
    expect((await jobs.read(id, "s1")).text).toBe("0123456789");
    expect(jobs.readAt(id, 0, "s1")).toMatchObject({ lossy: true, chunks: [{ text: "6789", gapBefore: true }] });
  });

  it("a lossy model read names the spill files", async () => {
    jobs.configure({ retainBytes: 4, pumpPollMs: 5 });
    const src = liveSource();
    const { id, done } = startJob({ output: [src.source] });
    src.write("abcdefgh");
    await vi.waitFor(() => expect(jobs.snapshot(id)?.ring.total).toBe(8));
    done.resolve({ status: "completed" });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 1000 });
    expect(r.text).toBe("efgh\n[some output was dropped from memory; full output: /spill/out.log]");
  });

  it("detachOwner cancels with teardown cause, awaits, and drops that owner's records", async () => {
    const causes: string[] = [];
    jobs.onJobDone((_s, info) => causes.push(info.cause));
    const a = startJob({ owner: "s1" });
    const b = startJob({ owner: "s2" });
    const detaching = jobs.detachOwner("s1");
    a.done.resolve({ status: "killed" });
    await detaching;
    expect(a.cancel).toHaveBeenCalledWith("owner disposed");
    expect(b.cancel).not.toHaveBeenCalled();
    expect(causes).toEqual(["teardown"]);
    expect(jobs.list("s1")).toEqual([]);
    expect(jobs.hasLive("s2")).toBe(true);
  });

  it("onEvent: registered first, output carries only the new total, settled then a final output, removed on remove", async () => {
    const seen: string[] = [];
    jobs.onEvent((e) => seen.push(e.type === "output" ? `output:${e.total}` : e.type === "settled" ? `settled:${e.cause}` : `${e.type}:${e.job.status}`));
    let handle!: JobHandle;
    const { id, done } = startJob({ onRun: (job) => (handle = job) });
    handle.append("abc");
    handle.updateProgress("1/2");
    jobs.kill(id, "s1");
    done.resolve({ status: "killed" });
    await jobs.wait(id, 1000, "s1");
    jobs.remove(id, "s1");
    // run() 期间暂存的写入不单独宣布：注册提交时已经在环里。
    expect(seen).toEqual(["registered:running", "output:3", "progress:running", "stopping:stopping", "settled:kill", "output:3", "removed:killed"]);
  });

  it("a throwing teardown cancel force-fails the record instead of deadlocking", async () => {
    startJob({ owner: "s1", cancel: () => { throw new Error("stuck"); } });
    await jobs.detachOwner("s1");
    expect(jobs.list("s1")).toEqual([]);
  });
});
