import { describe, expect, it } from "vitest";
import {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  previewLine,
  READ_MAX_BYTES,
  READ_MAX_LINE_LENGTH,
  READ_MAX_LINES,
  retainHead,
  truncateReadLine,
} from "./output-retention.js";

describe("DSH-aligned caps", () => {
  it("matches DeepSeek Harness grep/read defaults", () => {
    expect(GREP_MAX_MATCHES).toBe(250);
    expect(GREP_MAX_LINE_BYTES).toBe(2000);
    expect(READ_MAX_LINE_LENGTH).toBe(2000);
    expect(READ_MAX_BYTES).toBe(50 * 1024);
    expect(READ_MAX_LINES).toBe(2000);
  });
});

describe("previewLine", () => {
  it("returns short lines unchanged", () => {
    expect(previewLine("hello")).toBe("hello");
  });
  it("cuts a megabyte-scale line to the byte budget and marks truncation like DSH", () => {
    const bomb = `{"root":[${"1,".repeat(80_000)}"ask_user"]}`;
    const out = previewLine(bomb);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(GREP_MAX_LINE_BYTES + 40);
    expect(out).toContain("(line truncated)");
    expect(out).not.toContain(bomb.slice(-20));
  });
});

describe("truncateReadLine", () => {
  it("clips a giant single line the way DSH read does", () => {
    const line = "a".repeat(5000);
    const out = truncateReadLine(line);
    expect(out.startsWith("a".repeat(READ_MAX_LINE_LENGTH))).toBe(true);
    expect(out).toContain(`(line truncated to ${READ_MAX_LINE_LENGTH} chars)`);
    expect(out.length).toBeLessThan(READ_MAX_LINE_LENGTH + 80);
  });
});

describe("retainHead", () => {
  it("keeps the first page and reports the rest as truncated", () => {
    const res = retainHead([1, 2, 3, 4, 5], 3);
    expect(res).toEqual({ items: [1, 2, 3], truncated: true, seen: 5 });
    expect(retainHead([1, 2], 3)).toEqual({ items: [1, 2], truncated: false, seen: 2 });
  });
});
