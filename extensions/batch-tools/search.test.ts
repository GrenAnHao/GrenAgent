import { describe, expect, it } from "vitest";
import {
  clampSearchMaxResults,
  compilePatterns,
  prepareSearchArguments,
  SEARCH_HARD_MAX_RESULTS,
  searchInText,
  searchPatternList,
} from "./search.js";

describe("prepareSearchArguments", () => {
  it("leaves the canonical shape alone except for splitting pattern / patterns", () => {
    expect(prepareSearchArguments({ pattern: "foo", patterns: ["bar"], globs: ["src/**"], path: "a" })).toEqual({
      pattern: "foo", patterns: ["bar"], globs: ["src/**"], path: "a",
    });
  });
  it("moves a legacy patterns array into pattern + patterns", () => {
    expect(prepareSearchArguments({ patterns: ["a", "b", "c"], contextLines: 2 })).toEqual({
      pattern: "a", patterns: ["b", "c"], contextLines: 2,
    });
  });
  it("wraps a single patterns string", () => {
    expect(prepareSearchArguments({ patterns: "only" })).toEqual({ pattern: "only" });
  });
  it("maps the DeepSeek-style misuse seen in session logs", () => {
    expect(prepareSearchArguments({
      paths: ["D:\\repo"], pattern: "session.?sidebar|SessionSidebar", maxResults: 40,
      includePatterns: ["*.{ts,tsx}"],
    })).toEqual({
      pattern: "session.?sidebar|SessionSidebar", path: "D:\\repo", maxResults: 40, globs: ["*.{ts,tsx}"],
    });
  });
  it("accepts query / glob aliases and dedupes", () => {
    expect(prepareSearchArguments({ query: "x", pattern: "x", glob: "*.ts" })).toEqual({ pattern: "x", globs: ["*.ts"] });
  });
  it("returns empty or non-object input unchanged so validation reports the missing pattern", () => {
    const empty = {};
    expect(prepareSearchArguments(empty)).toBe(empty);
    expect(prepareSearchArguments(null)).toBe(null);
    expect(prepareSearchArguments({ patterns: [] })).toEqual({ patterns: [] });
  });
});

describe("searchPatternList", () => {
  it("merges pattern and patterns, dropping blanks and duplicates", () => {
    expect(searchPatternList({ pattern: "a", patterns: ["b", "", "a"] })).toEqual(["a", "b"]);
    expect(searchPatternList({ patterns: ["legacy"] })).toEqual(["legacy"]);
  });
});

describe("compilePatterns", () => {
  it("compiles regex patterns and collects invalid ones", () => {
    const { regexes, invalid } = compilePatterns(["foo", "("], {});
    expect(regexes).toHaveLength(1);
    expect(invalid).toEqual(["("]);
  });
  it("escapes when literal and adds i flag when ignoreCase", () => {
    const { regexes } = compilePatterns(["a.b"], { literal: true });
    expect(regexes[0].test("a.b")).toBe(true);
    expect(regexes[0].test("axb")).toBe(false);
    const ci = compilePatterns(["foo"], { ignoreCase: true }).regexes[0];
    expect(ci.test("FOO")).toBe(true);
  });
});

describe("clampSearchMaxResults", () => {
  it("caps model-supplied maxResults so a huge request cannot dump the tree", () => {
    expect(SEARCH_HARD_MAX_RESULTS).toBe(250);
    expect(clampSearchMaxResults(1_000_000)).toBe(SEARCH_HARD_MAX_RESULTS);
    expect(clampSearchMaxResults(40)).toBe(40);
    expect(clampSearchMaxResults(undefined)).toBe(250);
    expect(clampSearchMaxResults(0)).toBe(250);
  });
});

describe("searchInText", () => {
  const text = ["import x", "const y = 1", "y()", "done"].join("\n");
  it("returns match lines for any pattern (OR)", () => {
    const { regexes } = compilePatterns(["import", "y\\("], {});
    const hits = searchInText(text, regexes, 0);
    expect(hits.filter((h) => h.isMatch).map((h) => h.line)).toEqual([1, 3]);
  });
  it("includes context lines marked as non-match", () => {
    const { regexes } = compilePatterns(["const"], {});
    const hits = searchInText(text, regexes, 1);
    expect(hits.map((h) => `${h.line}${h.isMatch ? ":" : "-"}`)).toEqual(["1-", "2:", "3-"]);
  });
  it("returns nothing when no line matches", () => {
    const { regexes } = compilePatterns(["zzz"], {});
    expect(searchInText(text, regexes, 0)).toEqual([]);
  });
});
