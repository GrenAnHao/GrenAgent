import { describe, expect, it } from "vitest";
import { draftShouldForwardWheel, scrollbarGutterPx, scrollerKeepsWheel } from "./composerWheel";

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

describe("scrollerKeepsWheel", () => {
  it("lets the seat forward when overflow is not auto or scroll", () => {
    expect(scrollerKeepsWheel({ overflowY: "visible", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
    expect(scrollerKeepsWheel({ overflowY: "hidden", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
    expect(scrollerKeepsWheel({ overflowY: "clip", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
  });

  it("keeps the wheel while an auto scroller can still move", () => {
    expect(scrollerKeepsWheel({ overflowY: "auto", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(true);
    expect(scrollerKeepsWheel({ overflowY: "auto", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: -30 })).toBe(true);
    expect(scrollerKeepsWheel({ overflowY: "scroll", scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(true);
  });

  it("forwards when the nested scroller is at that edge", () => {
    expect(scrollerKeepsWheel({ overflowY: "auto", scrollTop: 300, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
    expect(scrollerKeepsWheel({ overflowY: "auto", scrollTop: 0, clientHeight: 100, scrollHeight: 400, deltaY: -20 })).toBe(false);
  });
});
