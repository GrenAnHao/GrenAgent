import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetLeakOwnerForTest,
  currentChild,
  LATE_HANDLE_GRACE_MS,
  leakedErrorText,
  onLeakedError,
  outsideChild,
  rejectionWasHandled,
  reportLeakedError,
  runAsChild,
  trackUnhandledRejection,
} from "./leak-owner.js";
import { abortQuietly, Teardown } from "../multi-agent/teardown.js";

afterEach(() => {
  __resetLeakOwnerForTest();
  vi.restoreAllMocks();
});

describe("leak owner", () => {
  it("follows the child into timers and awaited work; the innermost child wins; outsideChild leaves it", async () => {
    const seen: Array<string | undefined> = [];
    await runAsChild("sa-a", async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          seen.push(currentChild());
          resolve();
        }, 1),
      );
      await Promise.resolve();
      seen.push(currentChild());
      runAsChild("sa-b", () => seen.push(currentChild()));
      outsideChild(() => seen.push(currentChild()));
    });
    seen.push(currentChild());
    expect(seen).toEqual(["sa-a", "sa-a", "sa-b", undefined, undefined]);
  });

  it("hands an error to the running child's handler; a settled child or no child is only reported", () => {
    const handler = vi.fn();
    onLeakedError("sa-a", handler);
    const boom = new Error("boom");
    expect(runAsChild("sa-a", () => reportLeakedError(boom))).toEqual({ childId: "sa-a", handled: true });
    expect(handler).toHaveBeenCalledWith(boom);
    expect(reportLeakedError(boom, "sa-gone")).toEqual({ childId: "sa-gone", handled: false });
    expect(reportLeakedError(boom)).toBeUndefined();
    expect(leakedErrorText(boom)).toBe("uncaught error: boom");
    expect(leakedErrorText("plain")).toBe("uncaught error: plain");
  });

  it("a throwing handler does not throw out of the process-level handler", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onLeakedError("sa-a", () => {
      throw new Error("handler broke");
    });
    expect(() => reportLeakedError(new Error("boom"), "sa-a")).not.toThrow();
    expect(log.mock.calls[0]?.[0]).toContain("sa-a");
  });

  it("unregistering only removes that registration", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onLeakedError("sa-a", first);
    onLeakedError("sa-a", second);
    offFirst();
    reportLeakedError(new Error("x"), "sa-a");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("late-handled rejections", () => {
  it("a rejection caught within the grace period is not a leak; one still unhandled is reported with the owner it surfaced under", () => {
    vi.useFakeTimers();
    try {
      const report = vi.fn();
      // 只当键用的 promise 对象；真实场景里它们是 Node 交给 unhandledRejection 的那个 promise。
      const caughtLater = Promise.resolve();
      const neverCaught = Promise.resolve();
      runAsChild("sa-a", () => trackUnhandledRejection(new Error("late"), caughtLater, report));
      runAsChild("sa-b", () => trackUnhandledRejection(new Error("lost"), neverCaught, report));
      vi.advanceTimersByTime(LATE_HANDLE_GRACE_MS - 1);
      rejectionWasHandled(caughtLater);
      expect(report).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(new Error("lost"), "sa-b");
      rejectionWasHandled(neverCaught);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("teardown", () => {
  it("runs every step, collects the failures and reports them in one line with the child id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const teardown = new Teardown("sa-a");
    teardown.step("first", () => {
      throw new Error("first broke");
    });
    teardown.step("second", () => ran.push("second"));
    await teardown.stepAsync("third", async () => {
      throw new Error("third broke");
    });
    teardown.step("fourth", () => ran.push("fourth"));
    teardown.report();
    expect(ran).toEqual(["second", "fourth"]);
    expect(teardown.failed).toEqual(["first: first broke", "third: third broke"]);
    expect(log).toHaveBeenCalledWith("[multi-agent] sub-agent sa-a teardown failed: first: first broke; third: third broke");
  });

  it("reports nothing when every step succeeds", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const teardown = new Teardown("sa-a");
    teardown.step("ok", () => undefined);
    teardown.report();
    expect(log).not.toHaveBeenCalled();
  });

  it("abortQuietly swallows a rejected or throwing abort", async () => {
    const rejected = { abort: vi.fn(() => Promise.reject(new Error("idle"))) };
    const throwing = { abort: vi.fn(() => {
      throw new Error("closed");
    }) };
    expect(() => abortQuietly(rejected)).not.toThrow();
    expect(() => abortQuietly(throwing)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected.abort).toHaveBeenCalled();
  });
});
