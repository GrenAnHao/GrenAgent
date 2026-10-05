import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BashOutput } from "./bashOutput.js";

const tempDir = mkdtempSync(join(tmpdir(), "pi-bash-output-test-"));

describe("BashOutput · pi OutputAccumulator parity", () => {
  it("keeps short output in memory: no temp file, not truncated", async () => {
    const out = new BashOutput({ tempDir });
    out.append(Buffer.from("hello\nworld\n"));
    out.finish();
    const snap = out.snapshot({ persistIfTruncated: true });
    expect(snap.content).toBe("hello\nworld\n");
    expect(snap.truncation.truncated).toBe(false);
    expect(snap.fullOutputPath).toBeUndefined();
    await out.closeTempFile();
    expect(await out.readFullOutput(1024)).toEqual({ content: "hello\nworld\n", truncated: false });
  });

  it("past the line limit keeps the tail, spills every raw byte to a temp file", async () => {
    const out = new BashOutput({ tempDir, maxLines: 3 });
    for (let i = 1; i <= 6; i++) out.append(Buffer.from(`line ${i}\n`));
    out.finish();
    const snap = out.snapshot({ persistIfTruncated: true });
    expect(snap.truncation).toMatchObject({ truncated: true, truncatedBy: "lines", totalLines: 6, outputLines: 3 });
    expect(snap.content).toBe("line 4\nline 5\nline 6\n".replace(/\n$/, ""));
    expect(snap.fullOutputPath).toBeDefined();
    await out.closeTempFile();
    expect(readFileSync(snap.fullOutputPath!, "utf8")).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n");
  });

  it("decodes UTF-8 split across chunks", () => {
    const out = new BashOutput({ tempDir });
    const bytes = Buffer.from("构建完成\n");
    out.append(bytes.subarray(0, 4));
    out.append(bytes.subarray(4));
    out.finish();
    expect(out.snapshot().content).toBe("构建完成\n");
  });

  it("readFullOutput keeps head and tail around an omission marker past maxBytes", async () => {
    const out = new BashOutput({ tempDir, maxBytes: 8 });
    out.append(Buffer.from("AAAAAAAAAA-middle-BBBBBBBBBB"));
    out.finish();
    await out.closeTempFile();
    const full = await out.readFullOutput(20);
    expect(full.truncated).toBe(true);
    expect(full.content.startsWith("AAAAAAAAAA")).toBe(true);
    expect(full.content.endsWith("BBBBBBBBBB")).toBe(true);
    expect(full.content).toContain("bytes omitted");
  });

  it("drops bytes appended after finish (a killed tree may still write)", () => {
    const out = new BashOutput({ tempDir });
    out.append(Buffer.from("a"));
    out.finish();
    out.append(Buffer.from("late"));
    expect(out.snapshot().content).toBe("a");
    expect(out.total).toBe(1);
  });
});

describe("BashOutput · offset window for the jobs pump", () => {
  it("reads by absolute decoded-byte offset without consuming", () => {
    const out = new BashOutput({ tempDir });
    out.append(Buffer.from("héllo\n"));
    expect(out.readFrom(0)).toEqual({ text: "héllo\n", nextOffset: 7, lossy: false });
    out.append(Buffer.from("next\n"));
    expect(out.readFrom(7)).toEqual({ text: "next\n", nextOffset: 12, lossy: false });
    expect(out.readFrom(0).text).toBe("héllo\nnext\n");
  });

  it("evicts the window head and reports lossy reads with the spill file once there is one", async () => {
    const out = new BashOutput({ tempDir, windowBytes: 8, maxBytes: 4 });
    out.append(Buffer.from("aaaa"));
    out.append(Buffer.from("bbbb"));
    out.append(Buffer.from("cc"));
    const read = out.readFrom(0);
    expect(read).toMatchObject({ text: "bbbbcc", nextOffset: 10, lossy: true });
    expect(read.spillPath).toBe(out.fullOutputPath);
    out.finish();
    await out.closeTempFile();
    expect(readFileSync(out.fullOutputPath!, "utf8")).toBe("aaaabbbbcc");
  });

  it("eagerFile names the log before any output", async () => {
    const out = new BashOutput({ tempDir, eagerFile: true });
    expect(out.fullOutputPath).toBeDefined();
    expect(existsSync(out.fullOutputPath!)).toBe(true);
    out.append(Buffer.from("x\n"));
    out.finish();
    await out.closeTempFile();
    expect(readFileSync(out.fullOutputPath!, "utf8")).toBe("x\n");
  });
});
