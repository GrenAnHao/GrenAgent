import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetChildRunsForTest, onChildRunEvent, runningChildrenOf, silenceChild, type ChildRunEvent } from "./child-runs.js";
import { detachableSignal, ForegroundRun, SteerWatch, waitOrDetach } from "./detach.js";

afterEach(() => {
  __resetChildRunsForTest();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("waitOrDetach", () => {
  it("waits for the work when nobody is talking", async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const pending = waitOrDetach(work.promise, { enabled: true, hasPendingInput: () => false });
    await vi.advanceTimersByTimeAsync(1000);
    work.resolve("done");
    await expect(pending).resolves.toEqual({ detached: false, value: "done" });
  });

  it("stops waiting once the user has a message queued; the work keeps going", async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    let input = false;
    const pending = waitOrDetach(work.promise, { enabled: true, hasPendingInput: () => input });
    await vi.advanceTimersByTimeAsync(400);
    input = true;
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ detached: true });
    work.resolve("later");
    await expect(work.promise).resolves.toBe("later");
  });

  it("a message already queued when the run starts detaches at once", async () => {
    const work = deferred<string>();
    await expect(waitOrDetach(work.promise, { enabled: true, hasPendingInput: () => true })).resolves.toEqual({ detached: true });
  });

  it("disabled (codemode, chain): never detaches, even with a message queued", async () => {
    const work = deferred<string>();
    const pending = waitOrDetach(work.promise, { enabled: false, hasPendingInput: () => true });
    work.resolve("result");
    await expect(pending).resolves.toEqual({ detached: false, value: "result" });
  });

  it("a failing run still fails the call, and a broken input check does not detach", async () => {
    const work = deferred<string>();
    const pending = waitOrDetach(work.promise, {
      enabled: true,
      hasPendingInput: () => {
        throw new Error("runner gone");
      },
    });
    work.reject(new Error("child crashed"));
    await expect(pending).rejects.toThrow("child crashed");
  });
});

describe("ForegroundRun", () => {
  const events: ChildRunEvent[] = [];
  const listen = () => onChildRunEvent((e) => events.push(e));

  it("before detaching it only keeps track; nothing is delivered", () => {
    const deliver = vi.fn();
    const fg = new ForegroundRun({ parentSessionId: "p1", deliver, unlinkAbort: vi.fn() });
    fg.started("sa-1");
    expect(fg.isRunning("sa-1")).toBe(true);
    expect(runningChildrenOf("p1")).toEqual([]);
    fg.finished("sa-1", { stopReason: "completed", output: "OK" });
    expect(fg.isRunning("sa-1")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("detaching registers the running children for wait_agent, unlinks the abort, and each later end sends a notice", () => {
    events.length = 0;
    const off = listen();
    const deliver = vi.fn();
    const unlinkAbort = vi.fn();
    const fg = new ForegroundRun({ parentSessionId: "p1", deliver, unlinkAbort });
    fg.started("sa-1");
    fg.started("sa-2");
    fg.finished("sa-1", { stopReason: "completed", output: "first" });

    fg.detach();
    fg.detach();
    expect(unlinkAbort).toHaveBeenCalledTimes(1);
    expect(runningChildrenOf("p1")).toEqual(["sa-2"]);

    fg.started("sa-3");
    expect(runningChildrenOf("p1").sort()).toEqual(["sa-2", "sa-3"]);

    fg.finished("sa-2", { stopReason: "completed", output: "second", sessionPath: "/s/sa-2.jsonl" });
    expect(deliver).toHaveBeenCalledTimes(1);
    const notice = deliver.mock.calls[0]![0] as { childId: string; content: string };
    expect(notice.childId).toBe("sa-2");
    expect(notice.content).toContain("second");
    expect(notice.content).toContain("cannot receive further messages");
    expect(runningChildrenOf("p1")).toEqual(["sa-3"]);
    expect(events.at(-1)).toMatchObject({ childId: "sa-2", parentSessionId: "p1", settled: { stopReason: "completed" } });
    off();
  });

  it("a child deleted after detaching is not announced", () => {
    const deliver = vi.fn();
    const fg = new ForegroundRun({ parentSessionId: "p1", deliver, unlinkAbort: vi.fn() });
    fg.started("sa-1");
    fg.detach();
    silenceChild("sa-1");
    fg.finished("sa-1", { stopReason: "aborted", output: "" });
    expect(deliver).not.toHaveBeenCalled();
    expect(runningChildrenOf("p1")).toEqual([]);
  });
});

describe("detachableSignal", () => {
  it("forwards the turn's abort until unlinked, then stops forwarding", () => {
    const turn = new AbortController();
    const first = detachableSignal(turn.signal);
    const second = detachableSignal(turn.signal);
    second.unlink();
    turn.abort();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("an already aborted turn starts aborted; no turn signal never aborts", () => {
    const turn = new AbortController();
    turn.abort();
    expect(detachableSignal(turn.signal).signal.aborted).toBe(true);
    expect(detachableSignal(undefined).signal.aborted).toBe(false);
  });
});

describe("SteerWatch", () => {
  it("counts steers only; a follow-up or a message sent while idle does not count", () => {
    const watch = new SteerWatch();
    watch.noteInput({ streamingBehavior: "followUp" });
    watch.noteInput({});
    expect(watch.arrived).toBe(false);
    watch.noteInput({ streamingBehavior: "steer" });
    expect(watch.arrived).toBe(true);
  });

  it("forgets steers when a new turn starts (they were handed to the model at its start)", () => {
    const watch = new SteerWatch();
    watch.noteInput({ streamingBehavior: "steer" });
    watch.reset();
    expect(watch.arrived).toBe(false);
  });
});
