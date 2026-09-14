import { describe, expect, it } from "vitest";
import { scrollbarGutterPx } from "./composerWheel";

describe("scrollbarGutterPx", () => {
  it("is the overflow slot", () => {
    expect(scrollbarGutterPx(400, 388)).toBe(12);
    expect(scrollbarGutterPx(400, 400)).toBe(0);
  });
});
