import { afterEach, describe, expect, it, vi } from "vitest";
import { guardListener } from "./guard-listener.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardListener", () => {
  it("passes the arguments through", () => {
    const fn = vi.fn();
    guardListener("probe", fn)("a", 1);
    expect(fn).toHaveBeenCalledWith("a", 1);
  });

  it("swallows a throw: the first one is logged with the error, later ones only counted and summed up in report()", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = guardListener("probe", () => {
      throw new Error("listener broke");
    });
    expect(() => listener()).not.toThrow();
    listener();
    listener();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("[session-listener] probe failed; swallowed so the session keeps going");
    expect(log.mock.calls[0]?.[1]).toEqual(new Error("listener broke"));
    listener.report();
    expect(log).toHaveBeenLastCalledWith("[session-listener] probe: 2 more error(s) swallowed");
  });

  it("report() is silent when nothing or only one error was swallowed", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    guardListener("quiet", () => undefined).report();
    const once = guardListener("once", () => {
      throw new Error("x");
    });
    once();
    once.report();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("an async listener's rejection is swallowed too", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    guardListener("async probe", async () => {
      throw new Error("async broke");
    })();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]?.[1]).toEqual(new Error("async broke"));
  });
});
