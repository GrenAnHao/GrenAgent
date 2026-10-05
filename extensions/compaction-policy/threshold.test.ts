import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_OVERRIDES_KEY,
  AUTO_COMPACT_PERCENT_DEFAULT,
  AUTO_COMPACT_PERCENT_KEY,
  effectiveAutoCompactPercent,
  readGlobalAutoCompactPercent,
  readSessionAutoCompactPercent,
  withSessionAutoCompactPercent,
} from "./threshold.js";

describe("auto compact threshold", () => {
  it("unset global stays at the historical 80", () => {
    expect(readGlobalAutoCompactPercent({})).toBe(AUTO_COMPACT_PERCENT_DEFAULT);
  });

  it("clamps global and session values into 5–90", () => {
    expect(readGlobalAutoCompactPercent({ [AUTO_COMPACT_PERCENT_KEY]: "2" })).toBe(5);
    expect(readGlobalAutoCompactPercent({ [AUTO_COMPACT_PERCENT_KEY]: "99" })).toBe(90);
    expect(readGlobalAutoCompactPercent({ [AUTO_COMPACT_PERCENT_KEY]: "nope" })).toBe(80);
  });

  it("session override wins, and a missing path follows global", () => {
    const settings = withSessionAutoCompactPercent(
      { [AUTO_COMPACT_PERCENT_KEY]: "70" },
      "C:\\sessions\\a.jsonl",
      78,
    );
    expect(effectiveAutoCompactPercent(settings, "C:/sessions/a.jsonl")).toBe(78);
    expect(readSessionAutoCompactPercent(settings, "C:/sessions/a.jsonl")).toBe(78);
    expect(effectiveAutoCompactPercent(settings, undefined)).toBe(70);
  });

  it("clearing the override removes the session and drops an empty map", () => {
    const set = withSessionAutoCompactPercent({}, "/s/a.jsonl", 60);
    const cleared = withSessionAutoCompactPercent(set, "/s/a.jsonl", null);
    expect(cleared[AUTO_COMPACT_OVERRIDES_KEY]).toBeUndefined();
    expect(readSessionAutoCompactPercent(cleared, "/s/a.jsonl")).toBeNull();
    expect(effectiveAutoCompactPercent(cleared, "/s/a.jsonl")).toBe(80);
  });
});
