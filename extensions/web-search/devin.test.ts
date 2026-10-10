import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeSearchFolder, devinUserMessage, mapDevinWebSources } from "./devin.js";

describe("mapDevinWebSources", () => {
  it("keeps title, url, and snippet and drops empty urls", () => {
    expect(mapDevinWebSources([
      { title: "A", url: "https://a.example", snippet: "one" },
      { title: "B", url: "", snippet: "skip" },
    ])).toEqual([{ title: "A", url: "https://a.example", snippet: "one" }]);
  });
});

describe("codeSearchFolder", () => {
  it("resolves a subdirectory and rejects a path outside the workspace", () => {
    expect(codeSearchFolder("D:/repo", "src")).toBe(resolve("D:/repo/src"));
    expect(codeSearchFolder("D:/repo", undefined)).toBe(resolve("D:/repo"));
    expect(() => codeSearchFolder("D:/repo", "../outside")).toThrow(/workspace/);
    expect(() => codeSearchFolder("D:/repo", "D:/other")).toThrow(/workspace/);
    expect(() => codeSearchFolder("repo", "src")).toThrow(/absolute workspace/);
  });
});

describe("devinUserMessage", () => {
  it("replaces login failures with a settings hint", () => {
    expect(devinUserMessage("Devin session missing, expired or revoked; run: devin-search auth")).toContain("网页 / 搜索");
    expect(devinUserMessage("network down")).toBe("network down");
  });
});
