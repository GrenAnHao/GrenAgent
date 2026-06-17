import { describe, expect, it } from "vitest";
import { parsePatch } from "./parser.js";
import { recover } from "./recovery.js";

// 用 parsePatch 造 ops（tag 随意，recover 不校验 tag）。
function ops(patchBody: string) {
  const r = parsePatch(`[f#0000]\n${patchBody}`);
  if (r.error) throw new Error(r.error);
  return r.sections[0].ops;
}

describe("recover (3-way merge)", () => {
  it("merges when unrelated lines changed", () => {
    const prev = "a\nb\nc\n";
    const cur = "HEADER\na\nb\nc\n"; // 开头插了一行无关内容
    const r = recover(prev, cur, ops("SWAP 2:\n+B")); // 改快照第 2 行 b → B
    expect(r.error).toBeUndefined();
    expect(r.content).toBe("HEADER\na\nB\nc\n");
  });

  it("fails when target line changed in current", () => {
    const prev = "a\nb\nc\n";
    const cur = "a\nXXX\nc\n"; // 目标行 b 已被改
    const r = recover(prev, cur, ops("SWAP 2:\n+B"));
    expect(r.content).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it("errors when patch makes no change to snapshot", () => {
    const prev = "a\nb\n";
    const r = recover(prev, "a\nb\n", ops("SWAP 1:\n+a")); // a→a 无变化
    expect(r.error).toBeTruthy();
  });
});
