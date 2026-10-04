import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCappedLog } from "./logRotate.js";

describe("appendCappedLog", () => {
  it("renames the file to .1 when the next write would pass 5MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const path = join(dir, "mcp.log");
    writeFileSync(path, "x".repeat(5 * 1024 * 1024));
    appendCappedLog(path, "next\n");
    expect(readFileSync(join(dir, "mcp.log"), "utf8")).toBe("next\n");
    expect(statSync(join(dir, "mcp.log.1")).size).toBe(5 * 1024 * 1024);
  });
});
