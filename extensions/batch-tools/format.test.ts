import { describe, expect, it } from "vitest";
import { formatReadResult, formatSearchGroups, type Hit, type ReadSegment } from "./format.js";

describe("formatReadResult", () => {
  it("renders a header with span/total, numbered lines, and a truncation note", () => {
    const segs: ReadSegment[] = [
      { path: "a.ts", startLine: 1, endLine: 2, totalLines: 5, lines: ["x", "y"], truncated: true },
    ];
    const out = formatReadResult(segs);
    expect(out).toContain("===== a.ts (lines 1-2 of 5) =====");
    expect(out).toContain("1: x");
    expect(out).toContain("2: y");
    expect(out).toContain("offset=3");
  });
  it("renders error and binary segments", () => {
    const segs: ReadSegment[] = [
      { path: "miss.ts", startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, error: "not found" },
      { path: "img.png", startLine: 0, endLine: 0, totalLines: 0, lines: [], truncated: false, binary: true },
    ];
    const out = formatReadResult(segs);
    expect(out).toContain("[error: not found]");
    expect(out).toContain("[skipped: binary file]");
  });
});

describe("formatSearchGroups", () => {
  it("groups by file, marks match vs context, and appends a summary", () => {
    const groups = [
      { file: "a.ts", hits: [{ line: 11, text: "ctx", isMatch: false }, { line: 12, text: "hit", isMatch: true }] as Hit[] },
    ];
    const out = formatSearchGroups(groups, { total: 1, files: 1, capped: false, limit: 100 });
    expect(out).toContain("a.ts");
    expect(out).toContain("  11- ctx");
    expect(out).toContain("  12: hit");
    expect(out).toContain("(1 matches in 1 files)");
  });
  it("notes capping and empty results", () => {
    expect(formatSearchGroups([], { total: 0, files: 0, capped: false, limit: 100 })).toContain("No matches");
    const capped = formatSearchGroups([{ file: "a", hits: [{ line: 1, text: "h", isMatch: true }] }], {
      total: 100, files: 1, capped: true, limit: 100,
    });
    expect(capped).toContain("capped at 100");
  });
  it("clips megabyte-scale match lines so one tsbuildinfo hit cannot explode context", () => {
    const bomb = `{"version":"7.0.2","root":[${"1,".repeat(80_000)}"ask_user"]}`;
    expect(bomb.length).toBeGreaterThan(100_000);
    const out = formatSearchGroups(
      [{ file: "tsconfig.node.tsbuildinfo", hits: [{ line: 1, text: bomb, isMatch: true }] }],
      { total: 1, files: 1, capped: false, limit: 40 },
    );
    expect(out.length).toBeLessThan(3000);
    expect(out).toContain("tsconfig.node.tsbuildinfo");
    expect(out).toContain("(line truncated)");
    expect(out).not.toContain(bomb.slice(-40));
  });
});
