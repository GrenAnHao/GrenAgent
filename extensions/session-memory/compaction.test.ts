import { describe, expect, it } from "vitest";
import {
  buildStateCompaction,
  canUseStateSummary,
  formatFileAppendix,
  isStateCompaction,
  mergeFileLists,
  previousStateFileLists,
} from "./compaction.js";

const ops = (read: string[], edited: string[], written: string[]) => ({
  read: new Set(read),
  edited: new Set(edited),
  written: new Set(written),
});

describe("canUseStateSummary", () => {
  const preparation = { firstKeptEntryId: "k1", tokensBefore: 100 };

  it("准备数据完整且没有附言时可用", () => {
    expect(canUseStateSummary({ preparation })).toBe(true);
    expect(canUseStateSummary({ preparation, customInstructions: "  " })).toBe(true);
  });

  it("带附言或准备数据不全时不可用", () => {
    expect(canUseStateSummary({ preparation, customInstructions: "focus" })).toBe(false);
    expect(canUseStateSummary({ preparation: { firstKeptEntryId: "", tokensBefore: 1 } })).toBe(false);
    expect(canUseStateSummary({ preparation: { firstKeptEntryId: "k1", tokensBefore: Number.NaN } })).toBe(false);
    expect(canUseStateSummary({})).toBe(false);
  });
});

describe("mergeFileLists", () => {
  it("edited/written 合入 modified，read 去掉已改的，合并上一份并排序", () => {
    const lists = mergeFileLists(ops(["b.ts", "a.ts"], ["b.ts"], ["c.ts"]), {
      readFiles: ["z.ts"],
      modifiedFiles: ["y.ts"],
    });
    expect(lists).toEqual({ readFiles: ["a.ts", "z.ts"], modifiedFiles: ["b.ts", "c.ts", "y.ts"] });
  });

  it("没有 fileOps 时只用上一份", () => {
    expect(mergeFileLists(undefined, { readFiles: ["r"], modifiedFiles: [] })).toEqual({
      readFiles: ["r"],
      modifiedFiles: [],
    });
  });
});

describe("previousStateFileLists", () => {
  const ours = { type: "compaction", details: { source: "session-state", readFiles: ["r.ts"], modifiedFiles: ["m.ts"] } };
  const pis = { type: "compaction", details: { readFiles: ["p.ts"], modifiedFiles: [] } };

  it("最后一条压缩是本扩展写的时取它的列表", () => {
    expect(previousStateFileLists([pis, { type: "message" }, ours, { type: "message" }])).toEqual({
      readFiles: ["r.ts"],
      modifiedFiles: ["m.ts"],
    });
  });

  it("最后一条压缩是 Pi 写的时不合并", () => {
    expect(previousStateFileLists([ours, pis])).toEqual({ readFiles: [], modifiedFiles: [] });
    expect(previousStateFileLists([])).toEqual({ readFiles: [], modifiedFiles: [] });
  });
});

describe("formatFileAppendix", () => {
  it("与 Pi 同样的标签，空的一类不写", () => {
    expect(formatFileAppendix({ readFiles: [], modifiedFiles: ["b.ts"] })).toBe("<modified-files>\nb.ts\n</modified-files>");
    expect(formatFileAppendix({ readFiles: [], modifiedFiles: [] })).toBe("");
  });

  it("每类最多 40 条，多出的写 (n more)", () => {
    const files = Array.from({ length: 45 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const text = formatFileAppendix({ readFiles: files, modifiedFiles: [] });
    expect(text).toContain("f39.ts\n(5 more)\n</read-files>");
    expect(text).not.toContain("f40.ts");
  });
});

describe("buildStateCompaction", () => {
  it("摘要以正文开头、空一行接附录，切点与 tokensBefore 原样带回，details 存完整列表", () => {
    const files = Array.from({ length: 41 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const result = buildStateCompaction(
      "## Intent\n- x",
      { firstKeptEntryId: "k1", tokensBefore: 1234 },
      { readFiles: files, modifiedFiles: [] },
    );
    expect(result.summary.startsWith("## Intent\n- x\n\n<read-files>\n")).toBe(true);
    expect(result.firstKeptEntryId).toBe("k1");
    expect(result.tokensBefore).toBe(1234);
    expect(result.details).toEqual({ source: "session-state", readFiles: files, modifiedFiles: [] });
    expect(result.usage).toBeUndefined();
  });

  it("没有文件时摘要就是正文", () => {
    const result = buildStateCompaction("## Intent", { firstKeptEntryId: "k", tokensBefore: 1 }, { readFiles: [], modifiedFiles: [] });
    expect(result.summary).toBe("## Intent");
  });
});

describe("isStateCompaction", () => {
  it("只认本扩展写的 session-state 条目", () => {
    expect(isStateCompaction({ fromExtension: true, compactionEntry: { details: { source: "session-state" } } })).toBe(true);
    expect(isStateCompaction({ fromExtension: false, compactionEntry: { details: { source: "session-state" } } })).toBe(false);
    expect(isStateCompaction({ fromExtension: true, compactionEntry: { details: { readFiles: [] } } })).toBe(false);
    expect(isStateCompaction({ fromExtension: true })).toBe(false);
  });
});
