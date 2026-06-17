import { describe, expect, it } from "vitest";
import { looksBinary, normalizeFiles, sliceLines } from "./read-files.js";

describe("normalizeFiles", () => {
  it("coerces strings to FileReq and de-dups by path+offset+limit", () => {
    const out = normalizeFiles(["a.ts", "a.ts", { path: "a.ts", offset: 5 }]);
    expect(out).toEqual([{ path: "a.ts" }, { path: "a.ts", offset: 5 }]);
  });
});

describe("looksBinary", () => {
  it("flags known binary extensions regardless of bytes", () => {
    expect(looksBinary("x.png", Buffer.from("plain text"))).toBe(true);
  });
  it("flags a NUL byte and high non-printable ratio", () => {
    expect(looksBinary("x.txt", Buffer.from([0x00, 0x41]))).toBe(true);
    expect(looksBinary("x.txt", Buffer.from("hello world\n"))).toBe(false);
  });
});

describe("sliceLines", () => {
  it("applies offset/limit (1-indexed) and reports truncation when more remain", () => {
    const all = ["a", "b", "c", "d", "e"];
    const r = sliceLines(all, { offset: 2, limit: 2, maxLines: 400, maxBytes: 51200 });
    expect(r.lines).toEqual(["b", "c"]);
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(3);
    expect(r.truncated).toBe(true);
  });
  it("caps at maxLines", () => {
    const all = ["a", "b", "c", "d"];
    const r = sliceLines(all, { maxLines: 2, maxBytes: 51200 });
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.truncated).toBe(true);
  });
  it("does not truncate when the whole file fits", () => {
    const r = sliceLines(["a", "b"], { maxLines: 400, maxBytes: 51200 });
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.endLine).toBe(2);
    expect(r.truncated).toBe(false);
  });
});
