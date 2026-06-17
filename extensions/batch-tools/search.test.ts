import { describe, expect, it } from "vitest";
import { compilePatterns, searchInText } from "./search.js";

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
