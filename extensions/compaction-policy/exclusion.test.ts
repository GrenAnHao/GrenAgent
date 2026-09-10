import { describe, expect, it } from "vitest";
import {
  buildExclusionSet,
  contextExclusionConfigKey,
  type ExclusionOp,
  filterExcludedByTs,
  parseContextExclusionPulse,
  shouldApplyContextExclusionPulse,
} from "./exclusion.js";

describe("buildExclusionSet", () => {
  it("replays add/remove ops in order", () => {
    const ops: ExclusionOp[] = [
      { op: "add", ts: 1 },
      { op: "add", ts: 2 },
      { op: "remove", ts: 1 },
    ];
    expect([...buildExclusionSet(ops)].sort()).toEqual([2]);
  });

  it("is empty for no ops", () => {
    expect(buildExclusionSet([]).size).toBe(0);
  });
});

describe("filterExcludedByTs", () => {
  it("drops messages whose timestamp is excluded", () => {
    const msgs = [
      { timestamp: 1, v: "a" },
      { timestamp: 2, v: "b" },
      { timestamp: 3, v: "c" },
    ];
    expect(filterExcludedByTs(msgs, new Set([2])).map((m) => m.v)).toEqual(["a", "c"]);
  });

  it("keeps messages without a timestamp", () => {
    const msgs = [{ v: "a" }, { timestamp: 2, v: "b" }] as Array<{ timestamp?: number; v: string }>;
    expect(filterExcludedByTs(msgs, new Set([2])).map((m) => m.v)).toEqual(["a"]);
  });

  it("returns the same array (no copy) when nothing excluded", () => {
    const msgs = [{ timestamp: 1 }];
    expect(filterExcludedByTs(msgs, new Set())).toBe(msgs);
  });
});

describe("contextExclusionConfigKey", () => {
  it("normalizes workspace path like approval keys", () => {
    expect(contextExclusionConfigKey("C:\\Work\\Repo\\")).toBe("CONTEXT_EXCLUSION_OP:c:/work/repo");
  });
});

describe("parseContextExclusionPulse", () => {
  it("reads add/remove pulses from runtime config JSON", () => {
    expect(parseContextExclusionPulse(JSON.stringify({ op: "add", ts: 42, rev: 7 }))).toEqual({
      op: "add",
      ts: 42,
      rev: 7,
    });
    expect(parseContextExclusionPulse(JSON.stringify({ op: "remove", ts: 1, rev: 2 }))).toEqual({
      op: "remove",
      ts: 1,
      rev: 2,
    });
  });
  it("rejects malformed pulses", () => {
    expect(parseContextExclusionPulse(undefined)).toBeUndefined();
    expect(parseContextExclusionPulse("")).toBeUndefined();
    expect(parseContextExclusionPulse("{")).toBeUndefined();
    expect(parseContextExclusionPulse(JSON.stringify({ op: "add", ts: "x", rev: 1 }))).toBeUndefined();
    expect(parseContextExclusionPulse(JSON.stringify({ op: "skip", ts: 1, rev: 1 }))).toBeUndefined();
  });
});

describe("shouldApplyContextExclusionPulse", () => {
  it("applies a newer add that is not yet in the set", () => {
    expect(shouldApplyContextExclusionPulse({ op: "add", ts: 9, rev: 2 }, 1, new Set())).toEqual({
      apply: true,
      nextRev: 2,
    });
  });
  it("skips stale or already-applied pulses so session replay does not append twice", () => {
    expect(shouldApplyContextExclusionPulse({ op: "add", ts: 9, rev: 1 }, 1, new Set())).toEqual({
      apply: false,
      nextRev: 1,
    });
    expect(shouldApplyContextExclusionPulse({ op: "add", ts: 9, rev: 3 }, 0, new Set([9]))).toEqual({
      apply: false,
      nextRev: 3,
    });
    expect(shouldApplyContextExclusionPulse({ op: "remove", ts: 9, rev: 4 }, 3, new Set())).toEqual({
      apply: false,
      nextRev: 4,
    });
  });
});
