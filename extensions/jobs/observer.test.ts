import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobObserver, jobLiveSnapshot, killJobForUser, type JobFrame } from "./observer.js";
import { jobs, __resetJobsForTest } from "./service.js";
import type { JobDoneInfo, JobHandle, JobOutcome } from "./types.js";

beforeEach(() => {
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});

function startJob() {
  let handle!: JobHandle;
  let finish!: (o: JobOutcome) => void;
  const cancel = vi.fn();
  const id = jobs.start({
    kind: "bash",
    label: "npm run build",
    owner: "s1",
    workspace: "/ws",
    run: (job) => {
      handle = job;
      return { cancel, done: new Promise<JobOutcome>((r) => (finish = r)) };
    },
  });
  return { id, handle, finish, cancel, startedAt: jobs.snapshot(id)!.startedAt };
}

describe("createJobObserver", () => {
  it("announces lifecycle at once and coalesces output into one delta per window", async () => {
    const frames: JobFrame[][] = [];
    const observer = createJobObserver(jobs, (f) => frames.push(f), { intervalMs: 20 });
    const { id, handle, finish } = startJob();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.[0]).toMatchObject({ job: { id, status: "running", label: "npm run build", owner: "s1" } });

    handle.append("a\n");
    handle.append("b\n");
    expect(frames).toHaveLength(1);
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]).toEqual([{ job: expect.objectContaining({ id }), delta: { from: 0, text: "a\nb\n", next: 4, lossy: false } }]);

    handle.append("c\n");
    finish({ status: "completed", detail: "exit code: 0" });
    await jobs.wait(id, 1000, "s1");
    // 结算立即推：带着最后的输出和终态。
    const settled = frames.find((f) => f[0]?.job.status === "completed");
    expect(settled?.[0]).toMatchObject({ job: { detail: "exit code: 0" }, delta: { from: 4, text: "c\n", next: 6 } });
    observer.stop();
  });

  it("observation never moves the model cursor", async () => {
    const observer = createJobObserver(jobs, () => {}, { intervalMs: 5 });
    const { id, handle } = startJob();
    handle.append("line\n");
    observer.flush();
    expect((await jobs.read(id, "s1")).text).toBe("line\n");
    observer.stop();
  });

  it("reports removal", async () => {
    const frames: JobFrame[][] = [];
    const observer = createJobObserver(jobs, (f) => frames.push(f), { intervalMs: 5 });
    const { id, finish } = startJob();
    finish({ status: "completed" });
    await jobs.wait(id, 1000, "s1");
    jobs.remove(id, "s1");
    observer.flush();
    expect(frames.at(-1)).toEqual([{ job: expect.objectContaining({ id, status: "completed" }), removed: true }]);
    observer.stop();
  });
});

describe("jobLiveSnapshot / killJobForUser", () => {
  it("snapshot returns the retained output and resume offset; a stale startedAt reads as missing", () => {
    const { id, handle, startedAt } = startJob();
    handle.append("hello\n");
    expect(jobLiveSnapshot(jobs, id, startedAt)).toMatchObject({ job: { id, status: "running" }, text: "hello\n", next: 6, lossy: false });
    expect(jobLiveSnapshot(jobs, id, startedAt - 1)).toBeUndefined();
    expect(jobLiveSnapshot(jobs, "bash-99", startedAt)).toBeUndefined();
  });

  it("a user kill records the reason and still notifies the owner", async () => {
    const notices: JobDoneInfo[] = [];
    jobs.onJobDone((_s, info) => notices.push(info));
    const { id, finish, cancel, startedAt } = startJob();
    expect(killJobForUser(jobs, id, startedAt - 1)).toBe("not-found");
    expect(killJobForUser(jobs, id, startedAt)).toBe("requested");
    expect(cancel).toHaveBeenCalledWith("cancelled by the user");
    finish({ status: "killed", detail: "killed before exit" });
    await vi.waitFor(() => expect(notices).toEqual([{ cause: "kill", awaited: false }]));
    expect(jobs.get(id, "s1").detail).toBe("killed before exit; cancelled by the user");
  });
});
