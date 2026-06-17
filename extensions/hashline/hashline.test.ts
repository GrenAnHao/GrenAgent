import { describe, expect, it } from "vitest";
import { applyOps } from "./apply.js";
import { parsePatch } from "./parser.js";
import { computeTag, renderRead } from "./snapshots.js";

describe("computeTag", () => {
  it("is 4 hex and changes with content", () => {
    const a = computeTag("/f.ts", "hello");
    expect(a).toMatch(/^[0-9a-f]{4}$/);
    expect(computeTag("/f.ts", "hello")).toBe(a);
    expect(computeTag("/f.ts", "hello!")).not.toBe(a);
  });
});

describe("renderRead", () => {
  it("renders [path#tag] header and numbered lines", () => {
    const tag = computeTag("/abs/a.ts", "x\ny");
    expect(renderRead("a.ts", "/abs/a.ts", "x\ny")).toBe(`[a.ts#${tag}]\n1:x\n2:y`);
  });
  it("windows with offset/limit and marks elision", () => {
    const out = renderRead("a.ts", "/abs/a.ts", "1\n2\n3\n4", { offset: 2, limit: 2 });
    expect(out).toContain("2:2");
    expect(out).toContain("3:3");
    expect(out).toContain("前 1 行省略");
    expect(out).toContain("后 1 行省略");
  });
});

describe("parsePatch", () => {
  it("parses swap/del/ins ops with body", () => {
    const r = parsePatch("[a.ts#abcd]\nSWAP 2.=3:\n+new\nDEL 5\nINS.POST 1:\n+after");
    expect(r.error).toBeUndefined();
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0]).toMatchObject({ path: "a.ts", tag: "abcd" });
    expect(r.sections[0].ops).toEqual([
      { kind: "swap", start: 2, end: 3, body: ["new"] },
      { kind: "del", start: 5, end: 5 },
      { kind: "insPost", line: 1, body: ["after"] },
    ]);
  });

  it("supports single-line SWAP N: shorthand", () => {
    const r = parsePatch("[a#a1]\nSWAP 4:\n+x");
    expect(r.sections[0].ops[0]).toEqual({ kind: "swap", start: 4, end: 4, body: ["x"] });
  });

  it("rejects .BLK, orphan body, unknown op, missing header, empty", () => {
    expect(parsePatch("[a#a1]\nSWAP.BLK 1:\n+x").error).toContain(".BLK");
    expect(parsePatch("[a#a1]\n+orphan").error).toContain("body");
    expect(parsePatch("[a#a1]\nFROB 1").error).toContain("无法识别");
    expect(parsePatch("SWAP 1.=1:\n+x").error).toContain("文件头之前");
    expect(parsePatch("nothing here").error).toBeDefined();
  });

  it("handles INS.HEAD and + escapes", () => {
    const r = parsePatch("[a#a1]\nINS.HEAD:\n+#head\n+\n++plus\n+-minus");
    expect(r.sections[0].ops[0]).toEqual({ kind: "insHead", body: ["#head", "", "+plus", "-minus"] });
  });
});

describe("applyOps", () => {
  const content = "L1\nL2\nL3\nL4";

  it("SWAP replaces an inclusive range", () => {
    expect(applyOps(content, [{ kind: "swap", start: 2, end: 3, body: ["X", "Y"] }]).content).toBe(
      "L1\nX\nY\nL4",
    );
  });
  it("DEL removes lines", () => {
    expect(applyOps(content, [{ kind: "del", start: 2, end: 3 }]).content).toBe("L1\nL4");
  });
  it("INS.PRE / INS.POST insert around a line", () => {
    expect(applyOps(content, [{ kind: "insPre", line: 1, body: ["A"] }]).content).toBe(
      "A\nL1\nL2\nL3\nL4",
    );
    expect(applyOps(content, [{ kind: "insPost", line: 4, body: ["Z"] }]).content).toBe(
      "L1\nL2\nL3\nL4\nZ",
    );
  });
  it("INS.HEAD / INS.TAIL", () => {
    expect(
      applyOps(content, [
        { kind: "insHead", body: ["H"] },
        { kind: "insTail", body: ["T"] },
      ]).content,
    ).toBe("H\nL1\nL2\nL3\nL4\nT");
  });
  it("combined ops anchor on original line numbers (no drift)", () => {
    const r = applyOps(content, [
      { kind: "swap", start: 2, end: 2, body: ["X", "X2"] },
      { kind: "del", start: 3, end: 3 },
      { kind: "insTail", body: ["END"] },
    ]);
    expect(r.content).toBe("L1\nX\nX2\nL4\nEND");
  });
  it("rejects overlap and out-of-range", () => {
    expect(
      applyOps(content, [
        { kind: "swap", start: 2, end: 3, body: [] },
        { kind: "del", start: 3, end: 3 },
      ]).error,
    ).toContain("重叠");
    expect(applyOps(content, [{ kind: "del", start: 5, end: 5 }]).error).toContain("越界");
  });
});

describe("parse → apply round trip", () => {
  it("applies a realistic multi-op patch", () => {
    const content = "def greet(name):\n    msg = 'Hello, ' + name\n    print(msg)\ngreet('world')";
    const r = parsePatch("[g.py#abcd]\nSWAP 2.=2:\n+    msg = f'Hi, {name}'\nDEL 3");
    expect(r.error).toBeUndefined();
    const out = applyOps(content, r.sections[0].ops);
    expect(out.content).toBe("def greet(name):\n    msg = f'Hi, {name}'\ngreet('world')");
  });
});
