import { describe, expect, it } from "vitest";
import { draftShouldForwardWheel, scrollbarGutterPx } from "./composerWheel";

describe("scrollbarGutterPx", () => {
  it("is the overflow slot", () => {
    expect(scrollbarGutterPx(400, 388)).toBe(12);
    expect(scrollbarGutterPx(400, 400)).toBe(0);
  });
});

describe("draftShouldForwardWheel", () => {
  it("stays local while the draft can still move", () => {
    expect(draftShouldForwardWheel({ scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
    expect(draftShouldForwardWheel({ scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: -30 })).toBe(false);
  });

  it("forwards at the edges", () => {
    expect(draftShouldForwardWheel({ scrollTop: 300, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(true);
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 400, deltaY: -20 })).toBe(true);
  });

  it("forwards when the draft does not overflow", () => {
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 100, deltaY: 20 })).toBe(true);
  });

  it("ignores deltaY 0", () => {
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 100, deltaY: 0 })).toBe(false);
  });
});
